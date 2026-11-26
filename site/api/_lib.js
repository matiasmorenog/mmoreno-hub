import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

let _sql;
export const db = () => (_sql ||= neon(process.env.DATABASE_URL));

const COOKIE = 'mb_s';
const DAYS = 90;
const sign = (v) => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(v).digest('base64url');

export function sessionCookie() {
  const exp = String(Date.now() + DAYS * 864e5);
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAYS * 86400}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function authed(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)mb_s=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

export function passwordOk(p) {
  const want = process.env.BRIEF_PASSWORD || '';
  if (typeof p !== 'string' || !want) return false;
  const a = crypto.createHash('sha256').update(p).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// Capa principal: Vercel Authentication (ssoProtection "all", incluye producción).
// Capa opcional de contraseña: solo si APP_PASSWORD_GATE=on (env var) — apagada por defecto.
export const gateOn = () => process.env.APP_PASSWORD_GATE === 'on';

export function guard(req, res) {
  if (!gateOn() || authed(req)) return true;
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({ error: 'auth' });
  return false;
}

export function body(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  try { return JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : b || '{}'); } catch { return {}; }
}
