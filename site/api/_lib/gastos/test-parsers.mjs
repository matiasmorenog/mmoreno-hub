import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import XLSX from 'xlsx';
import { parseMpAccountStatement } from './mp-account.js';
import {
  detectMpSettlement,
  joinSettlementTimes,
  parseMpSettlement,
} from './mp-settlement.js';
import { parseExpenseFile } from './parse.js';
import { parseSantanderCajaXlsx } from './santander-caja.js';
import {
  detectSantanderCardKind,
  parseSantanderCardText,
} from './santander-card.js';
import { detectMpCardPdf, parseMpCardText } from './mp-card.js';
import {
  applyRules,
  learnPatternFromTx,
  CAT_UBER_DIDI,
  CAT_PEAJES,
  CAT_RENDIMIENTOS,
  CAT_SRC_HOURLY,
  CAT_SRC_RULE,
  CAT_SRC_BUILTIN,
  CAT_SRC_MANUAL,
  CAT_SRC_HISTORY,
  normalizeMerchantKey,
  buildMerchantHistoryMap,
} from './rules.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(dir, 'fixtures');

const SEED_RULES = [
  { id: 'mp-dlocal-uber-didi', pattern: 'DLOCAL', category_id: CAT_UBER_DIDI, account_id: 'mp_wallet', priority: 8, exclude_expense: false, activo: true },
  { id: 'mp-rendimientos', pattern: 'Rendimientos', category_id: CAT_RENDIMIENTOS, account_id: 'mp_wallet', priority: 9, exclude_expense: false, activo: true },
  { id: 'amex-peaje-ausol', pattern: 'ausol', category_id: CAT_PEAJES, account_id: 'santander_amex', priority: 6, exclude_expense: false, activo: true },
];

test('mp account_statement parses summary and own transfer exclude', () => {
  const csv = fs.readFileSync(path.join(fixtures, 'mp-account-sample.csv'), 'utf8');
  const parsed = parseMpAccountStatement(csv);
  assert.equal(parsed.source_format, 'mp_account_statement');
  assert.equal(parsed.txs.length, 6);
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
  const night = parsed.txs.find((t) => /Night Passenger/i.test(t.descripcion));
  assert.equal(night.hora_local, 7);
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

test('santander amex merpago double-count guard + peajes', () => {
  const text = fs.readFileSync(path.join(fixtures, 'santander-card-sample.txt'), 'utf8');
  const parsed = parseSantanderCardText(text, {
    account_id: 'santander_amex',
    source_format: 'santander_amex_pdf',
  });
  assert.ok(parsed.txs.length >= 2);
  const ruled = applyRules(parsed.txs, SEED_RULES);
  const mer = ruled.find((t) => /Merpago/i.test(t.descripcion));
  assert.ok(mer);
  assert.equal(mer.double_count_guard, true);
  assert.equal(mer.is_excluded, true);
  // Fixture uses Merpago*DemoStore — not a toll; peajes only for ausol/etc.
  const cafe = ruled.find((t) => /Cafe Demo/i.test(t.descripcion));
  assert.ok(cafe);
  assert.equal(cafe.is_excluded, false);

  const toll = applyRules(
    [{
      account_id: 'santander_amex',
      merchant: 'Merpago*ausol',
      descripcion: 'Merpago*ausol',
      tx_type: 'consumo_tarjeta',
      category_id: null,
      is_excluded: false,
      double_count_guard: false,
    }],
    SEED_RULES,
  )[0];
  assert.equal(toll.category_id, CAT_PEAJES);
  assert.equal(toll.double_count_guard, true);
});

test('mp card print-pdf emits one tx per kind pair, skips summary totals', () => {
  const text = fs.readFileSync(path.join(fixtures, 'mp-card-sample.txt'), 'utf8');
  assert.equal(detectMpCardPdf(text), true);
  const parsed = parseMpCardText(text, { yearHint: 2026 });
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
    { id: 'trap-consumo', pattern: 'Consumo', category_id: 'comida', account_id: null, priority: 50, exclude_expense: false, activo: true },
    { id: 'ypf', pattern: 'YPF', category_id: 'transporte', account_id: null, priority: 10, exclude_expense: false, activo: true },
    { id: 'cafe', pattern: 'Cafe', category_id: 'comida', account_id: null, priority: 10, exclude_expense: false, activo: true },
    { id: 'cloud', pattern: 'Cloud', category_id: 'suscripciones', account_id: null, priority: 10, exclude_expense: false, activo: true },
  ]);

  const byMerchant = Object.fromEntries(ruled.map((t) => [t.merchant, t.category_id]));
  assert.equal(byMerchant['Cafe Demo'], 'comida');
  assert.equal(byMerchant['YPF Demo'], 'transporte');
  assert.equal(byMerchant['Cloud Demo'], 'suscripciones');
  const refund = ruled.find((t) => /Refund Demo/i.test(t.merchant));
  assert.ok(refund);
  assert.equal(refund.category_id, null);
  const cats = new Set(ruled.map((t) => t.category_id).filter(Boolean));
  assert.ok(cats.size >= 3);
});

