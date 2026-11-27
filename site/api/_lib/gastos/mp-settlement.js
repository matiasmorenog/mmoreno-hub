/**
 * Mercado Pago settlement_v2 CSV.
 * Join key: SOURCE_ID = account_statement REFERENCE_ID.
 * TRANSACTION_DATE is ISO with offset (e.g. 2026-11-27T02:03:36.000-03:00).
 */

export function detectMpSettlement(text) {
  const t = String(text || '');
  return (
    t.includes('SOURCE_ID') &&
    t.includes('TRANSACTION_DATE') &&
    (t.includes('SETTLEMENT_DATE') || t.includes('MONEY_RELEASE_DATE'))
  );
}

function parseIsoTs(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Hour 0–23 in America/Argentina/Buenos_Aires for a Date. */
export function hourInBuenosAires(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isFinite(h) ? h : null;
}

/**
 * @returns {Map<string, { posted_at: Date, hora_local: number|null, transaction_date_raw: string }>}
 */
export function parseMpSettlement(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return new Map();
  const hdr = lines[0].split(';').map((h) => h.trim());
  const iSource = hdr.indexOf('SOURCE_ID');
  const iDate = hdr.indexOf('TRANSACTION_DATE');
  if (iSource < 0 || iDate < 0) {
    throw Object.assign(new Error('mp_settlement_missing_header'), { code: 'mp_settlement_missing_header' });
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    const sourceId = (parts[iSource] || '').trim();
    if (!sourceId) continue;
    const raw = (parts[iDate] || '').trim();
    const posted_at = parseIsoTs(raw);
    if (!posted_at) continue;
    map.set(sourceId, {
      posted_at,
      hora_local: hourInBuenosAires(posted_at),
      transaction_date_raw: raw,
    });
  }
  return map;
}

/** Attach settlement times onto account_statement txs (mutates copies). */
export function joinSettlementTimes(txs, settlementMap) {
  if (!settlementMap || !settlementMap.size) {
    return { txs, joined: 0 };
  }
  let joined = 0;
  const out = txs.map((tx) => {
    const ref = tx.raw?.reference_id || null;
    if (!ref || !settlementMap.has(ref)) return { ...tx };
    const s = settlementMap.get(ref);
    joined += 1;
    return {
      ...tx,
      posted_at: s.posted_at.toISOString(),
      hora_local: s.hora_local,
      raw: {
        ...(tx.raw || {}),
        hora_local: s.hora_local,
        settlement_transaction_date: s.transaction_date_raw,
        settlement_joined: true,
      },
    };
  });
  return { txs: out, joined };
}
