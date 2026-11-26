import crypto from 'node:crypto';
import { db, guard, body } from './_lib.js';

function slugId(nombre) {
  const base = String(nombre)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
  return `${base}-${Date.now().toString(36).slice(-5)}${crypto.randomBytes(1).toString('hex')}`.slice(0, 100);
}

const LIST = `
SELECT json_build_object(
  'items', COALESCE((SELECT json_agg(json_build_object(
      'id', s.id,
      'nombre', s.nombre,
      'cantidad', s.cantidad,
      'notas', s.notas,
      'comprado', s.comprado,
      'comprado_en', s.comprado_en,
      'orden', s.orden
    ) ORDER BY s.comprado ASC, s.orden ASC, s.id ASC)
    FROM shopping_items s
  ), '[]'::json)
) AS b`;

const INS = `
INSERT INTO shopping_items (id, nombre, cantidad, notas, comprado, orden)
VALUES (
  $1, $2, $3, $4, false,
  COALESCE($5, (SELECT COALESCE(MAX(orden), 0) + 10 FROM shopping_items))
)
RETURNING id, nombre, cantidad, notas, comprado, comprado_en, orden`;

const UPD = `
UPDATE shopping_items SET
  nombre = COALESCE($2, nombre),
  cantidad = CASE WHEN $3::boolean THEN $4 ELSE cantidad END,
  notas = CASE WHEN $5::boolean THEN $6 ELSE notas END,
  comprado = COALESCE($7, comprado),
  comprado_en = CASE
    WHEN $7 IS NULL THEN comprado_en
    WHEN $7 THEN COALESCE(comprado_en, now())
    ELSE NULL
  END,
  orden = COALESCE($8, orden),
  actualizado = now()
WHERE id = $1
RETURNING id, nombre, cantidad, notas, comprado, comprado_en, orden`;

const DEL_ONE = `DELETE FROM shopping_items WHERE id = $1 RETURNING id`;
const DEL_BOUGHT = `DELETE FROM shopping_items WHERE comprado = true RETURNING id`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  if (req.method === 'GET') {
    const rows = await db().query(LIST);
    return res.status(200).json(rows[0].b);
  }

  if (req.method === 'POST') {
    const b = body(req);
    if (b.action === 'clear_bought') {
      const rows = await db().query(DEL_BOUGHT);
      return res.status(200).json({ deleted: rows.length });
    }
    const nombre = typeof b.nombre === 'string' ? b.nombre.trim() : '';
    if (!nombre || nombre.length > 200) return res.status(400).json({ error: 'nombre' });
    const cantidad = typeof b.cantidad === 'string' ? (b.cantidad.trim().slice(0, 100) || null) : null;
    const notas = typeof b.notas === 'string' ? (b.notas.trim().slice(0, 2000) || null) : null;
    const orden = typeof b.orden === 'number' && Number.isFinite(b.orden) ? Math.trunc(b.orden) : null;
    const id = typeof b.id === 'string' && b.id.length && b.id.length < 100 ? b.id : slugId(nombre);
    const rows = await db().query(INS, [id, nombre, cantidad, notas, orden]);
    return res.status(201).json(rows[0]);
  }

  if (req.method === 'PATCH') {
    const b = body(req);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id || id.length > 100) return res.status(400).json({ error: 'id' });
    const nombre = typeof b.nombre === 'string' ? (b.nombre.trim().slice(0, 200) || null) : null;
    if (b.nombre !== undefined && !nombre) return res.status(400).json({ error: 'nombre' });
    const clearCantidad = Object.prototype.hasOwnProperty.call(b, 'cantidad');
    const cantidad = clearCantidad
      ? (typeof b.cantidad === 'string' ? (b.cantidad.trim().slice(0, 100) || null) : null)
      : null;
    const clearNotas = Object.prototype.hasOwnProperty.call(b, 'notas');
    const notas = clearNotas
      ? (typeof b.notas === 'string' ? (b.notas.trim().slice(0, 2000) || null) : null)
      : null;
    const comprado = typeof b.comprado === 'boolean' ? b.comprado : null;
    const orden = typeof b.orden === 'number' && Number.isFinite(b.orden) ? Math.trunc(b.orden) : null;
    const rows = await db().query(UPD, [id, nombre, clearCantidad, cantidad, clearNotas, notas, comprado, orden]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json(rows[0]);
  }

  if (req.method === 'DELETE') {
    const b = body(req);
    const id = typeof b.id === 'string' ? b.id : (typeof req.query?.id === 'string' ? req.query.id : '');
    if (!id || id.length > 100) return res.status(400).json({ error: 'id' });
    const rows = await db().query(DEL_ONE, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json({ deleted: rows[0].id });
  }

  return res.status(405).end();
}
