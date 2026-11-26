import crypto from 'node:crypto';
import { db, guard, body } from './_lib.js';

// Alta de pendiente día a día en items.seccion = 'atencion' (mismo modelo que el brief).
function slugId(titulo) {
  const base = String(titulo)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pendiente';
  return `${base}-${Date.now().toString(36).slice(-5)}${crypto.randomBytes(1).toString('hex')}`.slice(0, 100);
}

const INS = `
INSERT INTO items (id, seccion, titulo, detalle, etiqueta, tono, prioridad)
VALUES (
  $1, 'atencion', $2, $3, $4, $5,
  COALESCE((SELECT MIN(prioridad) - 1 FROM items WHERE seccion = 'atencion' AND NOT archivado), 0)
)
RETURNING id, seccion, titulo, detalle, etiqueta, tono, url, tab_name, links, score, extra, vence, done, done_at`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();

  const b = body(req);
  const titulo = typeof b.titulo === 'string' ? b.titulo.trim() : '';
  if (!titulo || titulo.length > 500) return res.status(400).json({ error: 'titulo' });

  const detalle = typeof b.detalle === 'string' ? (b.detalle.trim().slice(0, 2000) || null) : null;
  const etiqueta = typeof b.etiqueta === 'string' ? (b.etiqueta.trim().slice(0, 80) || null) : null;
  const tonoOk = ['danger', 'warning', 'success'];
  const tono = typeof b.tono === 'string' && tonoOk.includes(b.tono) ? b.tono : null;

  const id = slugId(titulo);
  const rows = await db().query(INS, [id, titulo, detalle, etiqueta, tono]);
  res.status(201).json(rows[0]);
}
