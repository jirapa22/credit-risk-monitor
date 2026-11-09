/**
 * Data Validation layer — answers "is this data well-formed?".
 * It is intentionally independent of Drift Detection ("did the distribution
 * change?"): rows that fail here are excluded BEFORE PSI/CSI is computed and
 * are reported separately, so malformed data is never mistaken for drift.
 *
 * All rules come from featureRegistry (config) — new variables are validated
 * automatically once they are added to the registry.
 */
import type {
  FeatureDefinition, ValidationIssue, ValidationIssueGroup, ValidationResult, ValidationIssueType, ValidationSeverity,
} from './types';

export interface ValidationOptions {
  /** Columns the scorecard needs — always treated as required. */
  scoringFeatures: string[];
  idColumn?: string;
  dateColumn?: string;
  labelColumn?: string;
  scoreColumn?: string;
  /** Reference mean/median per feature (computed from Reference dataset; falls back to baselineDistribution when omitted). */
  referenceStats?: Record<string, { mean: number; median: number }>;
  /** Block the run when more than this % of rows is rejected. */
  maxRejectedPct?: number;
  /** Warn when fewer valid rows than this (PSI becomes unstable). */
  minRowsForDrift?: number;
  /** Rows with wrong field count reported by the CSV parser. */
  malformedRows?: { row: number; expected: number; actual: number }[];
  /** Max individual issues returned (groups always contain full counts). */
  maxIssues?: number;
}

export interface CleanRow {
  row: number;                       // 1-based data row
  id: string;
  date: string | null;               // raw date if valid
  values: Record<string, number>;    // numeric/binary features (after imputation)
  label: number | null;              // default_flag if present & valid
  imputed: string[];                 // features that were filled by a missing strategy
}

export interface ValidationOutput {
  result: ValidationResult;
  rows: CleanRow[];
}

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

/** Accepts "28000", "28,000", " 0.45 ". Returns NaN otherwise. */
export function parseNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
  return Number(s);
}

