import crypto from 'node:crypto';
import { db, guard, body } from './_lib.js';
import {
  learnPatternFromTx,
  normalizeRulePattern,
  rulePatternKey,
  CAT_SRC_MANUAL,
  CAT_SRC_RULE,
} from './_lib/gastos/rules.js';
import { fingerprint, newId } from './_lib/gastos/fingerprint.js';
import {
  CASH_ACCOUNT_ID,
  clampDayOfMonth,
  defaultNextDue,
  materializeDueCash,
  todayISO,
  toDateISO,
} from './_lib/gastos/cash.js';

function slugId(prefix, nombre) {
  const base =
    String(nombre)
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'x';
  return `${prefix}_${base}_${crypto.randomBytes(2).toString('hex')}`;
}

function learnedRuleId(accountId, pattern) {
  const key = rulePatternKey(pattern);
  const h = crypto.createHash('sha256').update(`${accountId || ''}|${key}`).digest('hex').slice(0, 12);
  const slug = String(key)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'm';
  return `learned_${slug}_${h}`.slice(0, 100);
}

/**
 * Own-account categories — never spend/income in Resumen.
 * Avoid `NOT IN ${array}` (Neon serverless → syntax error near $1).
 */
const CAT_OWN_TRANSFER = 'transferencias';
const CAT_OWN_MOV = 'cat_movimientos-cuenta-propia_f59c';

async function fetchResumen(sql, account_id, month) {
  // spend/income: not excluded, not internal transfer, not “cuenta propia” categories
  const accountFilter = account_id ? sql`AND account_id = ${account_id}` : sql``;
  const monthFilter = month ? sql`AND to_char(fecha, 'YYYY-MM') = ${month}` : sql``;
  const rows = await sql`
    SELECT
      to_char(fecha, 'YYYY-MM') AS month,
      currency,
      COALESCE(SUM(CASE
        WHEN NOT is_excluded
          AND NOT is_internal_transfer
          AND (category_id IS NULL
            OR (category_id <> ${CAT_OWN_TRANSFER} AND category_id <> ${CAT_OWN_MOV}))
          AND amount < 0
        THEN amount ELSE 0 END), 0) AS spend,
      COALESCE(SUM(CASE
        WHEN NOT is_excluded
          AND NOT is_internal_transfer
          AND (category_id IS NULL
            OR (category_id <> ${CAT_OWN_TRANSFER} AND category_id <> ${CAT_OWN_MOV}))
          AND amount > 0
        THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN is_excluded OR is_internal_transfer
        OR category_id = ${CAT_OWN_TRANSFER}
        OR category_id = ${CAT_OWN_MOV}
        THEN amount ELSE 0 END), 0) AS excluded,
      COALESCE(SUM(CASE WHEN double_count_guard THEN amount ELSE 0 END), 0) AS guarded_merpago,
      COUNT(*) FILTER (
        WHERE NOT is_excluded
          AND NOT is_internal_transfer
          AND (category_id IS NULL
            OR (category_id <> ${CAT_OWN_TRANSFER} AND category_id <> ${CAT_OWN_MOV}))
      )::int AS n
    FROM transactions
    WHERE true
      ${accountFilter}
      ${monthFilter}
    GROUP BY 1, 2 ORDER BY 1 DESC, 2`;
  return !account_id && !month ? rows.slice(0, 48) : rows;
}

async function fetchByCategory(sql, account_id, month) {
  const accountFilter = account_id ? sql`AND t.account_id = ${account_id}` : sql``;
  const monthFilter = month ? sql`AND to_char(t.fecha, 'YYYY-MM') = ${month}` : sql``;
  const rows = await sql`
    SELECT t.category_id, COALESCE(c.nombre, 'Sin categoría') AS category, t.currency,
      COALESCE(SUM(t.amount), 0) AS total, COUNT(*)::int AS n
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE NOT t.is_excluded
      AND NOT t.is_internal_transfer
      AND (t.category_id IS NULL
        OR (t.category_id <> ${CAT_OWN_TRANSFER} AND t.category_id <> ${CAT_OWN_MOV}))
      ${accountFilter}
      ${monthFilter}
    GROUP BY t.category_id, c.nombre, t.currency
    ORDER BY total ASC`;
  return !month ? rows.slice(0, 40) : rows;
}

