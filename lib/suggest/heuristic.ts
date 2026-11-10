/**
 * Heuristic (Rule-based) Suggestion Provider (Step 10c.A).
 *
 * Infers column roles and feature validation/anomaly settings purely from
 * `DatasetProfile` (column names, data types, uniqueness, quantiles, skewness).
 * Contains zero model-specific or dataset-specific hard-coded feature names.
 */
import { inferColumnsFromRows } from '../baselineValidation';
import { computeDistributionStats } from '../driftReport';
import { buildCategorySpecFromRows } from '../reference';
import { parseNumber } from '../validation';
import type { AnomalyTransform, MissingStrategy } from '../types';
import type {
  ColumnMappingEntry,
  ColumnProfileSummary,
  ColumnRole,
  ColumnSuggestion,
  DatasetProfile,
  FeatureSettingSuggestion,
  NumericColumnSummary,
  SuggestFeatureOptions,
  SuggestionProvider,
} from './types';

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[Math.min(base + 1, sorted.length - 1)];
  return sorted[base] + rest * (next - sorted[base]);
}

/**
 * Round up to a clean human-friendly number (2 significant digits for large values,
 * clean decimal steps for small ratios). Always >= value.
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value === 0) return 0;
  if (value < 0) return -niceFloor(-value);
  if (value <= 2) {
    return Math.ceil(value * 20) / 20; // step 0.05
  }
  if (value <= 10) {
    return Math.ceil(value * 10) / 10; // step 0.1
  }
  const mag = Math.pow(10, Math.floor(Math.log10(value)) - 1);
  return Math.ceil(value / mag) * mag;
}

export function niceFloor(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value === 0) return 0;
  if (value < 0) return -niceCeil(-value);
  if (value <= 2) {
    return Math.floor(value * 20) / 20;
  }
  if (value <= 10) {
    return Math.floor(value * 10) / 10;
  }
  const mag = Math.pow(10, Math.floor(Math.log10(value)) - 1);
  return Math.floor(value / mag) * mag;
}

/**
 * Builds a privacy-safe `DatasetProfile` from raw reference rows.
 * Only summary statistics and at most 5 sample values per column are included.
 */
export function buildDatasetProfile(
  referenceId: string,
  rows: Record<string, unknown>[],
  columns?: string[],
): DatasetProfile {
  const detected = inferColumnsFromRows(rows, columns);
  const rowCount = rows.length;

  const colSummaries: ColumnProfileSummary[] = detected.map(col => {
    const colName = col.column || col.name;
    const uniqueRatio = col.nonNullCount > 0 ? col.uniqueCount / col.nonNullCount : 0;
    const base: ColumnProfileSummary = {
      column: colName,
      inferredType: col.inferredType,
      nonNullCount: col.nonNullCount,
      missingCount: col.missingCount,
      missingRate: +col.missingRate.toFixed(6),
      uniqueCount: col.uniqueCount,
      uniqueRatio: +uniqueRatio.toFixed(6),
      sampleValues: col.sampleValues.slice(0, 5),
    };

    if (col.inferredType === 'numeric' || col.inferredType === 'binary') {
      const nums: number[] = [];
      for (const r of rows) {
        const n = parseNumber(r[colName]);
        if (Number.isFinite(n)) nums.push(n);
      }
      if (nums.length > 0) {
        const sorted = [...nums].sort((a, b) => a - b);
        const dist = computeDistributionStats(nums);
        const p0_5 = quantileSorted(sorted, 0.005);
        const p25 = quantileSorted(sorted, 0.25);
        const p75 = quantileSorted(sorted, 0.75);
        const p99_5 = quantileSorted(sorted, 0.995);
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const isBinaryZeroOne = sorted.every(v => v === 0 || v === 1);
        const numericStats: NumericColumnSummary = {
          min,
          max,
          mean: +dist.mean.toFixed(6),
          median: +dist.median.toFixed(6),
          sd: +dist.sd.toFixed(6),
          iqr: +dist.iqr.toFixed(6),
          p0_5: +p0_5.toFixed(6),
          p5: +dist.p5.toFixed(6),
          p25: +p25.toFixed(6),
          p75: +p75.toFixed(6),
          p95: +dist.p95.toFixed(6),
          p99_5: +p99_5.toFixed(6),
          skewness: +dist.skewness.toFixed(6),
          allNonNegative: min >= 0,
          isBinaryZeroOne,
        };
        base.numericStats = numericStats;
      }
    } else if (col.inferredType === 'categorical') {
      const built = buildCategorySpecFromRows(rows, colName);
      base.categories = built.spec.categories.slice(0, 50);
    }

    return base;
  });

  return {
    referenceId,
    rowCount,
    columns: colSummaries,
  };
}

