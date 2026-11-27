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
  const mm = MONTHS[m[2].toLowerCase().replace(/^sep$/, 'sep')] || MONTHS[m[2].toLowerCase()];
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
  // Special unicode minus / dash before amount often means charge; plus/refund handled by kind
  if (signChar && /[‒–—−\-]/.test(signChar)) amount = -Math.abs(amount);
  return { amount: Math.abs(amount), currency, raw: m[0] };
}

/**
 * Parse Mercado Pago card print-to-PDF (fragile web layout).
 * Structure (approx): date lines, then pairs of (merchant+amount, kind).
 */
export function parseMpCardText(text, { account_id = 'mp_card', yearHint } = {}) {
  const lines = String(text)
    .split(/\n/)
    .map((l) => l.replace(/\t/g, ' ').trim())
    .filter(Boolean);
  const warnings = ['mp_card_print_pdf_fragile'];

  // Infer year from "Cierra el DD/mon"
  let year = yearHint;
  const close = text.match(/Cierra el\s+(\d{1,2})\/(ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)/i);
  if (!year && close) {
    // assume current calendar year of file context; fall back to now
    year = new Date().getFullYear();
  }
  year = year || new Date().getFullYear();

  const dates = [];
  for (const line of lines) {
    const d = parseMpDate(line, year);
    if (d) dates.push(d);
  }

  const txs = [];
  let sumArs = 0;
  let sumUsd = 0;
  let dateIdx = 0;
  let currentDate = dates[0] || `${year}-01-01`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const d = parseMpDate(line, year);
    if (d) {
      currentDate = d;
      dateIdx = dates.indexOf(d);
      continue;
    }
    if (KIND_RE.test(line)) continue;
    const amt = extractAmt(line);
    if (!amt) continue;
    const kindLine = lines[i + 1] && KIND_RE.test(lines[i + 1]) ? lines[i + 1] : '';
    const kind = (kindLine.match(KIND_RE) || [])[1] || 'Consumo';
    let merchant = line.replace(AMT_RE, '').replace(/[]/g, '').trim();
    if (!merchant) merchant = kind;

    let signed = -Math.abs(amt.amount);
    if (/Reembolso/i.test(kind)) signed = Math.abs(amt.amount);

    const fp = fingerprint([account_id, currentDate, merchant, signed, amt.currency, kind]);
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
      raw: { kind, date_index: dateIdx },
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

export function detectMpCardPdf(text) {
  const t = String(text || '');
  return /Consumo/i.test(t) && /Reembolso|Impuesto/i.test(t) && /\d{1,2}\s+de\s+(ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)/i.test(t);
}
