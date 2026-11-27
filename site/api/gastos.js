import crypto from 'node:crypto';
import { db, guard, body } from './_lib.js';

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

async function fetchResumen(sql, account_id, month) {
  if (account_id && month) {
    return sql`
      SELECT
        to_char(fecha, 'YYYY-MM') AS month,
        currency,
        COALESCE(SUM(CASE WHEN NOT is_excluded AND amount < 0 THEN amount ELSE 0 END), 0) AS spend,
        COALESCE(SUM(CASE WHEN NOT is_excluded AND amount > 0 THEN amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN is_excluded THEN amount ELSE 0 END), 0) AS excluded,
        COALESCE(SUM(CASE WHEN double_count_guard THEN amount ELSE 0 END), 0) AS guarded_merpago,
        COUNT(*)::int AS n
      FROM transactions
      WHERE account_id = ${account_id} AND to_char(fecha, 'YYYY-MM') = ${month}
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`;
  }
  if (account_id) {
    return sql`
      SELECT
        to_char(fecha, 'YYYY-MM') AS month,
        currency,
        COALESCE(SUM(CASE WHEN NOT is_excluded AND amount < 0 THEN amount ELSE 0 END), 0) AS spend,
        COALESCE(SUM(CASE WHEN NOT is_excluded AND amount > 0 THEN amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN is_excluded THEN amount ELSE 0 END), 0) AS excluded,
        COALESCE(SUM(CASE WHEN double_count_guard THEN amount ELSE 0 END), 0) AS guarded_merpago,
        COUNT(*)::int AS n
      FROM transactions
      WHERE account_id = ${account_id}
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`;
  }
  if (month) {
    return sql`
      SELECT
        to_char(fecha, 'YYYY-MM') AS month,
        currency,
        COALESCE(SUM(CASE WHEN NOT is_excluded AND amount < 0 THEN amount ELSE 0 END), 0) AS spend,
        COALESCE(SUM(CASE WHEN NOT is_excluded AND amount > 0 THEN amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN is_excluded THEN amount ELSE 0 END), 0) AS excluded,
        COALESCE(SUM(CASE WHEN double_count_guard THEN amount ELSE 0 END), 0) AS guarded_merpago,
        COUNT(*)::int AS n
      FROM transactions
      WHERE to_char(fecha, 'YYYY-MM') = ${month}
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`;
  }
  return sql`
    SELECT
      to_char(fecha, 'YYYY-MM') AS month,
      currency,
      COALESCE(SUM(CASE WHEN NOT is_excluded AND amount < 0 THEN amount ELSE 0 END), 0) AS spend,
      COALESCE(SUM(CASE WHEN NOT is_excluded AND amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN is_excluded THEN amount ELSE 0 END), 0) AS excluded,
      COALESCE(SUM(CASE WHEN double_count_guard THEN amount ELSE 0 END), 0) AS guarded_merpago,
      COUNT(*)::int AS n
    FROM transactions
    GROUP BY 1, 2 ORDER BY 1 DESC, 2
    LIMIT 48`;
}

async function fetchByCategory(sql, account_id, month) {
  if (account_id && month) {
    return sql`
      SELECT COALESCE(c.nombre, 'Sin categoría') AS category, t.currency,
        COALESCE(SUM(t.amount), 0) AS total, COUNT(*)::int AS n
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE NOT t.is_excluded
        AND t.account_id = ${account_id}
        AND to_char(t.fecha, 'YYYY-MM') = ${month}
      GROUP BY 1, 2 ORDER BY total ASC`;
  }
  if (month) {
    return sql`
      SELECT COALESCE(c.nombre, 'Sin categoría') AS category, t.currency,
        COALESCE(SUM(t.amount), 0) AS total, COUNT(*)::int AS n
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE NOT t.is_excluded
        AND to_char(t.fecha, 'YYYY-MM') = ${month}
      GROUP BY 1, 2 ORDER BY total ASC`;
  }
  if (account_id) {
    return sql`
      SELECT COALESCE(c.nombre, 'Sin categoría') AS category, t.currency,
        COALESCE(SUM(t.amount), 0) AS total, COUNT(*)::int AS n
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE NOT t.is_excluded AND t.account_id = ${account_id}
      GROUP BY 1, 2 ORDER BY total ASC
      LIMIT 40`;
  }
  return sql`
    SELECT COALESCE(c.nombre, 'Sin categoría') AS category, t.currency,
      COALESCE(SUM(t.amount), 0) AS total, COUNT(*)::int AS n
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE NOT t.is_excluded
    GROUP BY 1, 2 ORDER BY total ASC
    LIMIT 40`;
}

