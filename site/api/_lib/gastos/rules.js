/**
 * Apply category / exclude rules per transaction (never whole-file).
 * Match merchant + description text only — NOT tx_type — so a rule like
 * "Consumo" / "Pago" cannot paint every card/wallet row the same category.
 */
export function applyRules(txs, rules) {
  const active = (rules || [])
    .filter((r) => r.activo !== false)
    .slice()
    .sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id)));

  return txs.map((tx) => {
    const out = { ...tx };
    // Prefer merchant; strip kind prefixes from descripcion for matching.
    const desc = String(out.descripcion || '')
      .replace(/^(Consumo|Reembolso|Impuesto)\s*:\s*/i, '')
      .trim();
    const merchant = String(out.merchant || '').trim();
    const hay = `${merchant} ${desc}`.toLowerCase().replace(/\s+/g, ' ').trim();

    for (const rule of active) {
      if (rule.account_id && rule.account_id !== out.account_id) continue;
      const pat = String(rule.pattern || '').trim().toLowerCase();
      // Ignore tiny/broad patterns that would match nearly every row.
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
      if (rule.category_id && !out.category_id) out.category_id = rule.category_id;
      // First matching rule by priority wins for this row only.
      break;
    }

    // Built-in own-name heuristic for MP wallet transfers (per row).
    if (
      out.account_id === 'mp_wallet' &&
      /transferencia/i.test(out.tx_type || '') &&
      /moreno\s+matias/i.test(hay)
    ) {
      out.is_internal_transfer = true;
      out.is_excluded = true;
      out.category_id = out.category_id || 'transferencias';
    }

    // Built-in Merpago* guard on Amex (per row).
    if (out.account_id === 'santander_amex' && /merpago/i.test(hay)) {
      out.double_count_guard = true;
      out.is_excluded = true;
    }
    return out;
  });
}
