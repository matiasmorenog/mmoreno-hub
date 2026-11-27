export const CAT_UBER_DIDI = 'ingresos-uber-didi';
export const CAT_PEAJES = 'peajes';
export const CAT_RENDIMIENTOS = 'rendimientos';

/** How category was assigned. Hourly is weakest: never beats manual/rule/history. */
export const CAT_SRC_MANUAL = 'manual';
export const CAT_SRC_RULE = 'rule';
export const CAT_SRC_BUILTIN = 'builtin';
export const CAT_SRC_HISTORY = 'history';
export const CAT_SRC_HOURLY = 'hourly';

const HISTORY_OK = new Set([CAT_SRC_MANUAL, CAT_SRC_RULE, CAT_SRC_BUILTIN, CAT_SRC_HISTORY, null]);

/** Collapse whitespace for stored rule patterns (case preserved for display). */
export function normalizeRulePattern(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/** Case-insensitive identity key for rules («Moreno Matias» ≡ «MORENO MATIAS»). */
export function rulePatternKey(s) {
  return normalizeRulePattern(s).toLowerCase();
}

/**
 * Name-parts patterns: `nameparts:2:matias adrian moreno gallo` (min defaults to 2).
 * Matches when ≥min distinct tokens appear as whole words (any order, case-insensitive).
 */
export function parseNamePartsPattern(pattern) {
  const raw = normalizeRulePattern(pattern);
  const m = /^nameparts:(?:(\d+):)?(.+)$/i.exec(raw);
  if (!m) return null;
  const min = m[1] ? Math.max(1, parseInt(m[1], 10) || 2) : 2;
  const tokens = [...new Set(
    m[2]
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((t) => t.length >= 2),
  )];
  if (tokens.length < min) return null;
  return { min, tokens };
}

/** True if haystack contains ≥min name-part tokens (whole words; allows bank truncations). */
export function namePartsMatch(haystack, parts) {
  if (!parts?.tokens?.length) return false;
  const hay = String(haystack || '').toLowerCase();
  const words = hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let hits = 0;
  for (const t of parts.tokens) {
    let ok = false;
    for (const w of words) {
      if (w === t || (w.length >= 3 && t.startsWith(w)) || (t.length >= 3 && w.startsWith(t))) {
        ok = true;
        break;
      }
    }
    if (ok) hits += 1;
  }
  return hits >= parts.min;
}

export function ruleMatchesHaystack(pattern, haystack) {
  const parts = parseNamePartsPattern(pattern);
  if (parts) return namePartsMatch(haystack, parts);
  const pat = rulePatternKey(pattern);
  if (pat.length < 3) return false;
  return String(haystack || '').includes(pat);
}

/** Normalize text used for rule matching / learning. */
export function matchHaystack(tx) {
  const desc = String(tx.descripcion || '')
    .replace(/^(Consumo|Reembolso|Impuesto)\s*:\s*/i, '')
    .trim();
  const merchant = String(tx.merchant || '').trim();
  return rulePatternKey(`${merchant} ${desc}`);
}

/** Pattern to learn from a manual categorization. Prefer merchant. */
export function learnPatternFromTx(tx) {
  const merchant = normalizeRulePattern(tx.merchant || '');
  if (merchant.length >= 3) return merchant.slice(0, 120);
  const desc = normalizeRulePattern(
    String(tx.descripcion || '').replace(
      /^(Consumo|Reembolso|Impuesto|Transferencia recibida|Transferencia enviada|Pago con QR|Pago autom[aá]tico|Pago de suscripci[oó]n|Pago)\s*:?\s*/iu,
      '',
    ),
  );
  if (desc.length >= 3) return desc.slice(0, 120);
  return null;
}

/**
 * Stable merchant key for history matching.
 * Prefer commerce/merchant/seller id from raw; else normalized merchant text.
 */
export function normalizeMerchantKey(tx) {
  const raw = tx?.raw && typeof tx.raw === 'object' ? tx.raw : {};
  for (const k of ['commerce_id', 'merchant_id', 'seller_id', 'store_id', 'collector_id']) {
    const v = raw[k];
    if (v != null && String(v).trim()) return `id:${String(v).trim().toLowerCase()}`;
  }
  let m = String(tx?.merchant || '').trim().toLowerCase();
  if (!m) {
    m = String(tx?.descripcion || '')
      .replace(
        /^(consumo|reembolso|impuesto|transferencia recibida|transferencia enviada|pago con qr|pago autom[aá]tico|pago de suscripci[oó]n|pago)\s*:?\s*/iu,
        '',
      )
      .trim()
      .toLowerCase();
  }
  if (!m) return null;
  // Collapse APPYPF / Merpago*APPYPF station variants → same fuel key
  if (/appypf/i.test(m) && /combust/i.test(m)) m = 'appypf combust';
  else if (/merpago.*appypf/i.test(m)) m = 'appypf combust';
  m = m.replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s+.*'-]/gu, '').trim();
  if (m.length < 3) return null;
  return `m:${m.slice(0, 120)}`;
}

function horaLocal(tx) {
  if (typeof tx.hora_local === 'number' && tx.hora_local >= 0 && tx.hora_local <= 23) return tx.hora_local;
  const raw = tx.raw && typeof tx.raw === 'object' ? tx.raw : null;
  if (raw && typeof raw.hora_local === 'number') return raw.hora_local;
  return null;
}

function setCat(out, categoryId, source) {
  if (out.category_id) return out;
  out.category_id = categoryId;
  out.category_source = source;
  return out;
}

/**
 * Built-in classifiers (run after DB rules + history, fill if still empty).
 * Priority: existing > merchant/DB rules > history > builtins > hourly 00–07:59.
 */
export function applyBuiltins(tx) {
  const out = { ...tx };
  const hay = matchHaystack(out);

  // Builtin own-name fallback: ≥2 name tokens AND at least matias|adrian (avoids family surnames).
  if (
    out.account_id === 'mp_wallet' &&
    /transferencia/i.test(out.tx_type || '') &&
    namePartsMatch(hay, { min: 2, tokens: ['matias', 'adrian', 'moreno', 'gallo'] }) &&
    namePartsMatch(hay, { min: 1, tokens: ['matias', 'adrian'] })
  ) {
    out.is_internal_transfer = true;
    out.is_excluded = true;
    setCat(out, 'transferencias', CAT_SRC_BUILTIN);
  }

  if (
    out.account_id === 'mp_wallet' &&
    out.tx_type === 'transferencia_recibida' &&
    /dlocal/i.test(hay)
  ) {
    setCat(out, CAT_UBER_DIDI, CAT_SRC_BUILTIN);
  }

  if (
    out.account_id === 'mp_wallet' &&
    (out.tx_type === 'rendimientos' || /^rendimientos\b/i.test(hay))
  ) {
    setCat(out, CAT_RENDIMIENTOS, CAT_SRC_BUILTIN);
  }

  if (out.account_id === 'santander_amex' && /merpago/i.test(hay)) {
    out.double_count_guard = true;
    out.is_excluded = true;
    if (/ausol|auoeste|aubasa|\bausa\b|merpago\*au/i.test(hay)) {
      setCat(out, CAT_PEAJES, CAT_SRC_BUILTIN);
    }
  }

  const h = horaLocal(out);
  if (
    out.account_id === 'mp_wallet' &&
    out.tx_type === 'transferencia_recibida' &&
    h != null &&
    h >= 0 &&
    h < 8
  ) {
    setCat(out, CAT_UBER_DIDI, CAT_SRC_HOURLY);
  }

  return out;
}

/**
 * Build history map from prior categorized rows.
 * Key: `${account_id}::${merchantKey}` → { category_id }
 * Skips hourly-only sources (weak).
 */
export function buildMerchantHistoryMap(priorRows) {
  const map = new Map();
  const sorted = (priorRows || []).slice().sort((a, b) => {
    const ta = a.actualizado ? new Date(a.actualizado).getTime() : 0;
    const tb = b.actualizado ? new Date(b.actualizado).getTime() : 0;
    return tb - ta;
  });
  for (const row of sorted) {
    if (!row?.category_id) continue;
    const src = row.category_source ?? null;
    if (src === CAT_SRC_HOURLY) continue;
    if (src != null && !HISTORY_OK.has(src)) continue;
    const key = normalizeMerchantKey(row);
    if (!key) continue;
    const mapKey = `${row.account_id || ''}::${key}`;
    if (map.has(mapKey)) continue; // keep most recent
    map.set(mapKey, { category_id: row.category_id });
  }
  return map;
}

function applyHistory(tx, historyMap) {
  if (!historyMap || !historyMap.size || tx.category_id) return tx;
  const key = normalizeMerchantKey(tx);
  if (!key) return tx;
  const hit = historyMap.get(`${tx.account_id || ''}::${key}`);
  if (!hit?.category_id) return tx;
  return setCat({ ...tx }, hit.category_id, CAT_SRC_HISTORY);
}

/**
 * Apply category / exclude rules per transaction (never whole-file).
 * Order: DB rules → merchant history → builtins → hourly.
 */
export function applyRules(txs, rules, opts = {}) {
  const historyMap = opts.historyMap || null;
  const active = (rules || [])
    .filter((r) => r.activo !== false)
    .slice()
    .sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id)));

  return txs.map((tx) => {
    let out = { ...tx };
    if (!out.category_source) out.category_source = null;
    const hay = matchHaystack(out);

    for (const rule of active) {
      if (rule.account_id && rule.account_id !== out.account_id) continue;
      if (!ruleMatchesHaystack(rule.pattern, hay)) continue;
      const pat = rulePatternKey(rule.pattern);
      const parts = parseNamePartsPattern(rule.pattern);

      if (rule.exclude_expense) {
        out.is_excluded = true;
        if (/merpago/i.test(pat)) {
          out.double_count_guard = true;
          out.is_internal_transfer = false;
        } else if (parts || /moreno|matias|propia|own|nameparts/i.test(pat)) {
          out.is_internal_transfer = true;
        }
      }
      if (rule.category_id && !out.category_id) {
        out.category_id = rule.category_id;
        out.category_source = CAT_SRC_RULE;
      }
      break;
    }

    out = applyHistory(out, historyMap);
    out = applyBuiltins(out);
    return out;
  });
}
