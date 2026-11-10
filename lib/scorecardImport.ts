/**
 * Scorecard CSV / .xlsx Import & Export (Step 10c.B).
 *
 * Format:
 *   variable,upper_bound,points,bin_label,woe,bad_rate,count
 *   base_points,,554.2,,,,
 *   <feature>,<upper_bound>,<points>,<bin_label>,<woe>,<bad_rate>,<count>
 *   ...
 *   <feature>,,<points>,<bin_label>,<woe>,<bad_rate>,<count>   (blank upper_bound = final open-ended bin)
 *
 * Security rule: NEVER use the `xlsx` npm package. `.xlsx` files are parsed
 * directly from their OpenXML ZIP structure using Node's built-in `zlib`.
 */
import zlib from 'zlib';
import { parseCsv } from './csv';
import { calculateAScore, validateScoringConfig } from './scoring';
import { defaultBinLabels } from './stats';
import type { ScorecardFeature, ScoringConfig } from './types';
import { parseNumber } from './validation';

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

export interface ScorecardComparisonReport {
  comparedRows: number;
  matchedWithinHalfPointCount: number;
  matchWithinHalfPointPct: number;
  maxAbsDiff: number;
}

export interface ScorecardImportOptions {
  referenceRows?: Record<string, unknown>[];
  scoreColumn?: string;
  referenceScores?: number[];
  factor?: number;
  offset?: number;
}

export interface ScorecardImportResult {
  ok: boolean;
  scoring: ScoringConfig;
  errors: string[];
  warnings: string[];
  scoreComparison: ScorecardComparisonReport | null;
}

