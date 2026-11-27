import { parseArAmount, round2 } from './money.js';
import { fingerprint } from './fingerprint.js';
import { pdfToText } from './pdf-text.js';

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(.*))?$/;
const AMT_RE = /(?:U\$S|US\$|\$)\s*(-?[\d.]+,\d{2})$/;
const COMPROBANTE_RE = /\b(\d{6,})\b/;
const SKIP_LINE =
  /TOTAL|Plan V:|TNA:|TEA:|CUIT:|RESUMEN|Su pago|pago m[ií]nimo|Saldo anterior|Saldo actual|Limite|Fecha de venc|En pesos|En d[oó]lares|^--\s*\d+\s+of/i;

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
  return { amount, currency, raw: m[0] };
}

function cleanDesc(raw) {
  return String(raw || '')
    .replace(AMT_RE, '')
    .replace(COMPROBANTE_RE, '')
    .replace(/\b\d{1,3}\/\d{1,3}\b/g, '') // cuota markers like 01/03
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse Santander Visa/Amex resumen PDF text into ONE transaction per movement.
 * Skips header/summary amounts; never collapses a whole statement into one row.
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

  // Prefer detalle de consumos section when present.
  let start = lines.findIndex((l) =>
    /Detalle|Cuota.*Pesos|consumos en el|Movimientos|Fecha\s+Descripci/i.test(l),
  );
  if (start < 0) start = 0;

  let pending = null;
  const flushPending = () => {
    if (!pending || pending.amount == null) {
      pending = null;
      return;
    }
    const desc = cleanDesc(pending.descripcion || pending.merchant || '');
    // Skip empty / pure-total rows
    if (!desc || /^(pesos|dolares|u\$s|usd|ars)$/i.test(desc)) {
      pending = null;
      return;
    }
    const isMerpago = /merpago/i.test(desc);
    const signed = -Math.abs(pending.amount);
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
      merchant: desc,
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
    if (SKIP_LINE.test(line) && !DATE_RE.test(line)) {
      flushPending();
      continue;
    }

    const dm = line.match(DATE_RE);
    if (dm) {
      flushPending();
      const fecha = toIsoDate(dm[1], dm[2], dm[3]);
      const rest = (dm[4] || '').trim();
      // Bare date with no merchant text — often calendar/header; wait for continuation.
      const amt = extractAmount(rest);
      const comp = (rest.match(COMPROBANTE_RE) || [])[1] || null;
      let desc = cleanDesc(rest);
      pending = {
        fecha,
        descripcion: desc,
        merchant: desc || null,
        comprobante: comp,
        cuota: null,
        amount: amt?.amount ?? null,
        currency: amt?.currency ?? 'ARS',
      };
      // Only flush if we have both merchant text and amount on this line.
      if (amt && desc) flushPending();
      else if (amt && !desc) {
        // Amount-only dated line = likely summary payment — drop.
        pending = null;
      }
      continue;
    }

    if (pending && pending.amount == null) {
      const amt = extractAmount(line);
      if (amt) {
        // If pending still has no merchant, try previous bare date + this amount only if line has text.
        const extra = cleanDesc(line);
        if (extra) {
          pending.descripcion = `${pending.descripcion || ''} ${extra}`.trim();
          pending.merchant = pending.descripcion;
        }
        if (!pending.descripcion) {
          pending = null;
          continue;
        }
        pending.amount = amt.amount;
        pending.currency = amt.currency;
        flushPending();
        continue;
      }
      const comp = (line.match(COMPROBANTE_RE) || [])[1];
      if (comp && !pending.comprobante) pending.comprobante = comp;
      const extra = cleanDesc(line);
      if (extra) {
        pending.descripcion = `${pending.descripcion || ''} ${extra}`.trim();
        pending.merchant = pending.descripcion;
      }
      continue;
    }

    // Merpago* continuation without date (same day as previous movement).
    if (/merpago/i.test(line) && !pending) {
      const last = txs[txs.length - 1];
      const amt = extractAmount(line);
      const desc = cleanDesc(line);
      if (last && (amt || desc)) {
        if (amt && desc) {
          pending = {
            fecha: last.fecha,
            descripcion: desc,
            merchant: desc,
            comprobante: (line.match(COMPROBANTE_RE) || [])[1] || null,
            cuota: null,
            amount: amt.amount,
            currency: amt.currency,
          };
          flushPending();
        } else if (!amt && desc) {
          pending = {
            fecha: last.fecha,
            descripcion: desc,
            merchant: desc,
            comprobante: (line.match(COMPROBANTE_RE) || [])[1] || null,
            cuota: null,
            amount: null,
            currency: 'ARS',
          };
        }
      }
    }
  }
  flushPending();

  if (txs.length < 1) warnings.push('santander_card_no_rows');

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
  // Bank cuenta resumen is NOT a card statement.
  if (/resumen de cuenta|Caja de Ahorro|Cuenta única/i.test(t) && !/Visa\s*N|American Express/i.test(t)) {
    return null;
  }
  if (/American Express|\bAmex\b/i.test(t) || /Merpago\*/i.test(t)) return 'santander_amex';
  if (/Visa\s*N|\bVisa\b/i.test(t)) return 'santander_visa';
  return null;
}

export function detectSantanderCuentaResumen(text) {
  const t = String(text || '');
  const looksCuenta =
    /resumen de cuenta|Caja de Ahorro|Cuenta única|Transferencia\s+(CVU|a\b)|Debin|acreditaci/i.test(t);
  const looksCardHeader = /Visa\s*N[°ºo]|American Express\s*N/i.test(t);
  return looksCuenta && !looksCardHeader;
}
