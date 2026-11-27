import { parseArAmount, round2 } from './money.js';
import { fingerprint } from './fingerprint.js';

const HDR = 'RELEASE_DATE;TRANSACTION_TYPE;REFERENCE_ID;TRANSACTION_NET_AMOUNT;PARTIAL_BALANCE';

const TYPE_RULES = [
  [/^Devoluci[oó]n de transferencia enviada\s*(.*)$/iu, 'devolucion_transferencia', 1],
  [/^Transferencia enviada\s*(.*)$/iu, 'transferencia_enviada', 1],
  [/^Transferencia recibida\s*(.*)$/iu, 'transferencia_recibida', 1],
  [/^Pago con QR\s*(.*)$/iu, 'pago_qr', 1],
  [/^Pago autom[aá]tico\s*(.*)$/iu, 'pago_automatico', 1],
  [/^Pago de suscripci[oó]n\s*(.*)$/iu, 'suscripcion', 1],
  [/^Pago\s+(.*)$/iu, 'pago', 1],
  [/^Rendimientos\s*(.*)$/iu, 'rendimientos', 1],
  [/^Reembolso\s*(.*)$/iu, 'reembolso', 1],
];

export function detectMpAccountStatement(text) {
  const t = String(text || '');
  return t.includes('RELEASE_DATE') && t.includes('TRANSACTION_TYPE') && t.includes('REFERENCE_ID');
}

function parseType(raw) {
  const s = String(raw || '').trim();
  for (const [re, type, g] of TYPE_RULES) {
    const m = s.match(re);
    if (m) return { tx_type: type, merchant: (m[g] || '').trim() || null };
  }
  return { tx_type: 'otro', merchant: s || null };
}

function parseDate(ddmmyyyy) {
  const m = String(ddmmyyyy).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Parse Mercado Pago account_statement CSV (;, decimal ,, date DD-MM-YYYY).
 * @returns {{ account_id, source_format, txs, summary, warnings }}
 */
export function parseMpAccountStatement(text, { account_id = 'mp_wallet' } = {}) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length);
  const warnings = [];
  let summaryBlock = null;
  if (lines[0] && lines[0].startsWith('INITIAL_BALANCE')) {
    const vals = (lines[1] || '').split(';');
    summaryBlock = {
      initial_balance: parseArAmount(vals[0]),
      credits: parseArAmount(vals[1]),
      debits: parseArAmount(vals[2]),
      final_balance: parseArAmount(vals[3]),
    };
  }
  const hdrIdx = lines.findIndex((l) => l.replace(/\s/g, '').startsWith('RELEASE_DATE;TRANSACTION_TYPE'));
  if (hdrIdx < 0) throw new Error('mp_account_missing_header');
  if (!lines[hdrIdx].includes('REFERENCE_ID')) warnings.push('header_unexpected');

  const txs = [];
  let sumPos = 0;
  let sumNeg = 0;
  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    if (parts.length < 4) continue;
    const fecha = parseDate(parts[0]);
    if (!fecha) continue;
    const amount = parseArAmount(parts[3]);
    if (amount == null) continue;
    const ref = (parts[2] || '').trim();
    const { tx_type, merchant } = parseType(parts[1]);
    const descripcion = String(parts[1] || '').trim();
    const fp = fingerprint([account_id, ref || '', fecha, amount, descripcion]);
    if (amount >= 0) sumPos += amount;
    else sumNeg += amount;
    const isOwn =
      /transferencia/i.test(tx_type) && /moreno\s+matias/i.test(`${merchant || ''} ${descripcion}`);
    txs.push({
      account_id,
      fingerprint: fp,
      fecha,
      descripcion,
      merchant,
      tx_type,
      amount,
      currency: 'ARS',
      amount_ars: amount,
      amount_usd: null,
      is_internal_transfer: isOwn,
      is_excluded: isOwn,
      double_count_guard: false,
      category_id: isOwn ? 'transferencias' : null,
      raw: { reference_id: ref, partial_balance: parseArAmount(parts[4]) },
    });
  }

  const summary = {
    count: txs.length,
    sum_credits: round2(sumPos),
    sum_debits: round2(sumNeg),
    file_credits: summaryBlock?.credits ?? null,
    file_debits: summaryBlock?.debits ?? null,
    balance_check_ok: null,
  };
  if (summaryBlock?.credits != null && summaryBlock?.debits != null) {
    const ok =
      Math.abs(summary.sum_credits - summaryBlock.credits) < 0.05 &&
      Math.abs(summary.sum_debits - summaryBlock.debits) < 0.05;
    summary.balance_check_ok = ok;
    if (!ok) warnings.push('summary_mismatch');
  }

  return {
    account_id,
    source_format: 'mp_account_statement',
    txs,
    summary,
    warnings,
  };
}

export const MP_ACCOUNT_HDR = HDR;
