/** Parse AR locale amounts: "1.234,56" / "-20.000,00" / "74,74" → number */
export function parseArAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '-') return null;
  s = s.replace(/^\s*\$\s*/u, '').replace(/^\s*U\$S\s*/iu, '').replace(/^\s*US\$\s*/iu, '');
  s = s.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseFlexibleAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^\s*\$\s*/u, '').replace(/^\s*U\$S\s*/iu, '').replace(/^\s*US\$\s*/iu, '');
  s = s.replace(/\s/g, '');
  if (/\d,\d{2}$/.test(s) && s.includes('.')) {
    // 1.234,56
    return parseArAmount(s);
  }
  if (/\d,\d{2}$/.test(s) && !s.includes('.')) {
    return parseArAmount(s);
  }
  // 1234.56 or 1,234.56
  s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