function escapeCsvCell(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Exports a `ScoringConfig` to CSV text (`variable,upper_bound,points,bin_label,woe,bad_rate,count`).
 */
export function exportScorecardToCsv(scoring: ScoringConfig): string {
  const lines: string[] = [
    'variable,upper_bound,points,bin_label,woe,bad_rate,count',
    `base_points,,${escapeCsvCell(scoring.base_points)},,,,`,
  ];

  for (const feat of scoring.features ?? []) {
    const sc = scoring.scorecard?.[feat];
    if (!sc) continue;
    const totalBins = sc.points.length;
    const labels =
      sc.bin_labels && sc.bin_labels.length === totalBins
        ? sc.bin_labels
        : defaultBinLabels(sc.bins);

    for (let i = 0; i < totalBins; i++) {
      const upper = i < sc.bins.length ? sc.bins[i] : '';
      const pts = sc.points[i] ?? 0;
      const lbl = labels[i] ?? '';
      const woe = sc.woe?.[i] !== undefined ? sc.woe[i] : '';
      const br = sc.bad_rate?.[i] !== undefined ? sc.bad_rate[i] : '';
      const cnt = sc.count?.[i] !== undefined ? sc.count[i] : '';
      lines.push(
        [
          escapeCsvCell(feat),
          escapeCsvCell(upper),
          escapeCsvCell(pts),
          escapeCsvCell(lbl),
          escapeCsvCell(woe),
          escapeCsvCell(br),
          escapeCsvCell(cnt),
        ].join(','),
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Minimal pure-Node OpenXML (.xlsx) first-sheet reader using built-in `zlib`.
 * Avoids any dependency on the vulnerable `xlsx` npm package.
 */
export interface XlsxWorksheet {
  name: string;
  target: string;
  matrix: string[][];
  rows: Record<string, string>[];
  rowCount: number;
}

function decodeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Minimal pure-Node OpenXML (.xlsx) multi-sheet reader using built-in `zlib`.
 * Parses every worksheet with its sheet name and rows without any external dependencies.
 * Avoids any dependency on the vulnerable `xlsx` npm package.
 */
export function parseXlsxAllSheets(buffer: Uint8Array | Buffer): XlsxWorksheet[] {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = new Map<string, string>();

  // Scan local file headers (signature 0x04034b50)
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      offset++;
      continue;
    }
    const method = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const fileNameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLen + extraLen;
    if (dataStart + compressedSize > buf.length) break;

    const name = buf.subarray(nameStart, nameStart + fileNameLen).toString('utf8');
    const rawData = buf.subarray(dataStart, dataStart + compressedSize);
    if (
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name.startsWith('xl/worksheets/')
    ) {
      try {
        const content =
          method === 0
            ? rawData.toString('utf8')
            : method === 8
              ? zlib.inflateRawSync(rawData).toString('utf8')
              : '';
        if (content) entries.set(name, content);
      } catch {
        // Ignore non-critical zip entry decompression errors
      }
    }
    offset = dataStart + compressedSize;
  }

  const sharedStrings: string[] = [];
  const ssXml = entries.get('xl/sharedStrings.xml') || '';
  if (ssXml) {
    const siMatches = ssXml.match(/<si[\s\S]*?<\/si>/g) || [];
    for (const si of siMatches) {
      const tMatches = [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)];
      sharedStrings.push(decodeXml(tMatches.map(m => m[1]).join('')));
    }
  }

  // Parse workbook relationships (rId -> target worksheet)
  const relMap = new Map<string, string>();
  const relsXml = entries.get('xl/_rels/workbook.xml.rels') || '';
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const idM = m[1].match(/\bId="([^"]+)"/);
    const targetM = m[1].match(/\bTarget="([^"]+)"/);
    if (idM && targetM) {
      let t = targetM[1];
      if (t.startsWith('/')) t = t.slice(1);
      else if (!t.startsWith('xl/')) t = `xl/${t}`;
      relMap.set(idM[1], t);
    }
  }

  // Parse sheets metadata from workbook.xml
  const sheetMetaList: { name: string; target: string }[] = [];
  const wbXml = entries.get('xl/workbook.xml') || '';
  if (wbXml) {
    for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
      const nameM = m[1].match(/\bname="([^"]+)"/);
      const ridM = m[1].match(/\br:id="([^"]+)"/);
      const sheetIdM = m[1].match(/\bsheetId="([^"]+)"/);
      if (nameM) {
        const sheetName = decodeXml(nameM[1]);
        const rId = ridM ? ridM[1] : '';
        const target = relMap.get(rId) || `xl/worksheets/sheet${sheetIdM ? sheetIdM[1] : sheetMetaList.length + 1}.xml`;
        sheetMetaList.push({ name: sheetName, target });
      }
    }
  }

  // Fallback if workbook.xml is not present (e.g. minimal test buffers)
  if (sheetMetaList.length === 0) {
    const worksheetKeys = [...entries.keys()]
      .filter(k => k.startsWith('xl/worksheets/sheet') && k.endsWith('.xml'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });
    for (let i = 0; i < worksheetKeys.length; i++) {
      sheetMetaList.push({ name: `Sheet${i + 1}`, target: worksheetKeys[i] });
    }
  }

  const colLettersToIndex = (letters: string): number => {
    let idx = 0;
    for (let i = 0; i < letters.length; i++) {
      idx = idx * 26 + (letters.charCodeAt(i) - 64);
    }
    return idx - 1;
  };

  const sheets: XlsxWorksheet[] = [];

  for (const meta of sheetMetaList) {
    const sheetXml = entries.get(meta.target) || '';
    if (!sheetXml) continue;

    const matrix: string[][] = [];
    const rowMatches = sheetXml.match(/<row[\s\S]*?<\/row>/g) || [];
    for (const rowXml of rowMatches) {
      const rowCells: string[] = [];
      const cellMatches = [...rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)];
      for (const cm of cellMatches) {
        const attrs = cm[1];
        const inner = cm[2];
        const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
        const colIdx = refMatch ? colLettersToIndex(refMatch[1]) : rowCells.length;
        const typeMatch = attrs.match(/\bt="([^"]+)"/);
        const cellType = typeMatch ? typeMatch[1] : '';

        let val = '';
        if (cellType === 'inlineStr') {
          const tMatch = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
          val = tMatch ? decodeXml(tMatch[1]) : '';
        } else {
          const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
          const rawV = vMatch ? decodeXml(vMatch[1]) : '';
          if (cellType === 's') {
            const sIdx = parseInt(rawV, 10);
            val = Number.isFinite(sIdx) && sharedStrings[sIdx] !== undefined ? sharedStrings[sIdx] : rawV;
          } else {
            val = rawV;
          }
        }
        while (rowCells.length <= colIdx) rowCells.push('');
        rowCells[colIdx] = val;
      }
      if (rowCells.some(c => c.trim() !== '')) {
        matrix.push(rowCells);
      }
    }

    if (matrix.length === 0) {
      sheets.push({
        name: meta.name,
        target: meta.target,
        matrix: [],
        rows: [],
        rowCount: 0,
      });
      continue;
    }

    // Determine header row: find row within the first 10 rows having the maximum number of non-empty columns
    let headerRowIdx = 0;
    let maxCols = 0;
    const checkLimit = Math.min(matrix.length, 10);
    for (let i = 0; i < checkLimit; i++) {
      const cnt = matrix[i].filter(c => c && c.trim() !== '').length;
      if (cnt > maxCols) {
        maxCols = cnt;
        headerRowIdx = i;
      }
    }

    const headers = matrix[headerRowIdx] ? matrix[headerRowIdx].map(h => h.trim()) : [];
    const rows: Record<string, string>[] = [];
    for (let r = headerRowIdx + 1; r < matrix.length; r++) {
      const row = matrix[r];
      const obj: Record<string, string> = {};
      let hasData = false;
      for (let c = 0; c < headers.length; c++) {
        const h = headers[c];
        if (h) {
          const val = row[c] ?? '';
          obj[h] = val;
          if (val.trim() !== '') hasData = true;
        }
      }
      if (hasData) rows.push(obj);
    }

    sheets.push({
      name: meta.name,
      target: meta.target,
      matrix,
      rows,
      rowCount: matrix.length,
    });
  }

  return sheets;
}