export function isValidDate(v: unknown): boolean {
  const s = String(v).trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else if ((match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { d = +match[1]; m = +match[2]; y = +match[3]; }
  else if ((match = s.match(/^(\d{4})-(\d{1,2})$/))) { y = +match[1]; m = +match[2]; d = 1; }
  else return false;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

export function validateDataset(
  rawRows: Record<string, unknown>[],
  headers: string[],
  registry: Record<string, FeatureDefinition>,
  opts: ValidationOptions,
): ValidationOutput {
  const {
    scoringFeatures, idColumn = 'customer_id', dateColumn = 'application_date', labelColumn = 'default_flag', scoreColumn,
    referenceStats, maxRejectedPct = 50, minRowsForDrift = 100, malformedRows = [], maxIssues = 200,
  } = opts;

  const blockingErrors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const rowIssues: ValidationIssue[] = [];
  const total = rawRows.length;

  // ── File-level checks ──────────────────────────────────────────────────
  if (total === 0) {
    blockingErrors.push({ type: 'EMPTY_FILE', severity: 'error', message: 'ไฟล์ไม่มีข้อมูล (มีแต่ header หรือว่างเปล่า)' });
  }
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) blockingErrors.push({ type: 'DUPLICATE_COLUMN', severity: 'error', column: h, message: `คอลัมน์ "${h}" ซ้ำกันมากกว่า 1 ครั้ง` });
    seen.add(h);
  }

  // Columns to check = registry features + scorecard features (even if not in registry)
  const defs: Record<string, FeatureDefinition> = { ...registry };
  for (const f of scoringFeatures) {
    if (!defs[f]) defs[f] = { columnName: f, displayName: f, dataType: 'numeric', required: true, monitoringEnabled: true };
  }
  const headerSet = new Set(headers);
  const activeCols: string[] = [];
  for (const [key, def] of Object.entries(defs)) {
    const col = def.columnName || key;
    const required = def.required || scoringFeatures.includes(key);
    if (!headerSet.has(col)) {
      if (required) {
        blockingErrors.push({
          type: 'MISSING_COLUMN', severity: 'error', column: col,
          message: `ไม่พบคอลัมน์ที่จำเป็น "${col}" (${def.displayName}) — ตรวจสอบชื่อ header ให้ตรงตัวพิมพ์`,
        });
      } else {
        warnings.push({ type: 'MISSING_COLUMN', severity: 'warning', column: col, message: `ไม่พบคอลัมน์ "${col}" (${def.displayName}) — ไม่บังคับ จะข้ามการตรวจคอลัมน์นี้` });
      }
      continue;
    }
    activeCols.push(key);
  }

  if (blockingErrors.length > 0) {
    return { result: summarize(total, 0, blockingErrors, warnings, rowIssues, maxIssues, false), rows: [] };
  }

  // ── Row-level checks ───────────────────────────────────────────────────
  const malformedSet = new Map(malformedRows.map(m => [m.row, m]));
  const idSeen = new Map<string, number>();
  const clean: CleanRow[] = [];

  rawRows.forEach((raw, i) => {
    const rowNo = i + 1;
    let rejected = false;
    const add = (type: ValidationIssueType, severity: ValidationSeverity, column: string | undefined, value: unknown, message: string) => {
      rowIssues.push({ type, severity, column, row: rowNo, value: value === undefined ? undefined : String(value), message });
      if (severity === 'error') rejected = true;
    };

    const m = malformedSet.get(rowNo);
    if (m) add('MALFORMED_ROW', 'error', undefined, undefined, `จำนวนช่องไม่ตรงกับ header (คาด ${m.expected} ได้ ${m.actual}) — มักเกิดจาก comma ในข้อมูลที่ไม่ได้ใส่ "..."`);

    const values: Record<string, number> = {};
    const imputed: string[] = [];
    let label: number | null = null;

    for (const key of activeCols) {
      const def = defs[key];
      const col = def.columnName || key;
      const v = raw[col];
      const required = def.required || scoringFeatures.includes(key);
      const strategy = def.validation?.missingStrategy ?? (required ? 'reject' : 'ignore');
      const isLabel = def.dataType === 'binary' && (key === labelColumn || col === labelColumn);

      if (isBlank(v)) {
        if (strategy === 'reject' || (required && strategy === 'ignore')) {
          add('MISSING_VALUE', 'error', col, '', `"${def.displayName}" ว่าง — ตัวแปรนี้จำเป็นต่อการคำนวณคะแนน`);
        } else if (strategy === 'fillMean' || strategy === 'fillMedian' || strategy === 'fillDefault') {
          const refStat = referenceStats?.[key];
          const bd = def.baselineDistribution ?? {};
          const fill = strategy === 'fillMean'
            ? (refStat?.mean ?? bd.mean)
            : strategy === 'fillMedian'
              ? (refStat?.median ?? bd.median)
              : def.validation?.defaultValue;
          if (isLabel) continue; // never impute the target
          if (typeof fill === 'number') {
            values[key] = fill; imputed.push(key);
            add('MISSING_VALUE', 'warning', col, '', `"${def.displayName}" ว่าง — เติมค่า ${fmt(fill)} (${strategy})`);
          } else if (required) {
            add('MISSING_VALUE', 'error', col, '', `"${def.displayName}" ว่าง และไม่มีค่าเริ่มต้นสำหรับเติม`);
          }
        }
        continue;
      }

      if (def.dataType === 'date') {
        if (!isValidDate(v)) add('INVALID_DATE', required ? 'error' : 'warning', col, v, `"${def.displayName}" รูปแบบวันที่ไม่ถูกต้อง "${v}" (ใช้ YYYY-MM-DD หรือ DD/MM/YYYY)`);
        continue;
      }

      if (def.dataType === 'numeric' || def.dataType === 'binary') {
        const n = parseNumber(v);
        if (!Number.isFinite(n)) {
          add('INVALID_TYPE', required ? 'error' : 'warning', col, v, `"${def.displayName}" ต้องเป็นตัวเลข แต่พบ "${v}"`);
          continue;
        }
        if (def.dataType === 'binary' && n !== 0 && n !== 1) {
          add('INVALID_BINARY', required ? 'error' : 'warning', col, v, `"${def.displayName}" ต้องเป็น 0 หรือ 1 แต่พบ "${v}"`);
          continue;
        }
        const min = def.validation?.minValue, max = def.validation?.maxValue;
        if ((typeof min === 'number' && n < min) || (typeof max === 'number' && n > max)) {
          add('OUT_OF_RANGE', required ? 'error' : 'warning', col, v,
            `"${def.displayName}" = ${fmt(n)} อยู่นอกช่วงที่ยอมรับ [${typeof min === 'number' ? fmt(min) : '−∞'}, ${typeof max === 'number' ? fmt(max) : '∞'}]`);
          continue;
        }
        if (isLabel) label = n; else values[key] = n;
      }
    }

    // If labelColumn is present in raw data but was not in featureRegistry, parse it when valid 0/1 (never default to 0).
    if (label === null && labelColumn && headerSet.has(labelColumn) && !isBlank(raw[labelColumn])) {
      const n = parseNumber(raw[labelColumn]);
      if (n === 0 || n === 1) label = n;
    }

    // If scoreColumn is present in raw data (for score_column models), parse it when numeric.
    if (scoreColumn && values[scoreColumn] === undefined && headerSet.has(scoreColumn) && !isBlank(raw[scoreColumn])) {
      const n = parseNumber(raw[scoreColumn]);
      if (Number.isFinite(n)) values[scoreColumn] = n;
    }

    const id = isBlank(raw[idColumn]) ? `ROW_${rowNo}` : String(raw[idColumn]).trim();
    if (!isBlank(raw[idColumn])) {
      const first = idSeen.get(id);
      if (first !== undefined) add('DUPLICATE_ID', 'warning', idColumn, id, `${idColumn} "${id}" ซ้ำกับแถวที่ ${first}`);
      else idSeen.set(id, rowNo);
    }

    if (!rejected) {
      const date = !isBlank(raw[dateColumn]) && isValidDate(raw[dateColumn]) ? String(raw[dateColumn]).trim() : null;
      clean.push({ row: rowNo, id, date, values, label, imputed });
    }
  });

  if (total > 0 && clean.length === 0) {
    blockingErrors.push({ type: 'MISSING_VALUE', severity: 'error', message: 'ไม่มีแถวที่ผ่านการตรวจสอบเลย — ดูรายละเอียดข้อผิดพลาดรายแถวด้านล่าง' });
  } else {
    const rejectedPct = ((total - clean.length) / total) * 100;
    if (rejectedPct > maxRejectedPct) {
      blockingErrors.push({
        type: 'MISSING_VALUE', severity: 'error',
        message: `แถวที่ไม่ผ่านการตรวจสอบมี ${rejectedPct.toFixed(1)}% (เกิน ${maxRejectedPct}%) — ผล PSI/CSI จากข้อมูลส่วนที่เหลือจะไม่เป็นตัวแทน จึงหยุดการคำนวณ`,
      });
    }
    if (clean.length < minRowsForDrift) {
      warnings.push({ type: 'EMPTY_FILE', severity: 'warning', message: `แถวที่ใช้ได้มีเพียง ${clean.length} แถว (< ${minRowsForDrift}) — ค่า PSI/CSI อาจแกว่งสูง` });
    }
  }

  const ok = blockingErrors.length === 0;
  return { result: summarize(total, clean.length, blockingErrors, warnings, rowIssues, maxIssues, ok), rows: ok ? clean : [] };
}

function summarize(
  total: number, valid: number, blockingErrors: ValidationIssue[], warnings: ValidationIssue[],
  rowIssues: ValidationIssue[], maxIssues: number, ok: boolean,
): ValidationResult {
  const groupMap = new Map<string, ValidationIssueGroup>();
  for (const is of rowIssues) {
    const k = `${is.type}|${is.severity}|${is.column ?? ''}`;
    const g = groupMap.get(k);
    if (g) { g.count++; if (g.sampleRows.length < 10 && is.row) g.sampleRows.push(is.row); }
    else groupMap.set(k, { type: is.type, severity: is.severity, column: is.column, count: 1, sampleRows: is.row ? [is.row] : [], message: is.message });
  }
  const groups = [...groupMap.values()].sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || b.count - a.count);
  const rejected = total - valid;
  return {
    ok,
    totalRows: total,
    validRows: valid,
    rejectedRows: rejected,
    rejectedPct: total ? Math.round((rejected / total) * 1000) / 10 : 0,
    blockingErrors,
    warnings,
    groups,
    issues: rowIssues.slice(0, maxIssues),
  };
}