test('DLOCAL + Rendimientos + night hour builtins', () => {
  const csv = fs.readFileSync(path.join(fixtures, 'mp-account-sample.csv'), 'utf8');
  const parsed = parseMpAccountStatement(csv);
  const ruled = applyRules(parsed.txs, SEED_RULES);
  const rend = ruled.find((t) => t.tx_type === 'rendimientos');
  assert.equal(rend.category_id, CAT_RENDIMIENTOS);
  assert.equal(rend.category_source, CAT_SRC_RULE);
  const dlocal = ruled.find((t) => /DLOCAL/i.test(t.descripcion));
  assert.equal(dlocal.category_id, CAT_UBER_DIDI);
  assert.equal(dlocal.category_source, CAT_SRC_RULE);
  const night = ruled.find((t) => /Night Passenger/i.test(t.descripcion));
  assert.equal(night.category_id, CAT_UBER_DIDI);
  assert.equal(night.category_source, CAT_SRC_HOURLY);
  const third = ruled.find((t) => /Persona Tercera/i.test(t.descripcion));
  assert.equal(third.category_id, null);

  const builtinsOnly = applyRules(parsed.txs, []);
  const dlocalBuiltin = builtinsOnly.find((t) => /DLOCAL/i.test(t.descripcion));
  assert.equal(dlocalBuiltin.category_source, CAT_SRC_BUILTIN);
});

test('settlement_v2 joins SOURCE_ID to REFERENCE_ID and night Uber from ISO -03', async () => {
  const account = fs.readFileSync(path.join(fixtures, 'mp-account-sample.csv'));
  const settlement = fs.readFileSync(path.join(fixtures, 'mp-settlement-sample.csv'), 'utf8');
  assert.equal(detectMpSettlement(settlement), true);
  const map = parseMpSettlement(settlement);
  assert.equal(map.size, 6);
  assert.equal(map.get('REF0000000006').hora_local, 2);

  const parsed = await parseExpenseFile(account, {
    filename: 'mp-account-sample.csv',
    settlementText: settlement,
    rules: SEED_RULES,
  });
  assert.equal(parsed.summary.settlement_joined, 6);
  const night = parsed.txs.find((t) => /Night Passenger/i.test(t.descripcion));
  assert.equal(night.hora_local, 2);
  assert.ok(night.posted_at);
  assert.equal(night.category_id, CAT_UBER_DIDI);
  assert.equal(night.category_source, CAT_SRC_HOURLY);
  const third = parsed.txs.find((t) => /Persona Tercera/i.test(t.descripcion));
  assert.equal(third.hora_local, 14);
  assert.equal(third.category_id, null);
  const dlocal = parsed.txs.find((t) => /DLOCAL/i.test(t.descripcion));
  assert.equal(dlocal.hora_local, 16);
  assert.equal(dlocal.category_id, CAT_UBER_DIDI);
  // SEED_RULES match DLOCAL first → rule wins over builtin/hourly
  assert.equal(dlocal.category_source, CAT_SRC_RULE);

  const joinedOnly = joinSettlementTimes(parseMpAccountStatement(account.toString('utf8')).txs, map);
  assert.equal(joinedOnly.joined, 6);
});

