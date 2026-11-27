import { parseFlexibleAmount, round2 } from './money.js';
import { fingerprint } from './fingerprint.js';
import { detectSantanderCuentaResumen } from './santander-card.js';
import { pdfToText } from './pdf-text.js';

/** dd/mm/yy or dd/mm/yyyy → YYYY-MM-DD */
function parseResumenDate(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  let y = Number(m[3]);
  if (m[3].length === 2) y += 2000;
  if (!Number.isFinite(y) || y < 2000 || y > 2100) return null;
  return `${y}-${mm}-${dd}`;
}

// NOTE: never reuse a /g RegExp across strings (lastIndex state drops matches).
const AMT_RE_SRC = String.raw`-?\s*\$\s*-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d{1,3}(?:\.\d{3})*,\d{2}`;

function firstAmount(line) {
  const matches = String(line).match(new RegExp(AMT_RE_SRC));
  if (!matches || !matches.length) return null;
  // Prefer first signed/$ amount (Caja de Ahorro column).
  return parseFlexibleAmount(matches[0].replace(/\s+/g, ''));
}

function isNoiseLine(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  if (/^Fecha\b/i.test(s) && /Movimiento/i.test(s)) return true;
  if (/^Movimientos en pesos/i.test(s)) return true;
  if (/^\d+\s*-\s*\d+\s*$/.test(s)) return true; // "1 - 17"
  if (/^--\s*\d+\s+of\s+\d+\s*--/i.test(s)) return true;
  if (/^Saldo total\b/i.test(s)) return true;
  return false;
}

/**
 * Parse "Movimientos en pesos" block from Santander cuenta resumen PDF text.
 * Stops before dólares / tax / product summary sections.
 */
export function parseSantanderCajaResumenText(text, { account_id = 'santander_caja' } = {}) {
  const full = String(text || '');
  const start = full.search(/Movimientos en pesos/i);
  if (start < 0) {
    throw Object.assign(new Error('santander_caja_resumen_no_movimientos'), {
      code: 'santander_caja_resumen_no_movimientos',
    });
  }
  const rest = full.slice(start);
  const endMatch = rest.search(
    /Movimientos en d[oó]lares|Detalle impositivo|Resumen de tus productos|Así usaste tu dinero/i,
  );
  const section = endMatch > 0 ? rest.slice(0, endMatch) : rest;

  const lines = section.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const txs = [];
  let sumPos = 0;
  let sumNeg = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isNoiseLine(line)) {
      i += 1;
      continue;
    }

    const dm = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(\d+))?\s+(.+)$/);
    if (!dm) {
      i += 1;
      continue;
    }

    const fecha = parseResumenDate(dm[1]);
    const ref = dm[2] ? String(dm[2]).trim() : '';
    let descParts = [String(dm[3] || '').trim()];
    i += 1;

    // Skip Saldo Inicial (opening balance, not a movement).
    if (/^Saldo Inicial\b/i.test(descParts[0])) {
      while (i < lines.length && !/^\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(lines[i]) && firstAmount(lines[i]) == null) {
        i += 1;
      }
      if (i < lines.length && firstAmount(lines[i]) != null) i += 1;
      continue;
    }

    // Continuation description lines until amount line or next date.
    while (i < lines.length) {
      const n = lines[i];
      if (isNoiseLine(n)) {
        i += 1;
        continue;
      }
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(n)) break;
      if (firstAmount(n) != null && /\$/.test(n)) break;
      // Same-line amount after short desc (impuestos).
      if (firstAmount(n) != null) break;
      descParts.push(n);
      i += 1;
    }

    // Amount may be on same first line (impuestos) or following line(s).
    let amount = firstAmount(descParts[0]);
    if (amount != null) {
      descParts[0] = descParts[0]
        .replace(new RegExp(AMT_RE_SRC, 'g'), '')
        .replace(/\$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    } else if (i < lines.length) {
      amount = firstAmount(lines[i]);
      if (amount != null) i += 1;
    }

    const descripcion = descParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!fecha || !descripcion || amount == null || amount === 0) continue;

    const fp = fingerprint([account_id, fecha, ref, amount, descripcion]);
    if (amount >= 0) sumPos += amount;
    else sumNeg += amount;
    txs.push({
      account_id,
      fingerprint: fp,
      fecha,
      descripcion,
      merchant: descripcion,
      tx_type: 'movimiento',
      amount,
      currency: 'ARS',
      amount_ars: amount,
      amount_usd: null,
      is_internal_transfer: false,
      is_excluded: false,
      double_count_guard: false,
      category_id: null,
      raw: {
        referencia: ref,
        source: 'santander_caja_resumen_pdf',
      },
    });
  }

  return {
    account_id,
    source_format: 'santander_caja_resumen_pdf',
    txs,
    summary: {
      count: txs.length,
      sum_credits: round2(sumPos),
      sum_debits: round2(sumNeg),
      balance_check_ok: null,
    },
    warnings: [],
  };
}

export async function parseSantanderCajaResumenPdf(buf, opts = {}) {
  const text = await pdfToText(buf);
  if (!detectSantanderCuentaResumen(text)) {
    throw Object.assign(new Error('santander_caja_resumen_not_detected'), {
      code: 'santander_caja_resumen_not_detected',
    });
  }
  return parseSantanderCajaResumenText(text, opts);
}
