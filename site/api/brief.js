import { db, guard } from './_lib.js';

// Una sola consulta: meta + items visibles + versión del tracker.
const Q = `
WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS d)
SELECT json_build_object(
  'hoy', (SELECT d FROM hoy),
  'meta', (SELECT row_to_json(m) FROM brief_meta m WHERE id = 1),
  'items', COALESCE((SELECT json_agg(json_build_object(
      'id', i.id, 'seccion', i.seccion, 'titulo', i.titulo, 'detalle', i.detalle,
      'etiqueta', i.etiqueta, 'tono', i.tono, 'url', i.url, 'tab_name', i.tab_name,
      'links', i.links, 'score', i.score, 'extra', i.extra, 'vence', i.vence,
      'done', i.done, 'done_at', i.done_at) ORDER BY i.prioridad, i.id)
    FROM items i, hoy
    WHERE NOT i.archivado AND (i.fecha_desde IS NULL OR i.fecha_desde <= hoy.d)), '[]'::json),
  'tracker_v', (SELECT extract(epoch FROM max(actualizado))::bigint || '-' || count(*) FROM applications)
) AS b`;

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).end();
  const rows = await db().query(Q);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.status(200).json(rows[0].b);
}
