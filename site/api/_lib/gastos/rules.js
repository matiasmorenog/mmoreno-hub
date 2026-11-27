/** Apply category / exclude rules to a parsed transaction list (mutates copies). */
export function applyRules(txs, rules) {
  const active = (rules || [])
    .filter((r) => r.activo !== false)
    .slice()
    .sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id)));

  return txs.map((tx) => {
    const out = { ...tx };
    const hay = `${out.merchant || ''} ${out.descripcion || ''} ${out.tx_type || ''}`.toLowerCase();
    for (const rule of active) {
      if (rule.account_id && rule.account_id !== out.account_id) continue;
      const pat = String(rule.pattern || '').toLowerCase();
      if (!pat || !hay.includes(pat)) continue;
      if (rule.exclude_expense) {
        out.is_excluded = true;
        out.is_internal_transfer = /moreno|propia|own/i.test(pat) || out.is_internal_transfer;
        if (/merpago/i.test(pat)) {
          out.double_count_guard = true;
          out.is_internal_transfer = false;
        }
      }
      if (rule.category_id && !out.category_id) out.category_id = rule.category_id;
      break; // first match by priority
    }
    // Built-in own-name heuristic for MP wallet transfers
    if (
      out.account_id === 'mp_wallet' &&
      /transferencia/i.test(out.tx_type || out.descripcion || '') &&
      /moreno\s+matias/i.test(`${out.merchant || ''} ${out.descripcion || ''}`)
    ) {
      out.is_internal_transfer = true;
      out.is_excluded = true;
      out.category_id = out.category_id || 'transferencias';
    }
    // Built-in Merpago* guard on Amex
    if (
      out.account_id === 'santander_amex' &&
      /merpago/i.test(`${out.merchant || ''} ${out.descripcion || ''}`)
    ) {
      out.double_count_guard = true;
      out.is_excluded = true;
    }
    return out;
  });
}
