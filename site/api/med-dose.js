import { db, guard, body } from './_lib.js';

const TZ = 'America/Argentina/Buenos_Aires';
const LOOKBACK_DAYS = 14;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// Upsert idempotente por (medication_id, fecha). Sin fecha → hoy en Buenos Aires.
const UPSERT = `
WITH hoy AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS d),
target AS (
  SELECT CASE
    WHEN $3::text IS NULL OR $3::text = '' THEN hoy.d
    ELSE $3::date
  END AS fecha
  FROM hoy
)
INSERT INTO medication_doses (medication_id, fecha, tomado, tomado_en, actualizado)
SELECT $1, target.fecha, $2, CASE WHEN $2 THEN now() ELSE NULL END, now()
FROM target
WHERE EXISTS (SELECT 1 FROM medications m WHERE m.id = $1)
ON CONFLICT (medication_id, fecha) DO UPDATE SET
  tomado = EXCLUDED.tomado,
  tomado_en = CASE WHEN EXCLUDED.tomado THEN COALESCE(medication_doses.tomado_en, now()) ELSE NULL END,
  actualizado = now()
RETURNING medication_id AS id, to_char(fecha, 'YYYY-MM-DD') AS fecha, tomado, tomado_en`;

const HOY = `SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS hoy`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();

  const b = body(req);
  const id = typeof b.id === 'string' ? b.id : '';
  if (!id || id.length > 100) return res.status(400).json({ error: 'id' });
  if (typeof b.tomado !== 'boolean') return res.status(400).json({ error: 'tomado' });

  let fechaParam = null;
  if (b.fecha != null && b.fecha !== '') {
    if (typeof b.fecha !== 'string' || !FECHA_RE.test(b.fecha)) {
      return res.status(400).json({ error: 'fecha' });
    }
    const hoyRows = await db().query(HOY);
    const hoy = hoyRows[0].hoy;
    const min = shiftIsoDate(hoy, -LOOKBACK_DAYS);
    if (b.fecha > hoy || b.fecha < min) {
      return res.status(400).json({ error: 'fecha_range' });
    }
    fechaParam = b.fecha;
  }

  const rows = await db().query(UPSERT, [id, b.tomado, fechaParam]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.status(200).json(rows[0]);
}

/** Shift YYYY-MM-DD by delta days (UTC noon math; calendar-safe for ISO dates). */
function shiftIsoDate(iso, deltaDays) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}
