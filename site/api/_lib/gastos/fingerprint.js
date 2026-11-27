import crypto from 'node:crypto';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function fingerprint(parts) {
  const raw = parts.map((p) => (p == null ? '' : String(p).trim())).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function newId(prefix = 'tx') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}
