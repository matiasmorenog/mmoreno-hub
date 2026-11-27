import { detectMpAccountStatement, parseMpAccountStatement } from './mp-account.js';
import { detectMpSettlement, joinSettlementTimes, parseMpSettlement } from './mp-settlement.js';
import { detectSantanderCajaXlsx, parseSantanderCajaXlsx } from './santander-caja.js';
import {
  detectSantanderCardKind,
  detectSantanderCuentaResumen,
  parseSantanderAmexPdf,
  parseSantanderVisaPdf,
} from './santander-card.js';
import { detectMpCardPdf, parseMpCardPdf } from './mp-card.js';
import { pdfToText } from './pdf-text.js';
import { applyRules } from './rules.js';
import { sha256 } from './fingerprint.js';

const ACCOUNT_BY_FORMAT = {
  mp_account_statement: 'mp_wallet',
  mp_card_pdf: 'mp_card',
  santander_caja_xlsx: 'santander_caja',
  santander_visa_pdf: 'santander_visa',
  santander_amex_pdf: 'santander_amex',
};

export function accountForFormat(fmt) {
  return ACCOUNT_BY_FORMAT[fmt] || null;
}

function withRules(parsed, rules, historyMap) {
  parsed.txs = applyRules(parsed.txs, rules, { historyMap: historyMap || null });
  return parsed;
}

function applySettlementJoin(parsed, settlementText, warnings) {
  if (!settlementText) return parsed;
  if (!detectMpSettlement(settlementText)) {
    warnings.push('settlement_not_recognized');
    return parsed;
  }
  const map = parseMpSettlement(settlementText);
  const { txs, joined } = joinSettlementTimes(parsed.txs, map);
  parsed.txs = txs;
  parsed.summary = {
    ...parsed.summary,
    settlement_joined: joined,
    settlement_map_size: map.size,
  };
  if (joined === 0) warnings.push('settlement_no_joins');
  else warnings.push(`settlement_joined_${joined}`);
  return parsed;
}

/**
 * Detect format and parse file buffer.
 * @param {Buffer} buf
 * @param {{ filename?: string, account_id?: string, rules?: any[], settlementText?: string, historyMap?: Map }} opts
 */
export async function parseExpenseFile(buf, opts = {}) {
  const filename = opts.filename || 'upload';
  const lower = filename.toLowerCase();
  const file_hash = sha256(buf);
  const warnings = [];
  const historyMap = opts.historyMap || null;

  // CSV / text
  const asText = buf.toString('utf8');
  if (detectMpSettlement(asText) && !detectMpAccountStatement(asText)) {
    throw Object.assign(new Error('mp_settlement_needs_account_statement'), {
      code: 'mp_settlement_needs_account_statement',
    });
  }
  if (detectMpAccountStatement(asText) || lower.endsWith('.csv')) {
    if (!detectMpAccountStatement(asText)) {
      throw Object.assign(new Error('unsupported_csv'), { code: 'unsupported_csv' });
    }
    let parsed = parseMpAccountStatement(asText, {
      account_id: opts.account_id || 'mp_wallet',
    });
    parsed = applySettlementJoin(parsed, opts.settlementText, warnings);
    return { file_hash, filename, ...withRules(parsed, opts.rules, historyMap), warnings: [...warnings, ...parsed.warnings] };
  }

  // XLSX
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || detectSantanderCajaXlsx(buf)) {
    if (!detectSantanderCajaXlsx(buf)) {
      throw Object.assign(new Error('unsupported_xlsx'), { code: 'unsupported_xlsx' });
    }
    const parsed = parseSantanderCajaXlsx(buf, {
      account_id: opts.account_id || 'santander_caja',
    });
    return { file_hash, filename, ...withRules(parsed, opts.rules, historyMap), warnings: [...warnings, ...parsed.warnings] };
  }

  // PDF — Santander card BEFORE MP card (MP detector used to false-positive on Visa/Amex).
  if (lower.endsWith('.pdf') || buf.slice(0, 5).toString() === '%PDF-') {
    const text = await pdfToText(buf);

    // Cuenta resumen PDF is secondary — primary caja source is XLSX.
    if (
      /cuenta-resumen|resumen-cuenta/i.test(filename) ||
      (detectSantanderCuentaResumen(text) && opts.account_id !== 'santander_visa' && opts.account_id !== 'santander_amex')
    ) {
      throw Object.assign(
        new Error('santander_cuenta_resumen_use_xlsx'),
        { code: 'santander_cuenta_resumen_use_xlsx' },
      );
    }

    const kindFromName = /amex/i.test(filename)
      ? 'santander_amex'
      : /visa/i.test(filename)
        ? 'santander_visa'
        : null;
    const kind = opts.account_id === 'santander_amex' || opts.account_id === 'santander_visa'
      ? opts.account_id
      : kindFromName || detectSantanderCardKind(text);

    if (kind === 'santander_amex') {
      const parsed = await parseSantanderAmexPdf(buf);
      parsed.account_id = opts.account_id || parsed.account_id;
      parsed.txs = parsed.txs.map((t) => ({ ...t, account_id: parsed.account_id }));
      return { file_hash, filename, ...withRules(parsed, opts.rules, historyMap), warnings: [...warnings, ...parsed.warnings] };
    }
    if (kind === 'santander_visa') {
      const parsed = await parseSantanderVisaPdf(buf);
      parsed.account_id = opts.account_id || parsed.account_id;
      parsed.txs = parsed.txs.map((t) => ({ ...t, account_id: parsed.account_id }));
      return { file_hash, filename, ...withRules(parsed, opts.rules, historyMap), warnings: [...warnings, ...parsed.warnings] };
    }

    if (detectMpCardPdf(text) || opts.account_id === 'mp_card' || /mp-tarjeta|mercadopago.*tarjeta/i.test(filename)) {
      const ym = filename.match(/(20\d{2})-(\d{2})/);
      const yearHint = ym ? Number(ym[1]) : undefined;
      const parsed = await parseMpCardPdf(buf, {
        account_id: opts.account_id || 'mp_card',
        yearHint,
        monthHint: ym ? Number(ym[2]) : undefined,
      });
      return { file_hash, filename, ...withRules(parsed, opts.rules, historyMap), warnings: [...warnings, ...parsed.warnings] };
    }

    if (/Merpago\*/i.test(text)) {
      const parsed = await parseSantanderAmexPdf(buf);
      return { file_hash, filename, ...withRules(parsed, opts.rules, historyMap), warnings: [...warnings, ...parsed.warnings] };
    }

    throw Object.assign(new Error('unsupported_pdf'), { code: 'unsupported_pdf' });
  }

  throw Object.assign(new Error('unsupported_file'), { code: 'unsupported_file' });
}
