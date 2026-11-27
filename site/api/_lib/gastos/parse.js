import { detectMpAccountStatement, parseMpAccountStatement } from './mp-account.js';
import { detectSantanderCajaXlsx, parseSantanderCajaXlsx } from './santander-caja.js';
import {
  detectSantanderCardKind,
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

/**
 * Detect format and parse file buffer.
 * @param {Buffer} buf
 * @param {{ filename?: string, account_id?: string, rules?: any[] }} opts
 */
export async function parseExpenseFile(buf, opts = {}) {
  const filename = opts.filename || 'upload';
  const lower = filename.toLowerCase();
  const file_hash = sha256(buf);
  const warnings = [];

  // CSV / text
  const asText = buf.toString('utf8');
  if (detectMpAccountStatement(asText) || lower.endsWith('.csv')) {
    if (!detectMpAccountStatement(asText)) {
      throw Object.assign(new Error('unsupported_csv'), { code: 'unsupported_csv' });
    }
    const parsed = parseMpAccountStatement(asText, {
      account_id: opts.account_id || 'mp_wallet',
    });
    parsed.txs = applyRules(parsed.txs, opts.rules);
    return { file_hash, filename, ...parsed, warnings: [...warnings, ...parsed.warnings] };
  }

  // XLSX
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || detectSantanderCajaXlsx(buf)) {
    if (!detectSantanderCajaXlsx(buf)) {
      throw Object.assign(new Error('unsupported_xlsx'), { code: 'unsupported_xlsx' });
    }
    const parsed = parseSantanderCajaXlsx(buf, {
      account_id: opts.account_id || 'santander_caja',
    });
    parsed.txs = applyRules(parsed.txs, opts.rules);
    return { file_hash, filename, ...parsed, warnings: [...warnings, ...parsed.warnings] };
  }

  // PDF
  if (lower.endsWith('.pdf') || buf.slice(0, 5).toString() === '%PDF-') {
    const text = await pdfToText(buf);
    if (detectMpCardPdf(text)) {
      const parsed = await parseMpCardPdf(buf, {
        account_id: opts.account_id || 'mp_card',
      });
      parsed.txs = applyRules(parsed.txs, opts.rules);
      return { file_hash, filename, ...parsed, warnings: [...warnings, ...parsed.warnings] };
    }
    const kind = opts.account_id || detectSantanderCardKind(text);
    if (kind === 'santander_amex' || /amex/i.test(filename)) {
      const parsed = await parseSantanderAmexPdf(buf);
      if (opts.account_id) parsed.account_id = opts.account_id;
      parsed.txs = applyRules(
        parsed.txs.map((t) => ({ ...t, account_id: parsed.account_id })),
        opts.rules,
      );
      return { file_hash, filename, ...parsed, warnings: [...warnings, ...parsed.warnings] };
    }
    if (kind === 'santander_visa' || /visa/i.test(filename)) {
      const parsed = await parseSantanderVisaPdf(buf);
      if (opts.account_id) parsed.account_id = opts.account_id;
      parsed.txs = applyRules(
        parsed.txs.map((t) => ({ ...t, account_id: parsed.account_id })),
        opts.rules,
      );
      return { file_hash, filename, ...parsed, warnings: [...warnings, ...parsed.warnings] };
    }
    // fallback: try amex then visa heuristics
    if (/Merpago\*/i.test(text)) {
      const parsed = await parseSantanderAmexPdf(buf);
      parsed.txs = applyRules(parsed.txs, opts.rules);
      return { file_hash, filename, ...parsed, warnings: [...warnings, ...parsed.warnings] };
    }
    throw Object.assign(new Error('unsupported_pdf'), { code: 'unsupported_pdf' });
  }

  throw Object.assign(new Error('unsupported_file'), { code: 'unsupported_file' });
}
