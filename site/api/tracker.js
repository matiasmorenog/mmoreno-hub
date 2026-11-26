import { db, guard } from './_lib.js';

const COLS = ['id', 'seccion', 'fecha', 'empresa', 'rol', 'estado_corto', 'estado', 'score', 'fuente', 'link', 'archivo'];
const Q = `SELECT json_agg(json_build_array(${COLS.map((c) => (c === 'fecha' ? "to_char(fecha,'YYYY-MM-DD')" : c)).join(',')}) ORDER BY fecha DESC NULLS LAST, orden DESC) AS r FROM applications`;

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).end();
  const rows = await db().query(Q);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.status(200).json({ cols: COLS, rows: rows[0].r || [] });
}