/**
 * Reads a single sheet's rows from a `.xlsx` buffer.
 * If sheetNameOrIndex is omitted, automatically selects the scorecard sheet
 * (matching name "Scorecard" or containing scorecard headers) if available,
 * or the first sheet otherwise.
 */
export function parseXlsxBufferToRows(
  buffer: Uint8Array | Buffer,
  sheetNameOrIndex?: string | number,
): Record<string, string>[] {
  const sheets = parseXlsxAllSheets(buffer);
  if (sheets.length === 0) return [];

  if (typeof sheetNameOrIndex === 'number') {
    return sheets[sheetNameOrIndex]?.rows ?? [];
  }

  if (typeof sheetNameOrIndex === 'string' && sheetNameOrIndex.trim() !== '') {
    const target = sheetNameOrIndex.trim().toLowerCase();
    const found = sheets.find(s => s.name.toLowerCase() === target);
    if (found) return found.rows;
  }

  // Auto-detect scorecard sheet if available
  const scorecardSheet =
    sheets.find(s => s.name.trim().toLowerCase() === 'scorecard') ||
    sheets.find(s => {
      const sample = s.rows[0] ? Object.keys(s.rows[0]).map(k => k.toLowerCase().trim()) : [];
      return sample.includes('variable') && sample.includes('points');
    });

  return scorecardSheet ? scorecardSheet.rows : sheets[0].rows;
}

/**
 * Parses scorecard rows (`variable`, `upper_bound`, `points`, plus optional `bin_label`, `woe`, `bad_rate`, `count`),
 * runs `validateScoringConfig`, and optionally verifies recomputed scores against Reference scores.
 */
