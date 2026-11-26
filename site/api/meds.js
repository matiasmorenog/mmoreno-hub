import crypto from 'node:crypto';
import { db, guard, body } from './_lib.js';

const TZ = 'America/Argentina/Buenos_Aires';
const MOMENTOS = new Set(['manana', 'mediodia', 'noche']);

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
WITH hoy AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS d)
SELECT json_build_object(
  'hoy', (SELECT to_char(d, 'YYYY-MM-DD') FROM hoy),
  'tz', '${TZ}',
  'items', COALESCE((SELECT json_agg(json_build_object(
      'id', m.id,
      'nombre', m.nombre,
      'notas', m.notas,
      'momento', m.momento,
      'activo', m.activo,
      'orden', m.orden,
      'tomado', COALESCE(md.tomado, false),
      'tomado_en', md.tomado_en
    ) ORDER BY m.orden, m.id)
    FROM medications m
    LEFT JOIN medication_doses md ON md.medication_id = m.id AND md.fecha = (SELECT d FROM hoy)
  ), '[]'::json)
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
    const momento = typeof b.momento === 'string' && MOMENTOS.has(b.momento) ? b.momento : null;
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
    const momento = clearMomento
      ? (typeof b.momento === 'string' && MOMENTOS.has(b.momento) ? b.momento : null)
      : null;
    const activo = typeof b.activo === 'boolean' ? b.activo : null;
    const orden = typeof b.orden === 'number' && Number.isFinite(b.orden) ? Math.trunc(b.orden) : null;
    const rows = await db().query(UPD, [id, nombre, clearNotas, notas, clearMomento, momento, activo, orden]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json(rows[0]);
  }

  return res.status(405).end();
}