// ─── Role matching patterns (case-insensitive, Thai + English) ───────────────
const DATE_NAME_RE = /(?:^|[_\s-]|\b)(date|dt|month|period)(?:$|[_\s-]|\b)|วันที่|เดือน|วันสมัคร/i;
const LABEL_NAME_RE = /(?:^|[_\s-]|\b)(flag|bad|default\w*|npl|target|dlq|delinq\w*)(?:$|[_\s-]|\b)|หนี้เสีย|ผิดนัด/i;
const SCORE_NAME_RE = /(?:^|[_\s-]|\b)(score|pd|prob|probability|rating|logit|\w*score)(?:$|[_\s-]|\b)|คะแนน/i;
const ID_NAME_RE = /(?:^|[_\s-]|\b)(id|no|cust\w*|app_id|app_no|acct\w*|account\w*|ref\w*)(?:$|[_\s-]|\b)|^app_|(?:_id|_no|id|no)$|รหัส|เลขที่/i;

function scoreColumnCandidates(col: ColumnProfileSummary): {
  role: ColumnRole;
  confidence: number;
  reason: string;
} {
  const name = col.column.trim();
  const isBinary01 =
    col.inferredType === 'binary' || Boolean(col.numericStats?.isBinaryZeroOne);
  const isNumeric = col.inferredType === 'numeric' || col.inferredType === 'binary';

  // 1. Check Date first (so columns like `app_month` match date, not `app_` id)
  if (col.inferredType === 'date' || (DATE_NAME_RE.test(name) && !isBinary01 && col.uniqueRatio < 0.85)) {
    const byType = col.inferredType === 'date';
    const byName = DATE_NAME_RE.test(name);
    return {
      role: 'date',
      confidence: byType && byName ? 0.96 : byType ? 0.90 : 0.85,
      reason: byType
        ? `รูปแบบข้อมูลเป็นวันที่และชื่อคอลัมน์ "${name}" สื่อถึงเวลา/งวดข้อมูล`
        : `ชื่อคอลัมน์ "${name}" มีคำสำคัญเกี่ยวกับวันที่/เดือน (date/dt/month/วันที่)`,
    };
  }

  // 2. Check Label (must be binary 0/1)
  if (isBinary01 && LABEL_NAME_RE.test(name)) {
    return {
      role: 'label',
      confidence: 0.95,
      reason: `ชื่อคอลัมน์ "${name}" สื่อถึงตัวแปรเป้าหมาย (flag/bad/default/npl/หนี้เสีย) และมีค่าเป็น 0/1 เท่านั้น`,
    };
  }

  // 3. Check ID (high uniqueness + ID keyword)
  if (ID_NAME_RE.test(name) && col.uniqueRatio >= 0.80 && !SCORE_NAME_RE.test(name)) {
    const pctUnique = (col.uniqueRatio * 100).toFixed(1);
    return {
      role: 'id',
      confidence: col.uniqueRatio >= 0.98 ? 0.97 : 0.88,
      reason: `ชื่อคอลัมน์ "${name}" สื่อถึงรหัสอ้างอิง (id/no/cust/รหัส) และค่าไม่ซ้ำกัน ${pctUnique}% ของแถวทั้งหมด`,
    };
  }

  // 4. Check Score (numeric + score/pd/prob/คะแนน keyword)
  if (isNumeric && !isBinary01 && SCORE_NAME_RE.test(name)) {
    return {
      role: 'score',
      confidence: 0.93,
      reason: `ชื่อคอลัมน์ "${name}" สื่อถึงคะแนนหรือความน่าจะเป็นผิดนัด (score/pd/prob/คะแนน) และเป็นข้อมูลตัวเลข`,
    };
  }

  // 5. High-cardinality text (> 50 unique values and not ID/date) → ignore
  if (col.inferredType === 'string' && col.uniqueCount > 50) {
    // Unless it is nearly 100% unique and looks like an identifier when no other ID matched
    return {
      role: 'ignore',
      confidence: 0.85,
      reason: `คอลัมน์ข้อความที่มีค่าไม่ซ้ำกันสูงถึง ${col.uniqueCount} ค่า (> 50 ค่า) และไม่ใช่รหัสหลัก แนะนำให้ข้าม (ignore)`,
    };
  }

  // 6. Default: Feature
  if (col.inferredType === 'categorical') {
    return {
      role: 'feature',
      confidence: 0.86,
      reason: `ตัวแปรแบบกลุ่ม (categorical) พบ ${col.uniqueCount} หมวดหมู่ เหมาะสำหรับตรวจการเลื่อนไหลของสัดส่วนลูกค้า`,
    };
  }

  return {
    role: 'feature',
    confidence: 0.88,
    reason: `ตัวแปรเชิงตัวเลข (${col.uniqueCount} ค่าไม่ซ้ำ) เหมาะสำหรับใช้เป็นตัวแปรโมเดลและตรวจติดตามการกระจายตัว`,
  };
}

