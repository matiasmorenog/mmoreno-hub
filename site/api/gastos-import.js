import { db, guard, body } from './_lib.js';
import { parseExpenseFile } from './_lib/gastos/parse.js';
import { newId } from './_lib/gastos/fingerprint.js';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();

  const b = body(req);
  const action = b.action === 'confirm' ? 'confirm' : 'preview';
  const filename = typeof b.filename === 'string' ? b.filename.slice(0, 260) : 'upload';
  const accountHint = typeof b.account_id === 'string' ? b.account_id : null;
  const b64 = typeof b.content_base64 === 'string' ? b.content_base64 : '';
  if (!b64) return res.status(400).json({ error: 'content_base64' });

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return res.status(400).json({ error: 'bad_base64' });
  }
  if (!buf.length || buf.length > 3.5 * 1024 * 1024) {
    return res.status(400).json({ error: 'file_size' });
  }

  const sql = db();
  const rules = await loadRules(sql);

  let parsed;
  try {
    parsed = await parseExpenseFile(buf, {
      filename,
      account_id: accountHint || undefined,
      rules,
    });
  } catch (e) {
    return res.status(400).json({ error: e.code || 'parse_error', message: e.message });
  }

  const existing = await sql`
    SELECT id, status, account_id, filename, creado
    FROM imports WHERE file_hash = ${parsed.file_hash} LIMIT 1`;
  if (existing.length && existing[0].status === 'confirmed') {
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

  // confirm → upsert by fingerprint
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
    const o = byFp.get(t.fingerprint) || {};
    const category_id = o.category_id !== undefined ? o.category_id : t.category_id;
    const is_excluded = o.is_excluded !== undefined ? !!o.is_excluded : !!t.is_excluded;
    const is_internal_transfer =
      o.is_internal_transfer !== undefined ? !!o.is_internal_transfer : !!t.is_internal_transfer;
    const id = newId('tx');
    const rows = await sql`
      INSERT INTO transactions (
        id, account_id, import_id, fingerprint, fecha, descripcion, merchant, tx_type,
        amount, currency, amount_ars, amount_usd, category_id,
        is_internal_transfer, is_excluded, double_count_guard, raw
      ) VALUES (
        ${id},
        ${t.account_id},
        ${importId},
        ${t.fingerprint},
        ${t.fecha},
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
        raw = EXCLUDED.raw,
        actualizado = now()
      RETURNING id`;
    if (rows.length) upserted += 1;
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
