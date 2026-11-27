/** Cash / manual expenses + monthly recurring helpers. */

export const CASH_ACCOUNT_ID = 'cash';

export function clampDayOfMonth(day) {
  const n = Math.trunc(Number(day));
  if (!Number.isFinite(n)) return 1;
  return Math.min(28, Math.max(1, n));
}

/** YYYY-MM-DD in America/Argentina/Buenos_Aires. */
export function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Advance one calendar month, clamping to day_of_month (1–28).
 * @param {string} isoDate YYYY-MM-DD
 * @param {number} dayOfMonth
 */
export function addOneMonth(isoDate, dayOfMonth) {
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('bad_date');
  let y = Number(m[1]);
  let mo = Number(m[2]) + 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  const day = String(clampDayOfMonth(dayOfMonth)).padStart(2, '0');
  return `${y}-${String(mo).padStart(2, '0')}-${day}`;
}

/**
 * Next due for a monthly fixed: this month's day if still upcoming/today, else next month.
 * @param {number} dayOfMonth
 * @param {string} [today] YYYY-MM-DD
 */
export function defaultNextDue(dayOfMonth, today = todayISO()) {
  const day = clampDayOfMonth(dayOfMonth);
  const m = String(today).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('bad_today');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const candidate = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (day >= d) return candidate;
  return addOneMonth(candidate, day);
}

/**
 * Materialize due recurring cash expenses into transactions.
 * Catch-up: while next_due <= today, insert one tx and advance next_due by a month.
 * @returns {{ created: number, advanced: number }}
 */
export async function materializeDueCash(sql, {
  fingerprint,
  newId,
  today = todayISO(),
} = {}) {
  if (typeof fingerprint !== 'function' || typeof newId !== 'function') {
    throw new Error('fingerprint_newId_required');
  }
  const due = await sql`
    SELECT id, nombre, amount, currency, category_id, notes, day_of_month, next_due, account_id
    FROM cash_recurring
    WHERE activo = true AND next_due <= ${today}
    ORDER BY next_due ASC, id ASC`;

  let created = 0;
  let advanced = 0;

  for (const r of due) {
    let next = String(r.next_due).slice(0, 10);
    const day = clampDayOfMonth(r.day_of_month);
    const accountId = r.account_id || CASH_ACCOUNT_ID;
    // Expense amounts stored negative (UI enters positive).
    const rawAmt = Number(r.amount);
    const amount = Number.isFinite(rawAmt)
      ? (rawAmt > 0 ? -rawAmt : rawAmt)
      : 0;
    const currency = r.currency === 'USD' ? 'USD' : 'ARS';
    const amount_ars = currency === 'ARS' ? amount : null;
    const amount_usd = currency === 'USD' ? amount : null;

    while (next <= today) {
      const fp = fingerprint(['cash_rec', r.id, next]);
      const id = newId('cash');
      const notes = typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim().slice(0, 2000) : null;
      const rows = await sql`
        INSERT INTO transactions (
          id, account_id, import_id, fingerprint, fecha, posted_at, hora_local,
          descripcion, merchant, tx_type,
          amount, currency, amount_ars, amount_usd, category_id, category_source,
          is_internal_transfer, is_excluded, double_count_guard, notes, raw
        ) VALUES (
          ${id},
          ${accountId},
          NULL,
          ${fp},
          ${next},
          NULL,
          NULL,
          ${r.nombre},
          ${r.nombre},
          ${'cash_recurring'},
          ${amount},
          ${currency},
          ${amount_ars},
          ${amount_usd},
          ${r.category_id || null},
          ${'manual'},
          false,
          false,
          false,
          ${notes},
          ${JSON.stringify({ cash_recurring_id: r.id, next_due_at_create: next })}::jsonb
        )
        ON CONFLICT (account_id, fingerprint) DO NOTHING
        RETURNING id`;
      if (rows.length) created += 1;
      next = addOneMonth(next, day);
      advanced += 1;
      // Safety: never infinite-loop on bad dates
      if (advanced > 120) break;
    }

    await sql`
      UPDATE cash_recurring
      SET next_due = ${next}, actualizado = now()
      WHERE id = ${r.id}`;
  }

  return { created, advanced };
}
