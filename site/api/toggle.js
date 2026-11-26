import { db, guard, body } from './_lib.js';

// Lote de cambios [{id, done}] en UNA sentencia (update + log).
const Q = `
WITH c AS (SELECT DISTINCT ON (id) id, done FROM jsonb_to_recordset($1::jsonb) AS x(id text, done boolean)),
u AS (
  UPDATE items i SET done = c.done, done_at = CASE WHEN c.done THEN now() ELSE NULL END, actualizado = now()
  FROM c WHERE i.id = c.id AND i.done IS DISTINCT FROM c.done
  RETURNING i.id, i.done, i.done_at)
, l AS (INSERT INTO item_log (item_id, done, origen) SELECT id, done, 'web' FROM u)
SELECT id, done, done_at FROM u`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  const ch = (body(req).changes || [])
    .filter((c) => c && typeof c.id === 'string' && c.id.length < 100 && typeof c.done === 'boolean')
    .slice(0, 200);
  if (!ch.length) return res.status(200).json({ updated: [] });
  const rows = await db().query(Q, [JSON.stringify(ch)]);
  res.status(200).json({ updated: rows });
}