export function importScorecardFromRows(
  rows: Record<string, unknown>[],
  options: ScorecardImportOptions = {},
): ScorecardImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!rows || rows.length === 0) {
    return {
      ok: false,
      scoring: { base_points: 0, factor: 1, offset: 0, features: [], scorecard: {} },
      errors: ['ไฟล์สกอร์การ์ดไม่มีข้อมูล'],
      warnings: [],
      scoreComparison: null,
    };
  }

  const sampleKeys = Object.keys(rows[0]);
  const findCol = (target: string) =>
    sampleKeys.find(k => k.trim().toLowerCase() === target.toLowerCase()) ?? target;

  const colVariable = findCol('variable');
  const colUpper = findCol('upper_bound');
  const colPoints = findCol('points');
  const colLabel = findCol('bin_label');
  const colWoe = findCol('woe');
  const colBadRate = findCol('bad_rate');
  const colCount = findCol('count');

  if (!sampleKeys.some(k => k.trim().toLowerCase() === 'variable') || !sampleKeys.some(k => k.trim().toLowerCase() === 'points')) {
    errors.push('ไฟล์สกอร์การ์ดต้องมีคอลัมน์ variable, upper_bound และ points');
  }

  let basePoints = 0;
  let hasBasePoints = false;
  const featureOrder: string[] = [];
  const rawGroups = new Map<
    string,
    {
      upperBound: number | null;
      points: number;
      binLabel?: string;
      woe?: number;
      badRate?: number;
      count?: number;
      rowNo: number;
    }[]
  >();

  rows.forEach((r, idx) => {
    const rowNo = idx + 2; // 1-based data row + header
    const variable = String(r[colVariable] ?? '').trim();
    if (!variable) return;

    const ptsNum = parseNumber(r[colPoints]);
    if (!Number.isFinite(ptsNum)) {
      errors.push(`แถวที่ ${rowNo} (${variable}): ค่า points "${String(r[colPoints] ?? '')}" ไม่ใช่ตัวเลข`);
      return;
    }

    if (variable.toLowerCase() === 'base_points') {
      basePoints = ptsNum;
      hasBasePoints = true;
      return;
    }

    const rawUpper = r[colUpper];
    let upperBound: number | null = null;
    if (!isBlank(rawUpper)) {
      const uNum = parseNumber(rawUpper);
      if (!Number.isFinite(uNum)) {
        errors.push(`แถวที่ ${rowNo} (${variable}): ค่า upper_bound "${String(rawUpper)}" ไม่ใช่ตัวเลข`);
        return;
      }
      upperBound = uNum;
    }

    if (!rawGroups.has(variable)) {
      rawGroups.set(variable, []);
      featureOrder.push(variable);
    }

    const woeNum = !isBlank(r[colWoe]) ? parseNumber(r[colWoe]) : NaN;
    const brNum = !isBlank(r[colBadRate]) ? parseNumber(r[colBadRate]) : NaN;
    const cntNum = !isBlank(r[colCount]) ? parseNumber(r[colCount]) : NaN;
    const lblStr = !isBlank(r[colLabel]) ? String(r[colLabel]).trim() : undefined;

    rawGroups.get(variable)!.push({
      upperBound,
      points: ptsNum,
      ...(lblStr ? { binLabel: lblStr } : {}),
      ...(Number.isFinite(woeNum) ? { woe: woeNum } : {}),
      ...(Number.isFinite(brNum) ? { badRate: brNum } : {}),
      ...(Number.isFinite(cntNum) ? { count: Math.round(cntNum) } : {}),
      rowNo,
    });
  });

  if (!hasBasePoints) {
    warnings.push('ไม่พบแถว variable = "base_points" — ใช้ base_points = 0 เป็นค่าเริ่มต้น');
  }

  const scorecard: Record<string, ScorecardFeature> = {};
  for (const feat of featureOrder) {
    const items = rawGroups.get(feat) ?? [];
    const bounded = items.filter(x => x.upperBound !== null);
    const openEnded = items.filter(x => x.upperBound === null);

    if (openEnded.length === 0) {
      errors.push(`ตัวแปร "${feat}": ต้องมีแถวสุดท้ายที่เว้นว่าง upper_bound 1 แถว (สำหรับกลุ่มค่าที่มากกว่าขอบบนสุด)`);
    } else if (openEnded.length > 1) {
      errors.push(`ตัวแปร "${feat}": มีแถวที่เว้นว่าง upper_bound ${openEnded.length} แถว (ต้องมีเพียง 1 แถวสำหรับ bin สุดท้าย)`);
    }

    const ordered = [...bounded, ...openEnded];
    const bins = bounded.map(b => b.upperBound as number);
    const points = ordered.map(b => b.points);
    const hasAllCustomLabels = ordered.every(b => Boolean(b.binLabel));
    const bin_labels = hasAllCustomLabels
      ? ordered.map(b => b.binLabel!)
      : defaultBinLabels(bins);
    const woe = ordered.map(b => b.woe ?? 0);
    const bad_rate = ordered.map(b => b.badRate ?? 0);
    const hasCounts = ordered.some(b => b.count !== undefined);

    scorecard[feat] = {
      bins,
      bin_labels,
      points,
      woe,
      bad_rate,
      ...(hasCounts ? { count: ordered.map(b => b.count ?? 0) } : {}),
    };
  }

  const scoring: ScoringConfig = {
    base_points: basePoints,
    pdo: 20,
    base_score: 600,
    base_odds: 50,
    factor: options.factor ?? 28.854,
    offset: options.offset ?? 487.123,
    features: featureOrder,
    scorecard,
  };

  const configProblems = validateScoringConfig(scoring);
  for (const p of configProblems) {
    errors.push(p);
  }

  let scoreComparison: ScorecardComparisonReport | null = null;
  const refRows = options.referenceRows ?? [];
  if (errors.length === 0 && refRows.length > 0 && featureOrder.length > 0) {
    const scoreCol =
      options.scoreColumn ||
      (refRows[0] && 'score' in refRows[0] ? 'score' : undefined);

    const hasExpectedScores =
      Boolean(options.referenceScores && options.referenceScores.length === refRows.length) ||
      Boolean(scoreCol && refRows.some(r => Number.isFinite(parseNumber(r[scoreCol]))));

    if (hasExpectedScores) {
      let comparedRows = 0;
      let matchedCount = 0;
      let maxAbsDiff = 0;

      for (let i = 0; i < refRows.length; i++) {
        const r = refRows[i];
        const expected =
          options.referenceScores && options.referenceScores[i] !== undefined
            ? options.referenceScores[i]
            : scoreCol
              ? parseNumber(r[scoreCol])
              : NaN;
        if (!Number.isFinite(expected)) continue;

        const rec: Record<string, number> = {};
        let allFeaturesFinite = true;
        for (const f of featureOrder) {
          const v = parseNumber(r[f]);
          if (!Number.isFinite(v)) {
            allFeaturesFinite = false;
            break;
          }
          rec[f] = v;
        }
        if (!allFeaturesFinite) continue;

        const recomputed = calculateAScore(scoring, rec);
        const diff = Math.abs(recomputed - expected);
        comparedRows++;
        if (diff <= 0.500001) matchedCount++;
        if (diff > maxAbsDiff) maxAbsDiff = diff;
      }

      if (comparedRows > 0) {
        const matchPct = +((matchedCount / comparedRows) * 100).toFixed(2);
        scoreComparison = {
          comparedRows,
          matchedWithinHalfPointCount: matchedCount,
          matchWithinHalfPointPct: matchPct,
          maxAbsDiff: +maxAbsDiff.toFixed(4),
        };
        if (matchPct < 99) {
          warnings.push(
            `คะแนนที่คำนวณจากสกอร์การ์ดตรงกับคอลัมน์คะแนนเพียง ${matchPct.toFixed(2)}% (< 99%, ต่างไม่เกิน 0.5 คะแนน) โดยต่างสูงสุด ${maxAbsDiff.toFixed(2)} คะแนน`,
          );
        }
      }
    }
  }

  return {
    ok: errors.length === 0 && featureOrder.length > 0,
    scoring,
    errors,
    warnings,
    scoreComparison,
  };
}

export function importScorecardFromCsv(
  csvText: string,
  options: ScorecardImportOptions = {},
): ScorecardImportResult {
  const parsed = parseCsv(csvText);
  return importScorecardFromRows(parsed.rows, options);
}

export function importScorecardFromBuffer(
  buffer: Uint8Array | Buffer,
  fileName: string,
  options: ScorecardImportOptions = {},
): ScorecardImportResult {
  if (fileName.toLowerCase().endsWith('.xlsx')) {
    const rows = parseXlsxBufferToRows(buffer);
    return importScorecardFromRows(rows, options);
  }
  const text = Buffer.isBuffer(buffer)
    ? buffer.toString('utf8')
    : Buffer.from(buffer).toString('utf8');
  return importScorecardFromCsv(text, options);
}

