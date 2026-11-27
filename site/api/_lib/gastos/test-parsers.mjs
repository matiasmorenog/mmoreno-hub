import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import XLSX from 'xlsx';
import { parseMpAccountStatement } from './mp-account.js';
import { parseSantanderCajaXlsx } from './santander-caja.js';
import {
  detectSantanderCardKind,
  parseSantanderCardText,
} from './santander-card.js';
import { detectMpCardPdf, parseMpCardText } from './mp-card.js';
import { applyRules } from './rules.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(dir, 'fixtures');

test('mp account_statement parses summary and own transfer exclude', () => {
  const csv = fs.readFileSync(path.join(fixtures, 'mp-account-sample.csv'), 'utf8');
  const parsed = parseMpAccountStatement(csv);
  assert.equal(parsed.source_format, 'mp_account_statement');
  assert.equal(parsed.txs.length, 4);
  assert.equal(parsed.summary.balance_check_ok, true);
  const own = parsed.txs.find((t) => /Moreno Matias/i.test(t.descripcion));
  assert.ok(own);
  assert.equal(own.is_internal_transfer, true);
  assert.equal(own.is_excluded, true);
  const third = parsed.txs.find((t) => /Persona Tercera/i.test(t.descripcion));
  assert.ok(third);
  assert.equal(third.is_excluded, false);
  const qr = parsed.txs.find((t) => t.tx_type === 'pago_qr');
  assert.equal(qr.merchant, 'Cafe Demo');
});

test('santander caja xlsx synthetic', () => {
  const aoa = [
    [],
    ['', 'Cuenta', 'Cuenta única DEMO'],
    [],
    ['', 'Fecha', 'Sucursal origen', 'Descripción', 'Referencia', 'Caja de Ahorro', 'Cuenta Corriente', 'Saldo'],
    ['', '10/10/2026', '000 - DEMO', 'Transferencia a Tercero Demo', '000001001', '-1500.00', '', '500.00'],
    ['', '11/10/2026', '000 - DEMO', 'Deposito de efectivo', '000001002', '2000.00', '', '2500.00'],
    ['', '12/10/2026', '000 - DEMO', 'Impuesto ley demo', '000001003', '', '-3.50', '2496.50'],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'UltimosMovimientos');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const parsed = parseSantanderCajaXlsx(buf);
  assert.equal(parsed.txs.length, 3);
  assert.equal(parsed.txs[0].amount, -1500);
  assert.equal(parsed.txs[2].amount, -3.5);
});

test('santander amex merpago double-count guard', () => {
  const text = fs.readFileSync(path.join(fixtures, 'santander-card-sample.txt'), 'utf8');
  const parsed = parseSantanderCardText(text, {
    account_id: 'santander_amex',
    source_format: 'santander_amex_pdf',
  });
  assert.ok(parsed.txs.length >= 2);
  const mer = parsed.txs.find((t) => /Merpago/i.test(t.descripcion));
  assert.ok(mer);
  assert.equal(mer.double_count_guard, true);
  assert.equal(mer.is_excluded, true);
  const cafe = parsed.txs.find((t) => /Cafe Demo/i.test(t.descripcion));
  assert.ok(cafe);
  assert.equal(cafe.is_excluded, false);
});

test('mp card print-pdf emits one tx per kind pair, skips summary totals', () => {
  const text = fs.readFileSync(path.join(fixtures, 'mp-card-sample.txt'), 'utf8');
  assert.equal(detectMpCardPdf(text), true);
  const parsed = parseMpCardText(text, { yearHint: 2026 });
  // 4 kind-backed rows; the naked "Saldo $ 999.999,00" must NOT become a tx
  assert.equal(parsed.txs.length, 4);
  assert.ok(!parsed.txs.some((t) => Math.abs(t.amount) === 999999));
  assert.ok(parsed.warnings.includes('mp_card_print_pdf_fragile'));
  const refund = parsed.txs.find((t) => /Reembolso/i.test(t.tx_type));
  assert.ok(refund);
  assert.ok(refund.amount > 0);
  const usd = parsed.txs.find((t) => t.currency === 'USD');
  assert.ok(usd);
});

test('santander card text is not detected as mp card', () => {
  const text = fs.readFileSync(path.join(fixtures, 'santander-card-sample.txt'), 'utf8');
  assert.equal(detectMpCardPdf(text), false);
  assert.equal(detectSantanderCardKind(text), 'santander_amex');
});

test('per-row rules: different merchants get different categories; Consumo rule does not paint all', () => {
  const text = fs.readFileSync(path.join(fixtures, 'mp-card-sample.txt'), 'utf8');
  const parsed = parseMpCardText(text, { yearHint: 2026 });
  assert.ok(parsed.txs.length >= 3);

  const ruled = applyRules(parsed.txs, [
    // Broad trap: used to match every row via tx_type "consumo"
    { id: 'trap-consumo', pattern: 'Consumo', category_id: 'comida', account_id: null, priority: 50, exclude_expense: false, activo: true },
    { id: 'ypf', pattern: 'YPF', category_id: 'transporte', account_id: null, priority: 10, exclude_expense: false, activo: true },
    { id: 'cafe', pattern: 'Cafe', category_id: 'comida', account_id: null, priority: 10, exclude_expense: false, activo: true },
    { id: 'cloud', pattern: 'Cloud', category_id: 'suscripciones', account_id: null, priority: 10, exclude_expense: false, activo: true },
  ]);

  const byMerchant = Object.fromEntries(ruled.map((t) => [t.merchant, t.category_id]));
  assert.equal(byMerchant['Cafe Demo'], 'comida');
  assert.equal(byMerchant['YPF Demo'], 'transporte');
  assert.equal(byMerchant['Cloud Demo'], 'suscripciones');
  // Refund Demo: no merchant rule; "Consumo" must NOT match via tx_type/descripcion prefix alone
  const refund = ruled.find((t) => /Refund Demo/i.test(t.merchant));
  assert.ok(refund);
  assert.equal(refund.category_id, null);

  const cats = new Set(ruled.map((t) => t.category_id).filter(Boolean));
  assert.ok(cats.size >= 3, 'expected multiple distinct categories in one statement');
});

test('applyRules category pattern on wallet row', () => {
  const txs = [
    {
      account_id: 'mp_wallet',
      merchant: 'YPF Demo',
      descripcion: 'Pago con QR YPF Demo',
      tx_type: 'pago_qr',
      category_id: null,
      is_excluded: false,
      is_internal_transfer: false,
      double_count_guard: false,
    },
  ];
  const out = applyRules(txs, [
    { id: 'r1', pattern: 'YPF', category_id: 'transporte', account_id: null, priority: 10, exclude_expense: false, activo: true },
  ]);
  assert.equal(out[0].category_id, 'transporte');
});
