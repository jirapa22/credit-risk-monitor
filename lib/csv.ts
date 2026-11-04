/**
 * Minimal RFC-4180 CSV parser (no dependencies, usable in browser and server).
 * Handles: UTF-8 BOM, CRLF/LF, quoted fields, commas/newlines inside quotes,
 * escaped quotes (""), trailing blank lines.
 */
export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  /** 1-based data-row numbers whose field count differs from the header. */
  malformedRows: { row: number; expected: number; actual: number }[];
}

function tokenize(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      out.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); out.push(row); }
  return out;
}

export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^\uFEFF/, '');
  const table = tokenize(clean).filter(r => r.some(v => v.trim() !== ''));
  if (table.length === 0) return { headers: [], rows: [], malformedRows: [] };

  const headers = table[0].map(h => h.trim());
  const rows: Record<string, string>[] = [];
  const malformedRows: ParsedCsv['malformedRows'] = [];
  table.slice(1).forEach((vals, idx) => {
    if (vals.length !== headers.length) malformedRows.push({ row: idx + 1, expected: headers.length, actual: vals.length });
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { rec[h] = (vals[i] ?? '').trim(); });
    rows.push(rec);
  });
  return { headers, rows, malformedRows };
}