export const heuristicProvider: SuggestionProvider = {
  name: 'heuristic',

  suggestColumns(profile: DatasetProfile): ColumnSuggestion[] {
    const drafts: ColumnSuggestion[] = profile.columns.map(col => {
      const cand = scoreColumnCandidates(col);
      return {
        column: col.column,
        role: cand.role,
        type: col.inferredType,
        confidence: cand.confidence,
        reason: cand.reason,
      };
    });

    // Enforce at most 1 primary column for singleton roles ('id', 'label', 'score', 'date')
    const singletonRoles: ColumnRole[] = ['id', 'label', 'score', 'date'];
    for (const singleRole of singletonRoles) {
      const matches = drafts
        .map((d, idx) => ({ d, idx, col: profile.columns[idx] }))
        .filter(x => x.d.role === singleRole);
      if (matches.length > 1) {
        matches.sort((a, b) => {
          if (b.d.confidence !== a.d.confidence) return b.d.confidence - a.d.confidence;
          return b.col.uniqueRatio - a.col.uniqueRatio;
        });
        for (let i = 1; i < matches.length; i++) {
          const { idx, col } = matches[i];
          const fallbackRole: ColumnRole =
            col.inferredType === 'string' && col.uniqueCount > 50 ? 'ignore' : 'feature';
          drafts[idx] = {
            ...drafts[idx],
            role: fallbackRole,
            confidence: 0.70,
            reason: `มีคอลัมน์อื่นที่เหมาะสมเป็น ${singleRole} มากกว่า จึงกำหนดเป็น ${fallbackRole}`,
          };
        }
      }
    }

    // Fallback if no 'id' was matched by name: pick first column with uniqueRatio >= 0.98
    if (!drafts.some(d => d.role === 'id')) {
      const idx = profile.columns.findIndex(c => c.uniqueRatio >= 0.98);
      if (idx !== -1) {
        drafts[idx] = {
          column: profile.columns[idx].column,
          role: 'id',
          type: profile.columns[idx].inferredType,
          confidence: 0.75,
          reason: `ทุกแถวมีค่าไม่ซ้ำกัน (${(profile.columns[idx].uniqueRatio * 100).toFixed(1)}%) จึงแนะนำให้ใช้เป็นคอลัมน์รหัสอ้างอิง (id)`,
        };
      }
    }

    return drafts;
  },

  suggestFeatureSettings(
    profile: DatasetProfile,
    mapping: ColumnMappingEntry[],
    options: SuggestFeatureOptions = {},
  ): FeatureSettingSuggestion[] {
    const scoringSet = new Set(options.scoringFeatures ?? []);
    const colMap = new Map<string, ColumnProfileSummary>(
      profile.columns.map(c => [c.column, c]),
    );

    const effectiveMapping: ColumnMappingEntry[] =
      mapping && mapping.length > 0
        ? mapping
        : (this.suggestColumns(profile) as ColumnSuggestion[]).map(s => ({
            column: s.column,
            role: s.role,
            type: s.type,
          }));

    const out: FeatureSettingSuggestion[] = [];

    for (const entry of effectiveMapping) {
      if (entry.role !== 'feature') continue;
      const col = colMap.get(entry.column);
      if (!col) continue;

      const dataType = entry.type || col.inferredType;
      const isScoringFeature = scoringSet.has(entry.column);

      if (dataType === 'categorical') {
        const cats = col.categories ?? [];
        out.push({
          feature: entry.column,
          dataType: 'categorical',
          minValue: null,
          maxValue: null,
          anomalyTransform: 'none',
          missingStrategy: isScoringFeature ? 'reject' : 'fillMode',
          categories: cats,
          reason: `ตัวแปรแบบกลุ่ม (${cats.length} หมวดหมู่ใน Reference) — แนะนำให้เติมค่าว่างด้วยหมวดที่พบบ่อยที่สุด (fillMode)`,
        });
        continue;
      }

      const st = col.numericStats;
      if (!st) {
        out.push({
          feature: entry.column,
          dataType,
          minValue: null,
          maxValue: null,
          anomalyTransform: 'none',
          missingStrategy: isScoringFeature ? 'reject' : 'fillMedian',
          reason: 'ไม่มีสถิติเชิงตัวเลขใน Reference — ใช้ค่าเริ่มต้นมาตรฐาน',
        });
        continue;
      }

      // Compute minValue: if all values >= 0 -> 0; else p0.5 - 3*IQR (ensuring <= st.min)
      let minValue: number;
      let minReason: string;
      if (st.allNonNegative) {
        minValue = 0;
        minReason = `ค่าใน Reference ไม่ติดลบ (ต่ำสุด = ${st.min.toLocaleString('en-US')}) จึงตั้งค่าต่ำสุด = 0`;
      } else {
        const rawLower = st.p0_5 - 3 * st.iqr;
        minValue = Math.min(st.min, niceFloor(rawLower));
        minReason = `พบค่าติดลบใน Reference จึงคำนวณจาก p0.5 − 3×IQR ปัดลงได้ ${minValue.toLocaleString('en-US')}`;
      }

      // Compute maxValue: p99.5 + 3*IQR rounded to clean number, ensuring:
      //   1. maxValue >= st.max (every Reference row is inside [minValue, maxValue])
      //   2. (maxValue - minValue) <= 10 * st.max (when st.max > 0)
      const rawUpper = Math.max(st.max, st.p99_5 + 3 * st.iqr);
      let maxValue = niceCeil(rawUpper);
      if (maxValue < st.max) maxValue = st.max;
      if (st.max > 0 && maxValue - minValue > 10 * st.max) {
        const cap = niceFloor(minValue + 10 * st.max);
        maxValue = cap >= st.max ? cap : minValue + 10 * st.max;
      }

      const anomalyTransform: AnomalyTransform =
        st.skewness > 2 && st.min >= 0 ? 'log1p' : 'none';
      const missingStrategy: MissingStrategy = isScoringFeature ? 'reject' : 'fillMedian';

      const reasonParts = [
        minReason,
        `ค่าสูงสุดแนะนำ = ${maxValue.toLocaleString('en-US')} (จาก p99.5 + 3×IQR ปัดเป็นเลขกลม โดยค่าสูงสุดใน Reference = ${st.max.toLocaleString('en-US')})`,
        anomalyTransform === 'log1p'
          ? `ความเบ้สูง (skewness = ${st.skewness.toFixed(2)} > 2) และค่าไม่ติดลบ จึงแนะนำ anomalyTransform = log1p`
          : `ความเบ้อยู่ในเกณฑ์ปกติ (skewness = ${st.skewness.toFixed(2)}) ใช้ anomalyTransform = none`,
        isScoringFeature
          ? 'เป็นตัวแปรในสกอร์การ์ดจึงตั้ง missingStrategy = reject'
          : 'ตั้ง missingStrategy = fillMedian เพื่อรองรับแถวที่มีค่าว่างบางส่วน',
      ];

      out.push({
        feature: entry.column,
        dataType: dataType === 'binary' ? 'binary' : 'numeric',
        minValue,
        maxValue,
        anomalyTransform,
        missingStrategy,
        reason: reasonParts.join(' · '),
      });
    }

    return out;
  },
};

