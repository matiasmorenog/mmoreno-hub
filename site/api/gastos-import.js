import { db, guard, body } from './_lib.js';
import { parseExpenseFile } from './_lib/gastos/parse.js';
import { newId } from './_lib/gastos/fingerprint.js';
import { detectMpSettlement, parseMpSettlement } from './_lib/gastos/mp-settlement.js';
import { CAT_UBER_DIDI } from './_lib/gastos/rules.js';

export const config = {
  api: { bodyParser: { sizeLimit: '6mb' } },
};

async function loadRules(sql) {
  return sql`
    SELECT id, pattern, category_id, account_id, priority, exclude_expense, activo
    FROM category_rules
    WHERE activo = true
    ORDER BY priority ASC, id ASC`;
}

function previewTx(t) {
  return {
    fingerprint: t.fingerprint,
    fecha: t.fecha,
    posted_at: t.posted_at || null,
    hora_local: t.hora_local ?? null,
    descripcion: t.descripcion,
    merchant: t.merchant,
    tx_type: t.tx_type,
    amount: t.amount,
    currency: t.currency,
    amount_ars: t.amount_ars,
    amount_usd: t.amount_usd,
    category_id: t.category_id,
    is_internal_transfer: !!t.is_internal_transfer,
    is_excluded: !!t.is_excluded,
    double_count_guard: !!t.double_count_guard,
  };
}

function decodeB64(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > 3.5 * 1024 * 1024) return null;
    return buf;
  } catch {
    return null;
  }
}

async function upsertTx(sql, importId, t, overrides) {
  const o = overrides.get(t.fingerprint) || {};
  const category_id = o.category_id !== undefined ? o.category_id : t.category_id;
  const is_excluded = o.is_excluded !== undefined ? !!o.is_excluded : !!t.is_excluded;
  const is_internal_transfer =
    o.is_internal_transfer !== undefined ? !!o.is_internal_transfer : !!t.is_internal_transfer;
  const id = newId('tx');
  const posted_at = t.posted_at || null;
  const hora_local = t.hora_local ?? null;
  const rows = await sql`
    INSERT INTO transactions (
      id, account_id, import_id, fingerprint, fecha, posted_at, hora_local,
      descripcion, merchant, tx_type,
      amount, currency, amount_ars, amount_usd, category_id,
      is_internal_transfer, is_excluded, double_count_guard, raw
    ) VALUES (
      ${id},
      ${t.account_id},
      ${importId},
      ${t.fingerprint},
      ${t.fecha},
      ${posted_at},
      ${hora_local},
      ${t.descripcion},
      ${t.merchant},
      ${t.tx_type},
      ${t.amount},
      ${t.currency},
      ${t.amount_ars},
      ${t.amount_usd},
      ${category_id},
      ${is_internal_transfer},
      ${is_excluded},
      ${!!t.double_count_guard},
      ${JSON.stringify(t.raw || {})}::jsonb
    )
    ON CONFLICT (account_id, fingerprint) DO UPDATE SET
      import_id = EXCLUDED.import_id,
      fecha = EXCLUDED.fecha,
      posted_at = COALESCE(EXCLUDED.posted_at, transactions.posted_at),
      hora_local = COALESCE(EXCLUDED.hora_local, transactions.hora_local),
      descripcion = EXCLUDED.descripcion,
      merchant = EXCLUDED.merchant,
      tx_type = EXCLUDED.tx_type,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      amount_ars = EXCLUDED.amount_ars,
      amount_usd = EXCLUDED.amount_usd,
      category_id = COALESCE(EXCLUDED.category_id, transactions.category_id),
      is_internal_transfer = EXCLUDED.is_internal_transfer,
      is_excluded = EXCLUDED.is_excluded,
      double_count_guard = EXCLUDED.double_count_guard,
      raw = EXCLUDED.raw || transactions.raw,
      actualizado = now()
    RETURNING id`;
  return rows.length;
}

