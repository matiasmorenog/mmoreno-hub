/** Strip currency markers; keep leading minus (`-$ 1.234,56`, `$-1.234,56`). */
function stripCurrency(raw) {
  let s = String(raw).trim();
  s = s.replace(/^\s*U\$S\s*/iu, '').replace(/^\s*US\$\s*/iu, '');
  // -$123 / -$ 123 / $-123 / $123
  s = s.replace(/^\s*-\s*\$\s*/u, '-').replace(/^\s*\$\s*-/u, '-').replace(/^\s*\$\s*/u, '');
  return s;
}

/** Parse AR locale amounts: "1.234,56" / "-20.000,00" / "74,74" / "-$790,59" → number */
export function parseArAmount(raw) {
  if (raw == null) return null;
  let s = stripCurrency(raw);
  if (!s || s === '-') return null;
  s = s.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseFlexibleAmount(raw) {
  if (raw == null) return null;
  let s = stripCurrency(raw);
  if (!s) return null;
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