test('merchant rule beats hourly Uber; manual category never overwritten by hourly', () => {
  const nightTx = {
    account_id: 'mp_wallet',
    merchant: 'Night Passenger Demo',
    descripcion: 'Transferencia recibida Night Passenger Demo',
    tx_type: 'transferencia_recibida',
    hora_local: 2,
    category_id: null,
    category_source: null,
    is_excluded: false,
    is_internal_transfer: false,
    double_count_guard: false,
  };

  const byHour = applyRules([nightTx], [])[0];
  assert.equal(byHour.category_id, CAT_UBER_DIDI);
  assert.equal(byHour.category_source, CAT_SRC_HOURLY);

  const byRule = applyRules([nightTx], [
    {
      id: 'night-comida',
      pattern: 'Night Passenger',
      category_id: 'comida',
      account_id: 'mp_wallet',
      priority: 10,
      exclude_expense: false,
      activo: true,
    },
  ])[0];
  assert.equal(byRule.category_id, 'comida');
  assert.equal(byRule.category_source, CAT_SRC_RULE);

  const manual = applyRules([{
    ...nightTx,
    category_id: 'transporte',
    category_source: CAT_SRC_MANUAL,
  }], [])[0];
  assert.equal(manual.category_id, 'transporte');
  assert.equal(manual.category_source, CAT_SRC_MANUAL);
});

test('merchant history prefers commerce_id and beats hourly; skips hourly priors', () => {
  const prior = buildMerchantHistoryMap([
    {
      account_id: 'mp_card',
      merchant: 'YPF Demo',
      category_id: 'combustible',
      category_source: CAT_SRC_MANUAL,
      actualizado: '2026-11-01T12:00:00Z',
      raw: { commerce_id: 'COM-YPF-1' },
    },
    {
      account_id: 'mp_wallet',
      merchant: 'Night Passenger Demo',
      category_id: CAT_UBER_DIDI,
      category_source: CAT_SRC_HOURLY,
      actualizado: '2026-11-02T12:00:00Z',
    },
  ]);
  assert.equal(prior.get('mp_card::id:com-ypf-1').category_id, 'combustible');
  assert.equal(prior.has('mp_wallet::m:night passenger demo'), false);

  const keyed = {
    account_id: 'mp_card',
    merchant: 'Other label',
    descripcion: 'Consumo',
    tx_type: 'consumo',
    category_id: null,
    raw: { commerce_id: 'COM-YPF-1' },
  };
  const out = applyRules([keyed], [], { historyMap: prior })[0];
  assert.equal(out.category_id, 'combustible');
  assert.equal(out.category_source, CAT_SRC_HISTORY);

  const k1 = normalizeMerchantKey({ merchant: 'APPYPF 00128 COMBUST' });
  const k2 = normalizeMerchantKey({ merchant: 'APPYPF 00019 COMBUSTIB' });
  assert.equal(k1, k2);
});

test('learnPatternFromTx prefers merchant', () => {
  assert.equal(
    learnPatternFromTx({ merchant: 'Cafe Demo SA', descripcion: 'Pago con QR Cafe Demo SA' }),
    'Cafe Demo SA',
  );
  assert.equal(
    learnPatternFromTx({ merchant: null, descripcion: 'Transferencia recibida Demo Corp' }),
    'Demo Corp',
  );
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
