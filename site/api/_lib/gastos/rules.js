export const CAT_UBER_DIDI = 'ingresos-uber-didi';
export const CAT_PEAJES = 'peajes';
export const CAT_RENDIMIENTOS = 'rendimientos';

/** How category was assigned. Hourly is weakest: never beats manual/rule. */
export const CAT_SRC_MANUAL = 'manual';
export const CAT_SRC_RULE = 'rule';
export const CAT_SRC_BUILTIN = 'builtin';
export const CAT_SRC_HOURLY = 'hourly';

/** Normalize text used for rule matching / learning. */
export function matchHaystack(tx) {
  const desc = String(tx.descripcion || '')
    .replace(/^(Consumo|Reembolso|Impuesto)\s*:\s*/i, '')
    .trim();
  const merchant = String(tx.merchant || '').trim();
  return `${merchant} ${desc}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Pattern to learn from a manual categorization. Prefer merchant. */
export function learnPatternFromTx(tx) {
  const merchant = String(tx.merchant || '').trim();
  if (merchant.length >= 3) return merchant.slice(0, 120);
  const desc = String(tx.descripcion || '')
    .replace(
      /^(Consumo|Reembolso|Impuesto|Transferencia recibida|Transferencia enviada|Pago con QR|Pago autom[aá]tico|Pago de suscripci[oó]n|Pago)\s*:?\s*/iu,
      '',
    )
    .trim();
  if (desc.length >= 3) return desc.slice(0, 120);
  return null;
}

function horaLocal(tx) {
  if (typeof tx.hora_local === 'number' && tx.hora_local >= 0 && tx.hora_local <= 23) return tx.hora_local;
  const raw = tx.raw && typeof tx.raw === 'object' ? tx.raw : null;
  if (raw && typeof raw.hora_local === 'number') return raw.hora_local;
  return null;
}

function setCat(out, categoryId, source) {
  if (out.category_id) return out; // never overwrite existing (manual/rule/builtin/hourly)
  out.category_id = categoryId;
  out.category_source = source;
  return out;
}

/**
 * Built-in classifiers (run after DB rules, fill category if still empty).
 * Priority: existing category (manual/rule) > merchant/DB rules > builtins (DLOCAL…) > hourly 00–07:59.
 * Hourly is initial quick classify only — never beats manual or learned merchant rules.
 */
export function applyBuiltins(tx) {
  const out = { ...tx };
  const hay = matchHaystack(out);

  if (
    out.account_id === 'mp_wallet' &&
    /transferencia/i.test(out.tx_type || '') &&
    /moreno\s+matias/i.test(hay)
  ) {
    out.is_internal_transfer = true;
    out.is_excluded = true;
    setCat(out, 'transferencias', CAT_SRC_BUILTIN);
  }

  // DLOCAL = DiDi/Uber driver income (Matias). EBANX not auto unless asked.
  if (
    out.account_id === 'mp_wallet' &&
    out.tx_type === 'transferencia_recibida' &&
    /dlocal/i.test(hay)
  ) {
    setCat(out, CAT_UBER_DIDI, CAT_SRC_BUILTIN);
  }

  // MP remunerated-account interest.
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

  // Night window 00:00–07:59 America/Argentina/Buenos_Aires — weakest auto classify.
  // Only fills empty category; never overwrites manual/rule/builtin.
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
 * Apply category / exclude rules per transaction (never whole-file).
 * Match merchant + description text only — NOT tx_type.
 * Merchant/DB rules run before builtins/hourly and always win over hourly.
 */
export function applyRules(txs, rules) {
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
      const pat = String(rule.pattern || '').trim().toLowerCase();
      if (pat.length < 3) continue;
      if (!hay.includes(pat)) continue;

      if (rule.exclude_expense) {
        out.is_excluded = true;
        if (/merpago/i.test(pat)) {
          out.double_count_guard = true;
          out.is_internal_transfer = false;
        } else if (/moreno|propia|own/i.test(pat)) {
          out.is_internal_transfer = true;
        }
      }
      if (rule.category_id && !out.category_id) {
        out.category_id = rule.category_id;
        out.category_source = CAT_SRC_RULE;
      }
      break;
    }

    out = applyBuiltins(out);
    return out;
  });
}
