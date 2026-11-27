import { parseArAmount, round2 } from './money.js';
import { fingerprint } from './fingerprint.js';
import { pdfToText } from './pdf-text.js';

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(.*))?$/;
const AMT_RE = /(?:U\$S|US\$|\$)\s*([\d.]+,\d{2}|[\d]+,\d{2}|\d+(?:\.\d{3})*,\d{2})$/;
const COMPROBANTE_RE = /\b(\d{6,})\b/;

function toIsoDate(dd, mm, yy) {
  let year = Number(yy);
  if (year < 100) year += 2000;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function extractAmount(line) {
  const m = String(line).match(AMT_RE);
  if (!m) return null;
  const currency = /U\$S|US\$/i.test(line) ? 'USD' : 'ARS';
  const amount = parseArAmount(m[1]);
  if (amount == null) return null;
  // Card statements: charges positive in file; we store spend as negative for expenses consistency with MP wallet
  // Keep statement sign as printed (usually positive charges). Caller can treat >0 as spend for cards.
  return { amount, currency, raw: m[0] };
}

/**
 * Parse Santander Visa/Amex resumen PDF text into transactions.
 * Lines often look like:
 *   DD/MM/YY Merchant [cuota] [comprobante] $ 1.234,56
 * or split across lines (merchant / comprobante / amount).
 */
export function parseSantanderCardText(text, { account_id, source_format }) {
  const lines = String(text)
    .split(/\n/)
    .map((l) => l.replace(/\t/g, ' ').trim())
    .filter(Boolean);
  const warnings = ['pdf_layout_best_effort'];
  const txs = [];
  let sumArs = 0;
  let sumUsd = 0;

  // Skip until detalle-ish section if present
  let start = lines.findIndex((l) => /Cuota|consumos|Detalle|en el pa[ií]s|en el exterior/i.test(l));
  if (start < 0) start = 0;

  let pending = null;
  const flushPending = () => {
    if (!pending || pending.amount == null) {
      pending = null;
      return;
    }
    const desc = pending.descripcion || pending.merchant || '';
    const isMerpago = /merpago/i.test(desc);
    const amount = pending.currency === 'USD' ? pending.amount : pending.amount;
    // Card charges: store as negative spend in ARS/USD field for unified resumen (expense = abs of negatives + card positives flipped)
    const signed = -Math.abs(amount);
    const fp = fingerprint([
      account_id,
      pending.fecha,
      pending.comprobante || '',
      signed,
      desc,
      pending.currency,
    ]);
    const tx = {
      account_id,
      fingerprint: fp,
      fecha: pending.fecha,
      descripcion: desc,
      merchant: pending.merchant || desc,
      tx_type: 'consumo_tarjeta',
      amount: signed,
      currency: pending.currency,
      amount_ars: pending.currency === 'ARS' ? signed : null,
      amount_usd: pending.currency === 'USD' ? signed : null,
      is_internal_transfer: false,
      is_excluded: account_id === 'santander_amex' && isMerpago,
      double_count_guard: account_id === 'santander_amex' && isMerpago,
      category_id: null,
      raw: { comprobante: pending.comprobante || null, cuota: pending.cuota || null },
    };
    if (pending.currency === 'ARS') sumArs += signed;
    else sumUsd += signed;
    txs.push(tx);
    pending = null;
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(line)) continue;
    if (/TOTAL|Plan V:|TNA:|TEA:|CUIT:|RESUMEN/i.test(line) && !DATE_RE.test(line)) {
      flushPending();
      continue;
    }

    const dm = line.match(DATE_RE);
    if (dm) {
      flushPending();
      const fecha = toIsoDate(dm[1], dm[2], dm[3]);
      const rest = (dm[4] || '').trim();
      const amt = extractAmount(rest);
      const comp = (rest.match(COMPROBANTE_RE) || [])[1] || null;
      let desc = rest;
      if (amt) desc = rest.slice(0, rest.lastIndexOf(amt.raw)).trim();
      if (comp) desc = desc.replace(comp, '').trim();
      desc = desc.replace(/\s+/g, ' ').trim();
      pending = {
        fecha,
        descripcion: desc,
        merchant: desc.split(/\s+/)[0] ? desc : null,
        comprobante: comp,
        cuota: null,
        amount: amt?.amount ?? null,
        currency: amt?.currency ?? 'ARS',
      };
      if (amt) flushPending();
      continue;
    }

    if (pending && pending.amount == null) {
      const amt = extractAmount(line);
      if (amt) {
        pending.amount = amt.amount;
        pending.currency = amt.currency;
        flushPending();
        continue;
      }
      // continuation: merchant / comprobante line
      const comp = (line.match(COMPROBANTE_RE) || [])[1];
      if (comp && !pending.comprobante) pending.comprobante = comp;
      if (!/^\d+$/.test(line) && !amt) {
        const extra = line.replace(COMPROBANTE_RE, '').trim();
        if (extra) {
          pending.descripcion = `${pending.descripcion || ''} ${extra}`.trim();
          pending.merchant = pending.descripcion;
        }
      }
      continue;
    }

    // Continuation lines that look like Merpago* without date (same day as previous)
    if (/merpago/i.test(line) && !pending) {
      const last = txs[txs.length - 1];
      const amt = extractAmount(line);
      if (last && amt) {
        pending = {
          fecha: last.fecha,
          descripcion: line.replace(AMT_RE, '').replace(COMPROBANTE_RE, '').trim(),
          merchant: line.split(/\s+/)[0],
          comprobante: (line.match(COMPROBANTE_RE) || [])[1] || null,
          cuota: null,
          amount: amt.amount,
          currency: amt.currency,
        };
        flushPending();
      }
    }
  }
  flushPending();

  return {
    account_id,
    source_format,
    txs,
    summary: {
      count: txs.length,
      sum_ars: round2(sumArs),
      sum_usd: round2(sumUsd),
      balance_check_ok: null,
    },
    warnings,
  };
}

export async function parseSantanderVisaPdf(buf) {
  const text = await pdfToText(buf);
  return parseSantanderCardText(text, {
    account_id: 'santander_visa',
    source_format: 'santander_visa_pdf',
  });
}

export async function parseSantanderAmexPdf(buf) {
  const text = await pdfToText(buf);
  return parseSantanderCardText(text, {
    account_id: 'santander_amex',
    source_format: 'santander_amex_pdf',
  });
}

export function detectSantanderCardKind(text) {
  const t = String(text || '');
  if (/American Express|Amex/i.test(t) || /Merpago\*/i.test(t)) return 'santander_amex';
  if (/Visa/i.test(t)) return 'santander_visa';
  return null;
}
