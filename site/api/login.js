import { passwordOk, sessionCookie, clearCookie, body } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'DELETE') { res.setHeader('Set-Cookie', clearCookie()); return res.status(204).end(); }
  if (req.method !== 'POST') return res.status(405).end();
  if (!passwordOk(body(req).password)) { await new Promise((r) => setTimeout(r, 800)); return res.status(401).json({ error: 'clave' }); }
  res.setHeader('Set-Cookie', sessionCookie());
  res.status(204).end();
}