/**
 * @param {{
 *   accountIds?: string[],
 *   month?: string|null,
 *   includeExcluded?: boolean,
 *   hourAutoOnly?: boolean,
 *   uncategorizedOnly?: boolean,
 *   categoryId?: string|null,
 *   flow?: 'ingresos'|'gastos'|null,
 *   q?: string|null,
 *   spendableOnly?: boolean,
 * }} f
 */
async function fetchTxs(sql, f = {}) {
  const accountIds = Array.isArray(f.accountIds) ? f.accountIds.filter(Boolean) : [];
  const month = f.month || null;
  const includeExcluded = !!f.includeExcluded;
  const hourAutoOnly = !!f.hourAutoOnly;
  const uncategorizedOnly = !!f.uncategorizedOnly;
  const categoryId = f.categoryId || null;
  const flow = f.flow === 'ingresos' || f.flow === 'gastos' ? f.flow : null;
  const spendableOnly = !!f.spendableOnly;
  const qRaw = typeof f.q === 'string' ? f.q.trim().slice(0, 80) : '';
  const qClean = qRaw.replace(/[%_\\]/g, '').trim();

  const accountFilter = accountIds.length
    ? sql`AND t.account_id IN ${accountIds}`
    : sql``;
  const monthFilter = month ? sql`AND to_char(t.fecha, 'YYYY-MM') = ${month}` : sql``;
  const excludedFilter = includeExcluded || spendableOnly ? sql`` : sql`AND NOT t.is_excluded`;
  const spendableFilter = spendableOnly
    ? sql`AND NOT t.is_excluded
          AND NOT t.is_internal_transfer
          AND (t.category_id IS NULL
            OR (t.category_id <> ${CAT_OWN_TRANSFER} AND t.category_id <> ${CAT_OWN_MOV}))`
    : sql``;
  const hourFilter = hourAutoOnly ? sql`AND t.category_source = 'hourly'` : sql``;
  const uncatFilter = uncategorizedOnly ? sql`AND t.category_id IS NULL` : sql``;
  const catFilter = categoryId && !uncategorizedOnly
    ? sql`AND t.category_id = ${categoryId}`
    : sql``;
  const flowFilter = flow === 'ingresos'
    ? sql`AND t.amount > 0`
    : flow === 'gastos'
      ? sql`AND t.amount < 0`
      : sql``;
  const like = qClean ? `%${qClean}%` : null;
  const textFilter = like
    ? sql`AND (t.merchant ILIKE ${like} OR t.descripcion ILIKE ${like})`
    : sql``;

  return sql`
    SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.posted_at, t.hora_local,
           t.descripcion, t.merchant,
           t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id, t.category_source,
           t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
           c.nombre AS category_nombre, a.nombre AS account_nombre
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE true
      ${accountFilter}
      ${monthFilter}
      ${excludedFilter}
      ${spendableFilter}
      ${hourFilter}
      ${uncatFilter}
      ${catFilter}
      ${flowFilter}
      ${textFilter}
    ORDER BY t.fecha DESC, t.id DESC
    LIMIT 500`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  const sql = db();

  if (req.method === 'GET') {
    const q = req.query || {};
    const view = typeof q.view === 'string' ? q.view : 'movimientos';
    const account_id = typeof q.account_id === 'string' && q.account_id ? q.account_id : null;
    const accountIdsRaw = typeof q.account_ids === 'string' ? q.account_ids : '';
    const accountIds = accountIdsRaw
      ? accountIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : (account_id ? [account_id] : []);
    const month = typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month) ? q.month : null;
    const includeExcluded = q.include_excluded === '1';
    const hourAutoOnly = q.hour_auto === '1' || q.category_source === 'hourly';
    const uncategorizedOnly = q.uncategorized === '1' || q.sin_clasificar === '1';
    const categoryId = typeof q.category_id === 'string' && q.category_id ? q.category_id : null;
    const flow = q.flow === 'ingresos' || q.flow === 'gastos' ? q.flow : null;
    const textQ = typeof q.q === 'string' ? q.q : (typeof q.search === 'string' ? q.search : '');
    const spendableOnly = q.spendable_only === '1' || q.spendable === '1';

    const [accounts, categories, rules, imports] = await Promise.all([
      sql`SELECT id, nombre, tipo, moneda_default, activo, orden FROM accounts WHERE activo = true ORDER BY orden, id`,
      sql`SELECT id, nombre, color, orden, activo FROM categories WHERE activo = true ORDER BY orden, id`,
      sql`SELECT id, pattern, category_id, account_id, priority, exclude_expense, activo FROM category_rules ORDER BY priority ASC, id ASC`,
      sql`SELECT id, account_id, filename, file_hash, source_format, status, summary, creado, confirmado_en FROM imports ORDER BY creado DESC LIMIT 30`,
    ]);

    if (view === 'meta') {
      return res.status(200).json({ accounts, categories, rules, imports });
    }

    if (view === 'efectivo') {
      let matured = { created: 0, advanced: 0 };
      try {
        matured = await materializeDueCash(sql, { fingerprint, newId });
      } catch (err) {
        // Never block the fijos list on materialize failure.
        console.error('cash_materialize_failed', err?.message || err);
        matured = { created: 0, advanced: 0, error: String(err?.message || err) };
      }
      const [recurringRows, cashTxRows] = await Promise.all([
        sql`
          SELECT r.id, r.nombre, r.amount, r.currency, r.category_id, r.notes,
                 r.day_of_month, r.next_due, r.activo, r.account_id, r.creado, r.actualizado,
                 c.nombre AS category_nombre
          FROM cash_recurring r
          LEFT JOIN categories c ON c.id = r.category_id
          ORDER BY r.activo DESC, r.next_due ASC, r.nombre ASC`,
        sql`
          SELECT t.id, t.fecha, t.amount, t.currency, t.descripcion, t.merchant, t.notes,
                 t.category_id, t.tx_type, t.category_source, c.nombre AS category_nombre
          FROM transactions t
          LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.account_id = ${CASH_ACCOUNT_ID}
          ORDER BY t.fecha DESC, t.id DESC
          LIMIT 80`,
      ]);
      // Normalize date fields so UI never sees Date→locale string junk.
      const recurring = recurringRows.map((r) => ({
        ...r,
        next_due: toDateISO(r.next_due) || r.next_due,
      }));
      const cash_txs = cashTxRows.map((t) => ({
        ...t,
        fecha: toDateISO(t.fecha) || t.fecha,
      }));
      return res.status(200).json({
        accounts,
        categories,
        rules,
        imports,
        recurring,
        cash_txs,
        matured,
        today: todayISO(),
      });
    }

    if (view === 'resumen') {
      const resumenAccount = accountIds.length === 1 ? accountIds[0] : account_id;
      const [resumen, by_category] = await Promise.all([
        fetchResumen(sql, resumenAccount, month),
        fetchByCategory(sql, resumenAccount, month),
      ]);
      return res.status(200).json({ accounts, categories, rules, imports, resumen, by_category });
    }

    const transactions = await fetchTxs(sql, {
      accountIds,
      month,
      includeExcluded,
      hourAutoOnly,
      uncategorizedOnly,
      categoryId,
      flow,
      q: textQ,
      spendableOnly,
    });
    return res.status(200).json({ accounts, categories, rules, imports, transactions });
  }

  if (req.method === 'PATCH') {
    const b = body(req);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return res.status(400).json({ error: 'id' });

    if (b.entity === 'cash_recurring') {
      const hasActivo = typeof b.activo === 'boolean';
      const hasAmount = Object.prototype.hasOwnProperty.call(b, 'amount');
      const hasDay = Object.prototype.hasOwnProperty.call(b, 'day_of_month') ||
        Object.prototype.hasOwnProperty.call(b, 'dia');
      const hasNext = typeof b.next_due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.next_due);
      const hasNombre = typeof b.nombre === 'string';
      const hasCatR = Object.prototype.hasOwnProperty.call(b, 'category_id');
      const hasNotes = Object.prototype.hasOwnProperty.call(b, 'notes');
      const nombre = hasNombre ? b.nombre.trim().slice(0, 120) : null;
      if (hasNombre && !nombre) return res.status(400).json({ error: 'nombre' });
      let amount = null;
      if (hasAmount) {
        const raw = Number(b.amount);
        if (!Number.isFinite(raw) || raw === 0) return res.status(400).json({ error: 'amount' });
        amount = Math.abs(raw);
      }
      const day_of_month = hasDay
        ? clampDayOfMonth(b.day_of_month ?? b.dia)
        : null;
      const category_id = hasCatR
        ? (typeof b.category_id === 'string' && b.category_id ? b.category_id : null)
        : undefined;
      const notes = hasNotes
        ? (typeof b.notes === 'string' ? b.notes.trim().slice(0, 2000) || null : null)
        : undefined;
      const rows = await sql`
        UPDATE cash_recurring SET
          nombre = COALESCE(${hasNombre ? nombre : null}, nombre),
          amount = COALESCE(${hasAmount ? amount : null}, amount),
          day_of_month = COALESCE(${hasDay ? day_of_month : null}, day_of_month),
          next_due = CASE WHEN ${hasNext} THEN ${hasNext ? b.next_due : null} ELSE next_due END,
          category_id = CASE WHEN ${hasCatR} THEN ${hasCatR ? category_id : null} ELSE category_id END,
          notes = CASE WHEN ${hasNotes} THEN ${hasNotes ? notes : null} ELSE notes END,
          activo = COALESCE(${hasActivo ? b.activo : null}, activo),
          actualizado = now()
        WHERE id = ${id}
        RETURNING id, nombre, amount, currency, category_id, notes, day_of_month, next_due, activo, account_id`;
      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json(rows[0]);
    }

    const hasCat = Object.prototype.hasOwnProperty.call(b, 'category_id');
    const category_id = hasCat
      ? (typeof b.category_id === 'string' ? b.category_id : null)
      : undefined;
    const is_excluded = typeof b.is_excluded === 'boolean' ? b.is_excluded : null;
    const is_internal_transfer =
      typeof b.is_internal_transfer === 'boolean' ? b.is_internal_transfer : null;
    const hasNotes = Object.prototype.hasOwnProperty.call(b, 'notes');
    const notes = hasNotes
      ? (typeof b.notes === 'string' ? b.notes.trim().slice(0, 2000) || null : null)
      : undefined;
    const learn = b.learn === true; // only when UI confirmed “aplicar siempre”

    const catSource = hasCat
      ? (category_id ? CAT_SRC_MANUAL : null)
      : undefined;

    const rows = await sql`
      UPDATE transactions SET
        category_id = CASE WHEN ${hasCat} THEN ${hasCat ? category_id : null} ELSE category_id END,
        category_source = CASE WHEN ${hasCat} THEN ${hasCat ? catSource : null} ELSE category_source END,
        is_excluded = COALESCE(${is_excluded}, is_excluded),
        is_internal_transfer = COALESCE(${is_internal_transfer}, is_internal_transfer),
        notes = CASE WHEN ${hasNotes} THEN ${hasNotes ? notes : null} ELSE notes END,
        actualizado = now()
      WHERE id = ${id}
      RETURNING id, account_id, category_id, category_source, is_excluded, is_internal_transfer, notes, amount, currency, fecha, merchant, descripcion, tx_type`;
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const tx = rows[0];

    let learned = null;
    let propagated = 0;
    if (learn && hasCat && category_id) {
      const pattern = normalizeRulePattern(learnPatternFromTx(tx) || '');
      if (pattern && pattern.length >= 3) {
        // Learned rules apply to all accounts (account_id null), same as UI default.
        const ruleId = learnedRuleId(null, pattern);
        const ruleRows = await sql`
          INSERT INTO category_rules (id, pattern, category_id, account_id, priority, exclude_expense, activo)
          VALUES (${ruleId}, ${pattern}, ${category_id}, NULL, 40, false, true)
          ON CONFLICT (id) DO UPDATE SET
            pattern = EXCLUDED.pattern,
            category_id = EXCLUDED.category_id,
            account_id = NULL,
            actualizado = now(),
            activo = true
          RETURNING id, pattern, category_id, account_id, priority, exclude_expense, activo`;
        learned = ruleRows[0] || null;
        // Apply to uncategorized OR hourly-auto matches — never overwrite other manual/rule.
        // ILIKE is case-insensitive (Moreno ≡ MORENO). All accounts.
        const like = `%${pattern}%`;
        const prop = await sql`
          UPDATE transactions SET
            category_id = ${category_id},
            category_source = ${CAT_SRC_RULE},
            actualizado = now()
          WHERE id <> ${tx.id}
            AND (
              category_id IS NULL
              OR category_source = 'hourly'
            )
            AND (
              merchant ILIKE ${like}
              OR descripcion ILIKE ${like}
            )
          RETURNING id`;
        propagated = prop.length;
      }
    }

    return res.status(200).json({ ...tx, learned_rule: learned, propagated });
  }

  if (req.method === 'POST') {
    const b = body(req);
    if (b.entity === 'rule') {
      const pattern = normalizeRulePattern(typeof b.pattern === 'string' ? b.pattern : '');
      if (!pattern) return res.status(400).json({ error: 'pattern' });
      const category_id = typeof b.category_id === 'string' && b.category_id ? b.category_id : null;
      // Empty / missing → all accounts (null). Never invent a default account.
      const account_id =
        typeof b.account_id === 'string' && b.account_id.trim() ? b.account_id.trim() : null;
      const priority =
        typeof b.priority === 'number' && Number.isFinite(b.priority) ? Math.trunc(b.priority) : 100;
      const exclude_expense = !!b.exclude_expense;
      const pkey = rulePatternKey(pattern);
      const acctKey = account_id || '';
      // Reuse existing row when pattern matches case-insensitively (same account scope).
      let id = typeof b.id === 'string' && b.id ? b.id : '';
      if (!id) {
        const existing = await sql`
          SELECT id FROM category_rules
          WHERE LOWER(TRIM(regexp_replace(pattern, '\\s+', ' ', 'g'))) = ${pkey}
            AND COALESCE(account_id, '') = ${acctKey}
          ORDER BY id ASC
          LIMIT 1`;
        id = existing[0]?.id || slugId('rule', pattern);
      }
      const rows = await sql`
        INSERT INTO category_rules (id, pattern, category_id, account_id, priority, exclude_expense, activo)
        VALUES (${id}, ${pattern}, ${category_id}, ${account_id}, ${priority}, ${exclude_expense}, true)
        ON CONFLICT (id) DO UPDATE SET
          pattern = EXCLUDED.pattern,
          category_id = EXCLUDED.category_id,
          account_id = EXCLUDED.account_id,
          priority = EXCLUDED.priority,
          exclude_expense = EXCLUDED.exclude_expense,
          actualizado = now()
        RETURNING id, pattern, category_id, account_id, priority, exclude_expense, activo`;
      return res.status(201).json(rows[0]);
    }
    if (b.entity === 'category') {
      const nombre = typeof b.nombre === 'string' ? b.nombre.trim().slice(0, 80) : '';
      if (!nombre) return res.status(400).json({ error: 'nombre' });
      const id = typeof b.id === 'string' && b.id ? b.id : slugId('cat', nombre);
      const hasOrden = typeof b.orden === 'number' && Number.isFinite(b.orden);
      const orden = hasOrden ? Math.trunc(b.orden) : 100;
      const rows = await sql`
        INSERT INTO categories (id, nombre, orden)
        VALUES (${id}, ${nombre}, ${orden})
        ON CONFLICT (id) DO UPDATE SET
          nombre = EXCLUDED.nombre,
          orden = CASE WHEN ${hasOrden} THEN EXCLUDED.orden ELSE categories.orden END
        RETURNING id, nombre, color, orden, activo`;
      return res.status(201).json(rows[0]);
    }

    if (b.entity === 'cash_tx') {
      const fecha =
        typeof b.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha)
          ? b.fecha
          : todayISO();
      const rawAmt = Number(b.amount);
      if (!Number.isFinite(rawAmt) || rawAmt === 0) {
        return res.status(400).json({ error: 'amount' });
      }
      // UI enters positive expense → store negative.
      const amount = rawAmt > 0 ? -Math.abs(rawAmt) : rawAmt;
      const currency = b.currency === 'USD' ? 'USD' : 'ARS';
      const category_id =
        typeof b.category_id === 'string' && b.category_id ? b.category_id : null;
      const notes =
        typeof b.notes === 'string' ? b.notes.trim().slice(0, 2000) || null : null;
      const descripcion =
        typeof b.descripcion === 'string'
          ? b.descripcion.trim().slice(0, 200) || null
          : notes;
      const merchant =
        typeof b.merchant === 'string'
          ? b.merchant.trim().slice(0, 120) || 'Efectivo'
          : 'Efectivo';
      const id = newId('cash');
      // Unique fingerprint per entry (manual cash can repeat same day/amount).
      const fp = fingerprint(['cash_manual', id, fecha, amount, currency, category_id || '', notes || '']);
      const amount_ars = currency === 'ARS' ? amount : null;
      const amount_usd = currency === 'USD' ? amount : null;
      const rows = await sql`
        INSERT INTO transactions (
          id, account_id, import_id, fingerprint, fecha, posted_at, hora_local,
          descripcion, merchant, tx_type,
          amount, currency, amount_ars, amount_usd, category_id, category_source,
          is_internal_transfer, is_excluded, double_count_guard, notes, raw
        ) VALUES (
          ${id},
          ${CASH_ACCOUNT_ID},
          NULL,
          ${fp},
          ${fecha},
          NULL,
          NULL,
          ${descripcion},
          ${merchant},
          ${'cash'},
          ${amount},
          ${currency},
          ${amount_ars},
          ${amount_usd},
          ${category_id},
          ${CAT_SRC_MANUAL},
          false,
          false,
          false,
          ${notes},
          ${JSON.stringify({ source: 'cash_manual' })}::jsonb
        )
        RETURNING id, account_id, fecha, amount, currency, descripcion, merchant,
                  category_id, category_source, notes, tx_type`;
      return res.status(201).json(rows[0]);
    }

    if (b.entity === 'cash_recurring') {
      const nombre = typeof b.nombre === 'string' ? b.nombre.trim().slice(0, 120) : '';
      if (!nombre) return res.status(400).json({ error: 'nombre' });
      const rawAmt = Number(b.amount);
      if (!Number.isFinite(rawAmt) || rawAmt === 0) {
        return res.status(400).json({ error: 'amount' });
      }
      // Store positive magnitude; materialize signs as expense.
      const amount = Math.abs(rawAmt);
      const currency = b.currency === 'USD' ? 'USD' : 'ARS';
      const category_id =
        typeof b.category_id === 'string' && b.category_id ? b.category_id : null;
      const notes =
        typeof b.notes === 'string' ? b.notes.trim().slice(0, 2000) || null : null;
      const day_of_month = clampDayOfMonth(b.day_of_month ?? b.dia ?? 1);
      const next_due =
        typeof b.next_due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.next_due)
          ? b.next_due
          : defaultNextDue(day_of_month);
      const id = typeof b.id === 'string' && b.id ? b.id : slugId('cashrec', nombre);
      const rows = await sql`
        INSERT INTO cash_recurring (
          id, nombre, amount, currency, category_id, notes, day_of_month, next_due, activo, account_id
        ) VALUES (
          ${id}, ${nombre}, ${amount}, ${currency}, ${category_id}, ${notes},
          ${day_of_month}, ${next_due}, true, ${CASH_ACCOUNT_ID}
        )
        ON CONFLICT (id) DO UPDATE SET
          nombre = EXCLUDED.nombre,
          amount = EXCLUDED.amount,
          currency = EXCLUDED.currency,
          category_id = EXCLUDED.category_id,
          notes = EXCLUDED.notes,
          day_of_month = EXCLUDED.day_of_month,
          next_due = EXCLUDED.next_due,
          activo = true,
          actualizado = now()
        RETURNING id, nombre, amount, currency, category_id, notes, day_of_month, next_due, activo, account_id`;
      return res.status(201).json(rows[0]);
    }

    return res.status(400).json({ error: 'entity' });
  }

  if (req.method === 'DELETE') {
    const b = body(req);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return res.status(400).json({ error: 'id' });
    if (b.entity === 'rule') {
      const rows = await sql`DELETE FROM category_rules WHERE id = ${id} RETURNING id`;
      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ deleted: rows[0].id });
    }
    if (b.entity === 'cash_recurring') {
      const rows = await sql`DELETE FROM cash_recurring WHERE id = ${id} RETURNING id`;
      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ deleted: rows[0].id });
    }
    if (b.entity === 'cash_tx') {
      const rows = await sql`
        DELETE FROM transactions
        WHERE id = ${id} AND account_id = ${CASH_ACCOUNT_ID}
        RETURNING id`;
      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ deleted: rows[0].id });
    }
    return res.status(400).json({ error: 'entity' });
  }

  return res.status(405).end();
}
