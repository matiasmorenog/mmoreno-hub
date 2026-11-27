import XLSX from 'xlsx';
import { parseFlexibleAmount, round2 } from './money.js';
import { fingerprint } from './fingerprint.js';

function parseDate(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

export function detectSantanderCajaXlsx(buf) {
  try {
    const wb = XLSX.read(buf, { type: Buffer.isBuffer(buf) ? 'buffer' : 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    return rows.some(
      (r) =>
        Array.isArray(r) &&
        r.some((c) => /Descripci[oó]n/i.test(String(c))) &&
        r.some((c) => String(c).toLowerCase() === 'fecha') &&
        r.some((c) => /Caja de Ahorro|Cuenta Corriente/i.test(String(c))),
    );
  } catch {
    return false;
  }
}

/**
 * Parse Santander caja "Últimos movimientos" XLSX.
 */
export function parseSantanderCajaXlsx(buf, { account_id = 'santander_caja' } = {}) {
  const wb = XLSX.read(buf, { type: Buffer.isBuffer(buf) ? 'buffer' : 'array' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    defval: '',
    raw: false,
  });
  let hdrIdx = -1;
  let cols = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map((c) => String(c).trim());
    const fecha = r.findIndex((c) => c.toLowerCase() === 'fecha');
    const desc = r.findIndex((c) => /Descripci[oó]n/i.test(c));
    if (fecha >= 0 && desc >= 0) {
      hdrIdx = i;
      cols = {
        fecha,
        sucursal: r.findIndex((c) => /Sucursal/i.test(c)),
        desc,
        ref: r.findIndex((c) => /Referencia/i.test(c)),
        caja: r.findIndex((c) => /Caja de Ahorro/i.test(c)),
        cc: r.findIndex((c) => /Cuenta Corriente/i.test(c)),
        saldo: r.findIndex((c) => /^Saldo$/i.test(c)),
      };
      break;
    }
  }
  if (hdrIdx < 0) throw new Error('santander_caja_missing_header');

  const txs = [];
  let sumPos = 0;
  let sumNeg = 0;
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const fecha = parseDate(r[cols.fecha]);
    if (!fecha) continue;
    const descripcion = String(r[cols.desc] || '').trim();
    if (!descripcion) continue;
    const ref = cols.ref >= 0 ? String(r[cols.ref] || '').trim() : '';
    const aCaja = cols.caja >= 0 ? parseFlexibleAmount(r[cols.caja]) : null;
    const aCc = cols.cc >= 0 ? parseFlexibleAmount(r[cols.cc]) : null;
    let amount = null;
    if (aCaja != null && aCaja !== 0) amount = aCaja;
    else if (aCc != null && aCc !== 0) amount = aCc;
    else if (aCaja != null) amount = aCaja;
    else if (aCc != null) amount = aCc;
    if (amount == null) continue;

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
        sucursal: cols.sucursal >= 0 ? String(r[cols.sucursal] || '') : '',
        saldo: cols.saldo >= 0 ? parseFlexibleAmount(r[cols.saldo]) : null,
      },
    });
  }

  return {
    account_id,
    source_format: 'santander_caja_xlsx',
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
