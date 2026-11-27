import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Extract plain text from a PDF buffer via pdf-parse v2. */
export async function pdfToText(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    return String(result?.text || '');
  } finally {
    try {
      await parser.destroy?.();
    } catch {
      /* ignore */
    }
  }
}
