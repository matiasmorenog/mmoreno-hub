import { db, guard, body } from './_lib.js';

const TZ = 'America/Argentina/Buenos_Aires';

// Upsert idempotente por (medication_id, fecha de hoy en Buenos Aires).
const UPSERT = `
WITH hoy AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS d)
INSERT INTO medication_doses (medication_id, fecha, tomado, tomado_en, actualizado)
SELECT $1, hoy.d, $2, CASE WHEN $2 THEN now() ELSE NULL END, now()
FROM hoy
WHERE EXISTS (SELECT 1 FROM medications m WHERE m.id = $1)
ON CONFLICT (medication_id, fecha) DO UPDATE SET
  tomado = EXCLUDED.tomado,
  tomado_en = CASE WHEN EXCLUDED.tomado THEN COALESCE(medication_doses.tomado_en, now()) ELSE NULL END,
  actualizado = now()
RETURNING medication_id AS id, to_char(fecha, 'YYYY-MM-DD') AS fecha, tomado, tomado_en`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();

  const b = body(req);
  const id = typeof b.id === 'string' ? b.id : '';
  if (!id || id.length > 100) return res.status(400).json({ error: 'id' });
  if (typeof b.tomado !== 'boolean') return res.status(400).json({ error: 'tomado' });

  const rows = await db().query(UPSERT, [id, b.tomado]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.status(200).json(rows[0]);
}
