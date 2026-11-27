import { parseArAmount, round2 } from './money.js';
import { fingerprint } from './fingerprint.js';
import { pdfToText } from './pdf-text.js';

const MONTHS = {
  ene: '01',
  feb: '02',
  mar: '03',
  abr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  ago: '08',
  sept: '09',
  sep: '09',
  oct: '10',
  nov: '11',
  dic: '12',
};

const DATE_RE = /^(\d{1,2})\s+de\s+(ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)\b/i;
const KIND_RE = /^(Consumo|Reembolso|Impuesto)\b/i;
const AMT_RE = /([‒–—−\-+]|)\s*(US\$|U\$S|\$)\s*([\d.]+,\d{2}|\d+,\d{2}|\d+)/;

function parseMpDate(line, yearHint) {
  const m = String(line).match(DATE_RE);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mon = m[2].toLowerCase();
  const mm = MONTHS[mon] || MONTHS[mon.replace(/sept/, 'sept')];
  if (!mm) return null;
  const year = yearHint || new Date().getFullYear();
  return `${year}-${mm}-${dd}`;
}

function extractAmt(line) {
  const m = String(line).match(AMT_RE);
  if (!m) return null;
  const signChar = m[1];
  const currency = /US\$|U\$S/i.test(m[2]) ? 'USD' : 'ARS';
  let amount = parseArAmount(m[3]);
  if (amount == null) return null;
  if (signChar && /[‒–—−\-]/.test(signChar)) amount = -Math.abs(amount);
  return { amount: Math.abs(amount), currency, raw: m[0] };
}

function inferYearAndClose(text, yearHint, monthHint) {
  const close = String(text).match(
    /Cierra el\s+(\d{1,2})\/(ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)/i,
  );
  const year = yearHint || new Date().getFullYear();
  if (close) {
    const mm = MONTHS[close[2].toLowerCase()];
    const dd = String(close[1]).padStart(2, '0');
    if (mm) return { year, defaultFecha: `${year}-${mm}-${dd}` };
  }
  if (monthHint >= 1 && monthHint <= 12) {
    const mm = String(monthHint).padStart(2, '0');
    return { year, defaultFecha: `${year}-${mm}-01` };
  }
  return { year, defaultFecha: `${year}-01-01` };
}

/**
 * Parse Mercado Pago card print-to-PDF (fragile web layout).
 * One transaction per (merchant+amount, kind) pair — never emit summary totals
 * that lack a following Consumo/Reembolso/Impuesto line.
 */
export function parseMpCardText(text, { account_id = 'mp_card', yearHint, monthHint } = {}) {
  const lines = String(text)
    .split(/\n/)
    .map((l) => l.replace(/\t/g, ' ').trim())
    .filter(Boolean);
  const warnings = ['mp_card_print_pdf_fragile'];
  const { year, defaultFecha } = inferYearAndClose(text, yearHint, monthHint);

  const txs = [];
  let sumArs = 0;
  let sumUsd = 0;
  let currentDate = defaultFecha;
  let dateIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const d = parseMpDate(line, year);
    if (d) {
      currentDate = d;
      dateIdx += 1;
      continue;
    }
    if (KIND_RE.test(line)) continue;

    const amt = extractAmt(line);
    if (!amt) continue;

    // Require explicit kind on the next line — skips statement/section totals.
    const kindLine = lines[i + 1] || '';
    const kindMatch = kindLine.match(KIND_RE);
    if (!kindMatch) continue;
    const kind = kindMatch[1];

    let merchant = line.replace(AMT_RE, '').replace(/[]/g, '').trim();
    if (!merchant) merchant = kind;

    let signed = -Math.abs(amt.amount);
    if (/Reembolso/i.test(kind)) signed = Math.abs(amt.amount);

    const fp = fingerprint([account_id, currentDate, merchant, signed, amt.currency, kind, i]);
    const tx = {
      account_id,
      fingerprint: fp,
      fecha: currentDate,
      descripcion: `${kind}: ${merchant}`,
      merchant,
      tx_type: kind.toLowerCase(),
      amount: signed,
      currency: amt.currency,
      amount_ars: amt.currency === 'ARS' ? signed : null,
      amount_usd: amt.currency === 'USD' ? signed : null,
      is_internal_transfer: false,
      is_excluded: false,
      double_count_guard: false,
      category_id: null,
      raw: { kind, date_index: dateIdx, line: i },
    };
    if (amt.currency === 'ARS') sumArs += signed;
    else sumUsd += signed;
    txs.push(tx);
  }

  if (txs.length < 3) warnings.push('mp_card_few_rows');

  return {
    account_id,
    source_format: 'mp_card_pdf',
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

export async function parseMpCardPdf(buf, opts) {
  const text = await pdfToText(buf);
  return parseMpCardText(text, opts);
}

/** Strict MP card print-PDF detection — must NOT match Santander summaries. */
export function detectMpCardPdf(text) {
  const t = String(text || '');
  if (/Visa\s*N|American Express|\bAmex\b|Merpago\*/i.test(t)) return false;
  if (/Santander|Caja de Ahorro|Cuenta única/i.test(t) && !/Cierra el/i.test(t)) return false;
  const hasKind = /\n\s*Consumo\s*\n/i.test(`\n${t}\n`) || /\n\s*Reembolso\s*\n/i.test(`\n${t}\n`);
  const hasMpDate = /\d{1,2}\s+de\s+(ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)\b/i.test(t);
  const hasClose = /Cierra el\s+\d{1,2}\//i.test(t);
  return hasKind && hasMpDate && (hasClose || /Mercado\s*Pago|MercadoPago/i.test(t));
}