async function fetchTxs(sql, account_id, month, includeExcluded) {
  if (account_id && month) {
    return includeExcluded
      ? sql`
          SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.descripcion, t.merchant,
                 t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id,
                 t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
                 c.nombre AS category_nombre, a.nombre AS account_nombre
          FROM transactions t
          LEFT JOIN categories c ON c.id = t.category_id
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.account_id = ${account_id} AND to_char(t.fecha, 'YYYY-MM') = ${month}
          ORDER BY t.fecha DESC, t.id DESC LIMIT 500`
      : sql`
          SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.descripcion, t.merchant,
                 t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id,
                 t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
                 c.nombre AS category_nombre, a.nombre AS account_nombre
          FROM transactions t
          LEFT JOIN categories c ON c.id = t.category_id
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.account_id = ${account_id} AND to_char(t.fecha, 'YYYY-MM') = ${month}
            AND NOT t.is_excluded
          ORDER BY t.fecha DESC, t.id DESC LIMIT 500`;
  }
  if (account_id) {
    return includeExcluded
      ? sql`
          SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.descripcion, t.merchant,
                 t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id,
                 t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
                 c.nombre AS category_nombre, a.nombre AS account_nombre
          FROM transactions t
          LEFT JOIN categories c ON c.id = t.category_id
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.account_id = ${account_id}
          ORDER BY t.fecha DESC, t.id DESC LIMIT 500`
      : sql`
          SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.descripcion, t.merchant,
                 t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id,
                 t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
                 c.nombre AS category_nombre, a.nombre AS account_nombre
          FROM transactions t
          LEFT JOIN categories c ON c.id = t.category_id
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.account_id = ${account_id} AND NOT t.is_excluded
          ORDER BY t.fecha DESC, t.id DESC LIMIT 500`;
  }
  if (month) {
    return includeExcluded
      ? sql`
          SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.descripcion, t.merchant,
                 t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id,
                 t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
                 c.nombre AS category_nombre, a.nombre AS account_nombre
          FROM transactions t
          LEFT JOIN categories c ON c.id = t.category_id
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE to_char(t.fecha, 'YYYY-MM') = ${month}
          ORDER BY t.fecha DESC, t.id DESC LIMIT 500`
      : sql`
          SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.descripcion, t.merchant,
                 t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id,
                 t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
                 c.nombre AS category_nombre, a.nombre AS account_nombre
          FROM transactions t
          LEFT JOIN categories c ON c.id = t.category_id
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE to_char(t.fecha, 'YYYY-MM') = ${month} AND NOT t.is_excluded
          ORDER BY t.fecha DESC, t.id DESC LIMIT 500`;
  }
  return includeExcluded
    ? sql`
        SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.descripcion, t.merchant,
               t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id,
               t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
               c.nombre AS category_nombre, a.nombre AS account_nombre
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN accounts a ON a.id = t.account_id
        ORDER BY t.fecha DESC, t.id DESC LIMIT 500`
    : sql`
        SELECT t.id, t.account_id, t.import_id, t.fingerprint, t.fecha, t.descripcion, t.merchant,
               t.tx_type, t.amount, t.currency, t.amount_ars, t.amount_usd, t.category_id,
               t.is_internal_transfer, t.is_excluded, t.double_count_guard, t.notes,
               c.nombre AS category_nombre, a.nombre AS account_nombre
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE NOT t.is_excluded
        ORDER BY t.fecha DESC, t.id DESC LIMIT 500`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  const sql = db();

  if (req.method === 'GET') {
    const q = req.query || {};
    const view = typeof q.view === 'string' ? q.view : 'movimientos';
    const account_id = typeof q.account_id === 'string' && q.account_id ? q.account_id : null;
    const month = typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month) ? q.month : null;
    const includeExcluded = q.include_excluded === '1';

    const [accounts, categories, rules, imports] = await Promise.all([
      sql`SELECT id, nombre, tipo, moneda_default, activo, orden FROM accounts WHERE activo = true ORDER BY orden, id`,
      sql`SELECT id, nombre, color, orden, activo FROM categories WHERE activo = true ORDER BY orden, id`,
      sql`SELECT id, pattern, category_id, account_id, priority, exclude_expense, activo FROM category_rules ORDER BY priority ASC, id ASC`,
      sql`SELECT id, account_id, filename, file_hash, source_format, status, summary, creado, confirmado_en FROM imports ORDER BY creado DESC LIMIT 30`,
    ]);

    if (view === 'meta') {
      return res.status(200).json({ accounts, categories, rules, imports });
    }

    if (view === 'resumen') {
      const [resumen, by_category] = await Promise.all([
        fetchResumen(sql, account_id, month),
        fetchByCategory(sql, account_id, month),
      ]);
      return res.status(200).json({ accounts, categories, rules, imports, resumen, by_category });
    }

    const transactions = await fetchTxs(sql, account_id, month, includeExcluded);
    return res.status(200).json({ accounts, categories, rules, imports, transactions });
  }

  if (req.method === 'PATCH') {
    const b = body(req);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return res.status(400).json({ error: 'id' });

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

    const rows = await sql`
      UPDATE transactions SET
        category_id = CASE WHEN ${hasCat} THEN ${hasCat ? category_id : null} ELSE category_id END,
        is_excluded = COALESCE(${is_excluded}, is_excluded),
        is_internal_transfer = COALESCE(${is_internal_transfer}, is_internal_transfer),
        notes = CASE WHEN ${hasNotes} THEN ${hasNotes ? notes : null} ELSE notes END,
        actualizado = now()
      WHERE id = ${id}
      RETURNING id, account_id, category_id, is_excluded, is_internal_transfer, notes, amount, currency, fecha, merchant, descripcion`;
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json(rows[0]);
  }

  if (req.method === 'POST') {
    const b = body(req);
    if (b.entity === 'rule') {
      const pattern = typeof b.pattern === 'string' ? b.pattern.trim().slice(0, 200) : '';
      if (!pattern) return res.status(400).json({ error: 'pattern' });
      const id = typeof b.id === 'string' && b.id ? b.id : slugId('rule', pattern);
      const category_id = typeof b.category_id === 'string' ? b.category_id : null;
      const account_id = typeof b.account_id === 'string' ? b.account_id : null;
      const priority =
        typeof b.priority === 'number' && Number.isFinite(b.priority) ? Math.trunc(b.priority) : 100;
      const exclude_expense = !!b.exclude_expense;
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
      const orden =
        typeof b.orden === 'number' && Number.isFinite(b.orden) ? Math.trunc(b.orden) : 100;
      const rows = await sql`
        INSERT INTO categories (id, nombre, orden)
        VALUES (${id}, ${nombre}, ${orden})
        ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre
        RETURNING id, nombre, color, orden, activo`;
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
    return res.status(400).json({ error: 'entity' });
  }

  return res.status(405).end();
}