/** Enrich existing MP wallet txs from settlement_v2 (SOURCE_ID = raw.reference_id). */
async function enrichFromSettlement(sql, settlementText) {
  if (!detectMpSettlement(settlementText)) {
    return { error: 'mp_settlement_invalid' };
  }
  const map = parseMpSettlement(settlementText);
  let timed = 0;
  let reclassified = 0;
  for (const [sourceId, s] of map) {
    const postedIso = s.posted_at.toISOString();
    const hora = s.hora_local;
    const rows = await sql`
      UPDATE transactions SET
        posted_at = ${postedIso}::timestamptz,
        hora_local = ${hora},
        raw = raw || ${JSON.stringify({
          hora_local: hora,
          settlement_transaction_date: s.transaction_date_raw,
          settlement_joined: true,
        })}::jsonb,
        actualizado = now()
      WHERE account_id = 'mp_wallet'
        AND (raw->>'reference_id') = ${sourceId}
      RETURNING id, tx_type, category_id, merchant, descripcion`;
    if (!rows.length) continue;
    timed += rows.length;
    for (const row of rows) {
      const hay = `${row.merchant || ''} ${row.descripcion || ''}`.toLowerCase();
      const isRecibida = row.tx_type === 'transferencia_recibida';
      const isDlocal = /dlocal/i.test(hay);
      const isNight = hora != null && hora >= 0 && hora < 8;
      const wantUber = isRecibida && (isDlocal || isNight);
      if (!wantUber) continue;
      if (row.category_id && row.category_id !== CAT_UBER_DIDI) continue;
      if (row.category_id === CAT_UBER_DIDI) continue;
      const upd = await sql`
        UPDATE transactions SET
          category_id = ${CAT_UBER_DIDI},
          actualizado = now()
        WHERE id = ${row.id} AND category_id IS NULL
        RETURNING id`;
      if (upd.length) reclassified += 1;
    }
  }
  // Also: night already timed previously but category still null
  const nightBackfill = await sql`
    UPDATE transactions SET
      category_id = ${CAT_UBER_DIDI},
      actualizado = now()
    WHERE account_id = 'mp_wallet'
      AND tx_type = 'transferencia_recibida'
      AND category_id IS NULL
      AND hora_local IS NOT NULL
      AND hora_local >= 0 AND hora_local < 8
    RETURNING id`;
  reclassified += nightBackfill.length;

  const dlocalBackfill = await sql`
    UPDATE transactions SET
      category_id = ${CAT_UBER_DIDI},
      actualizado = now()
    WHERE account_id = 'mp_wallet'
      AND tx_type = 'transferencia_recibida'
      AND category_id IS NULL
      AND (merchant ILIKE '%DLOCAL%' OR descripcion ILIKE '%DLOCAL%')
    RETURNING id`;
  reclassified += dlocalBackfill.length;

  return {
    settlement_map_size: map.size,
    timed,
    reclassified,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();

  const b = body(req);
  const action = b.action === 'confirm'
    ? 'confirm'
    : b.action === 'enrich_settlement'
      ? 'enrich_settlement'
      : 'preview';

  const sql = db();

  if (action === 'enrich_settlement') {
    const settBuf = decodeB64(b.settlement_base64 || b.content_base64);
    if (!settBuf) return res.status(400).json({ error: 'settlement_base64' });
    const out = await enrichFromSettlement(sql, settBuf.toString('utf8'));
    if (out.error) return res.status(400).json(out);
    return res.status(200).json({ action: 'enrich_settlement', ...out });
  }

  const filename = typeof b.filename === 'string' ? b.filename.slice(0, 260) : 'upload';
  const accountHint = typeof b.account_id === 'string' ? b.account_id : null;
  const buf = decodeB64(b.content_base64);
  if (!buf) return res.status(400).json({ error: 'content_base64' });

  let settlementText = null;
  const settBuf = decodeB64(b.settlement_base64);
  if (settBuf) settlementText = settBuf.toString('utf8');

  const rules = await loadRules(sql);

  let parsed;
  try {
    parsed = await parseExpenseFile(buf, {
      filename,
      account_id: accountHint || undefined,
      rules,
      settlementText: settlementText || undefined,
    });
  } catch (e) {
    return res.status(400).json({ error: e.code || 'parse_error', message: e.message });
  }

  const existing = await sql`
    SELECT id, status, account_id, filename, creado
    FROM imports WHERE file_hash = ${parsed.file_hash} LIMIT 1`;
  if (existing.length && existing[0].status === 'confirmed' && action === 'confirm') {
    return res.status(409).json({
      error: 'duplicate_file',
      import_id: existing[0].id,
      filename: existing[0].filename,
    });
  }

  if (action === 'preview') {
    return res.status(200).json({
      action: 'preview',
      file_hash: parsed.file_hash,
      filename,
      account_id: parsed.account_id,
      source_format: parsed.source_format,
      summary: parsed.summary,
      warnings: parsed.warnings,
      txs: parsed.txs.map(previewTx),
      duplicate_import: existing[0] || null,
    });
  }

  const importId = existing[0]?.id || newId('imp');
  const overrides = Array.isArray(b.overrides) ? b.overrides : [];
  const byFp = new Map(overrides.map((o) => [o.fingerprint, o]));

  await sql`
    INSERT INTO imports (id, account_id, filename, file_hash, source_format, status, summary, confirmado_en)
    VALUES (
      ${importId},
      ${parsed.account_id},
      ${filename},
      ${parsed.file_hash},
      ${parsed.source_format},
      'confirmed',
      ${JSON.stringify({ ...parsed.summary, warnings: parsed.warnings })}::jsonb,
      now()
    )
    ON CONFLICT (file_hash) DO UPDATE SET
      status = 'confirmed',
      summary = EXCLUDED.summary,
      confirmado_en = now(),
      filename = EXCLUDED.filename,
      account_id = EXCLUDED.account_id,
      source_format = EXCLUDED.source_format`;

  let upserted = 0;
  for (const t of parsed.txs) {
    upserted += await upsertTx(sql, importId, t, byFp);
  }

  return res.status(200).json({
    action: 'confirm',
    import_id: importId,
    account_id: parsed.account_id,
    source_format: parsed.source_format,
    file_hash: parsed.file_hash,
    upserted,
    summary: parsed.summary,
    warnings: parsed.warnings,
  });
}
