import crypto from 'node:crypto';
import { db, guard, body } from './_lib.js';

const TZ = 'America/Argentina/Buenos_Aires';
const MOMENTO_MAX = 40;
/** Calendar days back (incl. today) to surface missed doses as pendientes. */
const LOOKBACK_DAYS = 14;

function normalizeMomento(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ').slice(0, MOMENTO_MAX);
  return t || null;
}

function slugId(nombre) {
  const base = String(nombre)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'med';
  return `${base}-${Date.now().toString(36).slice(-5)}${crypto.randomBytes(1).toString('hex')}`.slice(0, 100);
}

const LIST = `
WITH hoy AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS d),
dias AS (
  SELECT generate_series(
    (SELECT d FROM hoy) - ${LOOKBACK_DAYS}::int,
    (SELECT d FROM hoy),
    '1 day'::interval
  )::date AS fecha
),
items AS (
  SELECT json_agg(json_build_object(
      'id', m.id,
      'nombre', m.nombre,
      'notas', m.notas,
      'momento', m.momento,
      'activo', m.activo,
      'orden', m.orden,
      'tomado', COALESCE(md.tomado, false),
      'tomado_en', md.tomado_en
    ) ORDER BY m.orden, m.id) AS arr
  FROM medications m
  LEFT JOIN medication_doses md ON md.medication_id = m.id AND md.fecha = (SELECT d FROM hoy)
),
pendientes AS (
  SELECT json_agg(json_build_object(
      'id', m.id,
      'nombre', m.nombre,
      'notas', m.notas,
      'momento', m.momento,
      'fecha', to_char(d.fecha, 'YYYY-MM-DD')
    ) ORDER BY d.fecha DESC, m.orden, m.id) AS arr
  FROM medications m
  CROSS JOIN dias d
  WHERE m.activo
    AND d.fecha >= (m.creado AT TIME ZONE '${TZ}')::date
    AND NOT EXISTS (
      SELECT 1 FROM medication_doses md
      WHERE md.medication_id = m.id AND md.fecha = d.fecha AND md.tomado
    )
)
SELECT json_build_object(
  'hoy', (SELECT to_char(d, 'YYYY-MM-DD') FROM hoy),
  'tz', '${TZ}',
  'lookback_days', ${LOOKBACK_DAYS},
  'items', COALESCE((SELECT arr FROM items), '[]'::json),
  'pendientes', COALESCE((SELECT arr FROM pendientes), '[]'::json)
) AS b`;

const INS = `
INSERT INTO medications (id, nombre, notas, momento, activo, orden)
VALUES (
  $1, $2, $3, $4, COALESCE($5, true),
  COALESCE($6, (SELECT COALESCE(MAX(orden), 0) + 10 FROM medications))
)
RETURNING id, nombre, notas, momento, activo, orden, false AS tomado, NULL::timestamptz AS tomado_en`;

const UPD = `
UPDATE medications SET
  nombre = COALESCE($2, nombre),
  notas = CASE WHEN $3::boolean THEN $4 ELSE notas END,
  momento = CASE WHEN $5::boolean THEN $6 ELSE momento END,
  activo = COALESCE($7, activo),
  orden = COALESCE($8, orden),
  actualizado = now()
WHERE id = $1
RETURNING id, nombre, notas, momento, activo, orden`;

// Hard delete: medication_doses.medication_id REFERENCES medications(id) ON DELETE CASCADE.
const DEL = `DELETE FROM medications WHERE id = $1 RETURNING id`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  if (req.method === 'GET') {
    const rows = await db().query(LIST);
    return res.status(200).json(rows[0].b);
  }

  if (req.method === 'POST') {
    const b = body(req);
    const nombre = typeof b.nombre === 'string' ? b.nombre.trim() : '';
    if (!nombre || nombre.length > 200) return res.status(400).json({ error: 'nombre' });
    const notas = typeof b.notas === 'string' ? (b.notas.trim().slice(0, 2000) || null) : null;
    const momento = normalizeMomento(b.momento);
    const activo = typeof b.activo === 'boolean' ? b.activo : true;
    const orden = typeof b.orden === 'number' && Number.isFinite(b.orden) ? Math.trunc(b.orden) : null;
    const id = typeof b.id === 'string' && b.id.length && b.id.length < 100 ? b.id : slugId(nombre);
    const rows = await db().query(INS, [id, nombre, notas, momento, activo, orden]);
    return res.status(201).json(rows[0]);
  }

  if (req.method === 'PATCH') {
    const b = body(req);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id || id.length > 100) return res.status(400).json({ error: 'id' });
    const nombre = typeof b.nombre === 'string' ? (b.nombre.trim().slice(0, 200) || null) : null;
    if (b.nombre !== undefined && !nombre) return res.status(400).json({ error: 'nombre' });
    const clearNotas = Object.prototype.hasOwnProperty.call(b, 'notas');
    const notas = clearNotas
      ? (typeof b.notas === 'string' ? (b.notas.trim().slice(0, 2000) || null) : null)
      : null;
    const clearMomento = Object.prototype.hasOwnProperty.call(b, 'momento');
    const momento = clearMomento ? normalizeMomento(b.momento) : null;
    const activo = typeof b.activo === 'boolean' ? b.activo : null;
    const orden = typeof b.orden === 'number' && Number.isFinite(b.orden) ? Math.trunc(b.orden) : null;
    const rows = await db().query(UPD, [id, nombre, clearNotas, notas, clearMomento, momento, activo, orden]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json(rows[0]);
  }

  if (req.method === 'DELETE') {
    const b = body(req);
    const id = typeof b.id === 'string' ? b.id : (typeof req.query?.id === 'string' ? req.query.id : '');
    if (!id || id.length > 100) return res.status(400).json({ error: 'id' });
    const rows = await db().query(DEL, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json({ deleted: rows[0].id });
  }

  return res.status(405).end();
}
