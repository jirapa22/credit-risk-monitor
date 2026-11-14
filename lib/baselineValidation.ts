/**
 * Automatic Baseline Validator (Step 10a.4).
 *
 * Validates a `BaselineVersion` (or model config) against its Reference dataset
 * before allowing transition from `DRAFT` → `VALIDATED`.
 */
import type {
  AnomalyTransform,
  BaselineMode,
  BaselineValidationIssue,
  BaselineValidationReport,
  BaselineVersion,
  DetectedColumnSchema,
  FeatureDataType,
  FeatureDefinition,
  ReferenceDatasetMeta,
  ScoringConfig,
} from './types';
import { buildReferenceProfileFromData } from './reference';
import { DEFAULT_ID_COLUMN, DEFAULT_LABEL_COLUMN } from './defaults';
import { computeRowsSha256, type ReferenceDatasetBlob } from './storage/blob';
import { validateScoringConfig } from './scoring';
import { importModelTableFromRows, type ScorecardComparisonReport } from './scorecardImport';
import { isValidDate, parseNumber } from './validation';
import {
  assessMetricReliability,
  calculateAUC,
  calculateGini,
  calculateKS,
  defaultBinLabels,
  quantileBoundaries,
  type DataPoint,
  type ScoreDirection,
} from './stats';
import { computeDistributionStats } from './driftReport';
import { fitMultivariate } from './anomaly/multivariate';
import { referenceFlaggedIndices, resolveAnomalyConfig } from './anomaly';

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

export interface ValidateBaselineOptions {
  minReferenceRows?: number; // default 200
  minBads?: number;          // default 30
}

/**
 * Infers column schemas from raw reference rows (used by `POST /api/registry/references` for Step 10c).
 */
function hashColumnName(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createRng(seed: number) {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function inferColumnsFromRows(
  rows: Record<string, unknown>[],
  columns?: string[],
): DetectedColumnSchema[] {
  const cols =
    columns && columns.length > 0
      ? columns
      : rows.length > 0
        ? Object.keys(rows[0])
        : [];
  const total = rows.length;
  // Track row usage across columns to prevent samples from reconstructing full customer rows (PDPA)
  const rowUsageCount = new Array(total).fill(0);

  return cols.map(name => {
    const nonBlank: unknown[] = [];
    const nonBlankEntries: { rowIdx: number; val: unknown; strVal: string }[] = [];
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const val = rows[rIdx][name];
      if (!isBlank(val)) {
        nonBlank.push(val);
        nonBlankEntries.push({ rowIdx: rIdx, val, strVal: String(val).trim() });
      }
    }
    const nonNullCount = nonBlank.length;
    const missingCount = total - nonNullCount;
    const missingRate = total > 0 ? missingCount / total : 0;
    const uniqueSet = new Set(nonBlank.map(v => String(v).trim()));
    const lowerUniqueSet = new Set(nonBlank.map(v => String(v).trim().toLowerCase()));

    // Independent per-column PRNG seeded with column name hash
    const colRng = createRng(hashColumnName(name) ^ 0x85ebca6b);

    // Group non-blank entries by unique string value, selecting row with lowest current usage
    const uniqueMap = new Map<string, { rowIdx: number; val: unknown; usage: number }>();
    for (const entry of nonBlankEntries) {
      const existing = uniqueMap.get(entry.strVal);
      const usage = rowUsageCount[entry.rowIdx];
      if (!existing || usage < existing.usage) {
        uniqueMap.set(entry.strVal, { rowIdx: entry.rowIdx, val: entry.val, usage });
      }
    }

    // Convert to candidate list and sort by lowest rowUsageCount first (ties randomized via colRng)
    const uniqueCandidates = Array.from(uniqueMap.values());
    uniqueCandidates.sort((a, b) => {
      if (a.usage !== b.usage) return a.usage - b.usage;
      return colRng() - 0.5;
    });

    const chosen = uniqueCandidates.slice(0, 5);

    // Mark row usage so subsequent columns pick different rows
    for (const c of chosen) {
      rowUsageCount[c.rowIdx]++;
    }

    // Shuffle the chosen sample values using column PRNG so order is not in row order
    for (let i = chosen.length - 1; i > 0; i--) {
      const j = Math.floor(colRng() * (i + 1));
      const tmp = chosen[i];
      chosen[i] = chosen[j];
      chosen[j] = tmp;
    }

    const sampleValues: (string | number)[] = chosen.map(c => {
      const n = parseNumber(c.val);
      return Number.isFinite(n) ? n : String(c.val);
    });

    let inferredType: FeatureDataType = 'string';
    let monitoringEnabled = true;
    let warning: string | undefined;
    if (nonNullCount > 0) {
      const numCount = nonBlank.filter(v => Number.isFinite(parseNumber(v))).length;
      const dateCount = nonBlank.filter(v => isValidDate(v)).length;
      if (numCount / nonNullCount >= 0.95) {
        const allBinary = nonBlank.every(v => {
          const n = parseNumber(v);
          return n === 0 || n === 1;
        });
        inferredType = allBinary && uniqueSet.size <= 2 ? 'binary' : 'numeric';
      } else if (dateCount / nonNullCount >= 0.90) {
        inferredType = 'date';
        monitoringEnabled = false;
      } else if (lowerUniqueSet.size <= 50) {
        inferredType = 'categorical';
        monitoringEnabled = true;
      } else {
        inferredType = 'string';
        monitoringEnabled = false;
        warning = `คอลัมน์ "${name}" มีหมวดหมู่ไม่ซ้ำกัน ${lowerUniqueSet.size} หมวด (> 50 หมวด) — แนะนำเป็น string และไม่เปิดการตรวจติดตาม (monitoringEnabled = false)`;
      }
    }

    return {
      name,
      column: name,
      inferredType,
      nonNullCount,
      missingCount,
      missingRate,
      uniqueCount: lowerUniqueSet.size > 0 && inferredType === 'categorical' ? lowerUniqueSet.size : uniqueSet.size,
      sampleValues,
      monitoringEnabled,
      ...(warning ? { warning } : {}),
    };
  });
}

/**
 * Normalizes a `BaselineVersion` or legacy model config into a unified shape for validation.
 */
function normalizeBaselineSpec(baseline: BaselineVersion | any) {
  const modelId: string = String(baseline.modelId ?? baseline.id ?? 'unknown_model');
  const mode: BaselineMode =
    baseline.mode ??
    (baseline.scoring?.scorecard && Object.keys(baseline.scoring.scorecard).length > 0
      ? 'scorecard'
      : 'score_column');
  const idColumn: string = String(
    baseline.columns?.idColumn ?? baseline.idColumn ?? DEFAULT_ID_COLUMN,
  );
  const dateColumn: string | null =
    baseline.columns !== undefined
      ? (baseline.columns.dateColumn ?? null)
      : (baseline.dateColumn ?? null);
  const labelColumn: string | null =
    baseline.columns !== undefined
      ? (baseline.columns.labelColumn ?? null)
      : (baseline.labelColumn ?? DEFAULT_LABEL_COLUMN);
  const scoreColumn: string | null =
    baseline.columns !== undefined
      ? (baseline.columns.scoreColumn ?? null)
      : (baseline.scoreColumn ?? null);
  const scoreDirection: ScoreDirection =
    baseline.scoreDirection === 'higher_is_riskier' ? 'higher_is_riskier' : 'higher_is_safer';
  const featureRegistry = (baseline.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const scoring = baseline.scoring as ScoringConfig | undefined;
  const thresholds = baseline.thresholds ?? {
    psi_warning: 0.10,
    psi_critical: 0.25,
    gini_min: 0.10,
    auc_min: 0.55,
    ks_min: 0.10,
    csi_features: {},
  };
  const referenceDatasetId: string = String(baseline.referenceDatasetId ?? '');
  return {
    modelId,
    mode,
    idColumn,
    dateColumn,
    labelColumn,
    scoreColumn,
    scoreDirection,
    featureRegistry,
    scoring,
    thresholds,
    referenceDatasetId,
    anomalyConfig: baseline.anomalyConfig,
    modelCard: baseline.modelCard,
    developmentStats: baseline.developmentStats,
    modelTable: baseline.modelTable,
  };
}

export function validateBaseline(
  baseline: BaselineVersion | any,
  referenceInput:
    | ReferenceDatasetBlob
    | { meta?: Partial<ReferenceDatasetMeta>; rows: Record<string, unknown>[]; columns?: string[] }
    | Record<string, unknown>[],
  options: ValidateBaselineOptions = {},
): BaselineValidationReport {
  const minReferenceRows = options.minReferenceRows ?? 200;
  const minBads = options.minBads ?? 30;
  const spec = normalizeBaselineSpec(baseline);

  const rawRows: Record<string, unknown>[] = Array.isArray(referenceInput)
    ? referenceInput
    : (referenceInput?.rows ?? []);
  const explicitCols =
    !Array.isArray(referenceInput) &&
    (referenceInput?.meta?.columns || (referenceInput as any)?.columns);
  const columns: string[] =
    Array.isArray(explicitCols) && explicitCols.length > 0
      ? [...explicitCols]
      : rawRows.length > 0
        ? Object.keys(rawRows[0])
        : [];
  const colSet = new Set(columns);

  const referenceId =
    (!Array.isArray(referenceInput) && referenceInput?.meta?.referenceId) ||
    spec.referenceDatasetId ||
    'unknown_reference';
  const sha256 =
    (!Array.isArray(referenceInput) && referenceInput?.meta?.sha256) ||
    computeRowsSha256(rawRows, columns);

  const errors: BaselineValidationIssue[] = [];
  const warnings: BaselineValidationIssue[] = [];

  // ── 1. Row count check ────────────────────────────────────────────────────
  const rowCount = rawRows.length;
  if (rowCount < minReferenceRows) {
    errors.push({
      code: 'INSUFFICIENT_ROWS',
      message: `จำนวนแถวของ Reference Dataset มีเพียง ${rowCount} แถว ซึ่งน้อยกว่าเกณฑ์ขั้นต่ำ (${minReferenceRows} แถว)`,
    });
  }

  // ── 2. Required column presence checks (columns + featureRegistry) ────────
  if (!spec.idColumn || !colSet.has(spec.idColumn)) {
    errors.push({
      code: 'MISSING_ID_COLUMN',
      field: spec.idColumn,
      message: `ไม่พบคอลัมน์รหัสอ้างอิง (idColumn) "${spec.idColumn}" ใน Reference Dataset`,
    });
  }
  if (spec.dateColumn && !colSet.has(spec.dateColumn)) {
    errors.push({
      code: 'MISSING_DATE_COLUMN',
      field: spec.dateColumn,
      message: `ไม่พบคอลัมน์วันที่ (dateColumn) "${spec.dateColumn}" ที่ระบุไว้ใน Reference Dataset`,
    });
  }
  if (spec.labelColumn && baseline.columns?.labelColumn && !colSet.has(spec.labelColumn)) {
    errors.push({
      code: 'MISSING_LABEL_COLUMN',
      field: spec.labelColumn,
      message: `ไม่พบคอลัมน์ผลลัพธ์ (labelColumn) "${spec.labelColumn}" ที่ระบุไว้ใน Reference Dataset`,
    });
  }

  const specialCols = new Set<string>([spec.idColumn]);
  if (spec.dateColumn) specialCols.add(spec.dateColumn);
  if (spec.labelColumn) specialCols.add(spec.labelColumn);
  if (spec.scoreColumn) specialCols.add(spec.scoreColumn);

  const numericFeatureKeys = new Set<string>();
  for (const [key, def] of Object.entries(spec.featureRegistry)) {
    const col = def.columnName || key;
    const isOptionalSpecial =
      (col === spec.dateColumn || col === spec.labelColumn) && !def.required;
    if (!colSet.has(col)) {
      if (!isOptionalSpecial) {
        errors.push({
          code: 'MISSING_FEATURE_COLUMN',
          field: col,
          message: `ไม่พบคอลัมน์ตัวแปร "${col}" (${def.displayName || key}) ใน Reference Dataset`,
        });
      }
      continue;
    }
    if (def.dataType === 'numeric' && !specialCols.has(key) && !specialCols.has(col)) {
      numericFeatureKeys.add(key);
    }
  }

  if (spec.mode === 'scorecard') {
    for (const f of spec.scoring?.features ?? []) {
      numericFeatureKeys.add(f);
      if (!colSet.has(f)) {
        errors.push({
          code: 'MISSING_SCORECARD_FEATURE',
          field: f,
          message: `ไม่พบคอลัมน์ตัวแปรในสกอร์การ์ด "${f}" ใน Reference Dataset`,
        });
      }
    }
  }

  // ── 3. Numeric parse rate >= 95% ──────────────────────────────────────────
  for (const key of numericFeatureKeys) {
    const def = spec.featureRegistry[key];
    const col = def?.columnName || key;
    if (!colSet.has(col) || rowCount === 0) continue;
    let validNums = 0;
    for (const r of rawRows) {
      const n = parseNumber(r[col]);
      if (Number.isFinite(n)) validNums++;
    }
    const rate = validNums / rowCount;
    if (rate < 0.95) {
      errors.push({
        code: 'NUMERIC_PARSE_RATE_LOW',
        field: col,
        message: `ตัวแปร "${def?.displayName || col}" แปลงเป็นตัวเลขได้เพียง ${(rate * 100).toFixed(1)}% (< 95%)`,
      });
    }
  }

  // ── 4. Mode-specific validation ('scorecard' vs 'score_column') ───────────
  if (spec.mode === 'scorecard') {
    if (!spec.scoring || !Array.isArray(spec.scoring.features) || spec.scoring.features.length === 0) {
      errors.push({
        code: 'INVALID_SCORECARD',
        message: 'โหมด scorecard ต้องกำหนดโครงสร้าง scoring และรายการ features อย่างน้อย 1 ตัวแปร',
      });
    } else {
      const scProblems = validateScoringConfig(spec.scoring);
      for (const p of scProblems) {
        errors.push({
          code: 'INVALID_SCORECARD',
          message: `โครงสร้างสกอร์การ์ดไม่ถูกต้อง: ${p}`,
        });
      }
    }
  } else if (spec.mode === 'score_column') {
    if (!spec.scoreColumn) {
      warnings.push({
        code: 'NO_SCORE_COLUMN_CSI_ONLY',
        message: 'ไม่มีสกอร์การ์ดและไม่ได้ระบุคอลัมน์คะแนน (scoreColumn) — จะคำนวณได้เฉพาะ CSI รายตัวแปร (Score PSI และ Concept Drift จะเป็น NOT_AVAILABLE)',
      });
    } else if (!colSet.has(spec.scoreColumn)) {
      errors.push({
        code: 'MISSING_SCORE_COLUMN',
        field: spec.scoreColumn,
        message: `ไม่พบคอลัมน์คะแนน "${spec.scoreColumn}" ใน Reference Dataset`,
      });
    } else if (rowCount > 0) {
      let validScores = 0;
      for (const r of rawRows) {
        if (Number.isFinite(parseNumber(r[spec.scoreColumn]))) validScores++;
      }
      const rate = validScores / rowCount;
      if (rate < 0.95) {
        errors.push({
          code: 'INVALID_SCORE_COLUMN',
          field: spec.scoreColumn,
          message: `คอลัมน์คะแนน "${spec.scoreColumn}" แปลงเป็นตัวเลขได้เพียง ${(rate * 100).toFixed(1)}% (< 95%)`,
        });
      }
    }
  }

  // ── 4b. Model Card & Development Statistics validation ───────────────────
  const modelCard = spec.modelCard || baseline.modelCard;
  if (modelCard) {
    if (modelCard.sampleSize !== undefined && modelCard.sampleSize <= 0) {
      warnings.push({
        code: 'INVALID_SAMPLE_SIZE',
        message: 'sampleSize ใน Model Card ต้องมีค่ามากกว่า 0',
      });
    }
  }

  const devStats = spec.developmentStats || baseline.developmentStats;
  if (devStats?.reported) {
    const rep = devStats.reported;
    const splits = ['train', 'test', 'oot', 'overall'] as const;
    for (const sp of splits) {
      const s = rep[sp];
      if (!s) continue;
      if (s.auc !== undefined && (s.auc < 0.5 || s.auc > 1.0)) {
        warnings.push({
          code: 'OUT_OF_RANGE_DEV_STAT',
          message: `ค่า AUC (${s.auc}) ของชุด ${sp} อยู่นอกช่วงปกติ (0.50–1.00)`,
        });
      }
      if (s.gini !== undefined && (s.gini < -1.0 || s.gini > 1.0)) {
        warnings.push({
          code: 'OUT_OF_RANGE_DEV_STAT',
          message: `ค่า Gini (${s.gini}) ของชุด ${sp} อยู่นอกช่วงปกติ (-1.00 ถึง 1.00)`,
        });
      }
      if (s.ks !== undefined && (s.ks < 0.0 || s.ks > 1.0)) {
        warnings.push({
          code: 'OUT_OF_RANGE_DEV_STAT',
          message: `ค่า KS (${s.ks}) ของชุด ${sp} อยู่นอกช่วงปกติ (0.00–1.00)`,
        });
      }
      if (s.badRate !== undefined && (s.badRate < 0.0 || s.badRate > 1.0)) {
        warnings.push({
          code: 'OUT_OF_RANGE_DEV_STAT',
          message: `ค่า Bad Rate (${s.badRate}) ของชุด ${sp} อยู่นอกช่วงปกติ (0.00–1.00)`,
        });
      }
    }
  }

  // Coerce numeric cells in a copy of rows so buildReferenceProfileFromData works on CSV-parsed rows
  const typedRows: Record<string, string | number | null | undefined>[] = rawRows.map(r => {
    const out: Record<string, string | number | null | undefined> = {};
    for (const c of columns) {
      const v = r[c];
      if (isBlank(v)) {
        out[c] = null;
      } else if (typeof v === 'number') {
        out[c] = v;
      } else {
        const n = parseNumber(v);
        out[c] = Number.isFinite(n) && c !== spec.idColumn && c !== spec.dateColumn ? n : String(v);
      }
    }
    return out;
  });

  // ── 5. Label & Bad count warnings ─────────────────────────────────────────
  const labelCol = spec.labelColumn && colSet.has(spec.labelColumn) ? spec.labelColumn : undefined;
  let labeledRowCount = 0;
  let badCount = 0;
  if (labelCol) {
    for (const r of typedRows) {
      const v = r[labelCol];
      if (v === 0 || v === 1) {
        labeledRowCount++;
        if (v === 1) badCount++;
      }
    }
  }
  const hasLabels = labeledRowCount > 0;
  const badRate = hasLabels ? badCount / labeledRowCount : null;

  if (!hasLabels) {
    warnings.push({
      code: 'NO_LABELS',
      field: spec.labelColumn ?? undefined,
      message: 'ไม่มีคอลัมน์ผลลัพธ์ (label) หรือไม่มีข้อมูล 0/1 — ส่วน Label Drift และ Concept Drift จะเป็น NOT_AVAILABLE',
    });
  } else if (badCount < minBads) {
    warnings.push({
      code: 'LOW_BAD_COUNT',
      field: spec.labelColumn ?? undefined,
      message: `จำนวนหนี้เสีย (Bad) ใน Reference มีเพียง ${badCount} ราย (< ${minBads} ราย) — ค่า AUC/Gini/KS และ Concept Drift อาจมีความผันผวนสูง`,
    });
  }

  // Build ReferenceProfile when no blocking column/scorecard errors prevent it
  const meta: ReferenceDatasetMeta = {
    referenceId,
    version: '1.0.0',
    modelId: spec.modelId,
    description: '',
    source: '',
    createdAt: new Date().toISOString(),
    rowCount,
    badCount,
    badRate: badRate ?? 0,
    periodStart: '',
    periodEnd: '',
    columns,
    sha256,
  };

  const canBuildProfile =
    rowCount > 0 &&
    !errors.some(e =>
      ['MISSING_FEATURE_COLUMN', 'MISSING_SCORECARD_FEATURE', 'INVALID_SCORECARD', 'MISSING_SCORE_COLUMN', 'INVALID_SCORE_COLUMN', 'NUMERIC_PARSE_RATE_LOW'].includes(e.code),
    );

  const autoGeneratedBins: Record<string, { boundaries: number[]; binLabels: string[] }> = {};
  const featureSkewness: Record<
    string,
    { skewness: number; anomalyTransform: AnomalyTransform; recommendLog1p: boolean }
  > = {};
  let performanceReport: BaselineValidationReport['computed']['performance'] = null;
  let referenceFlaggedCount = 0;
  let referenceFlaggedPct = 0;
  let multivariateFitMs = 0;

  if (canBuildProfile) {
    const profile = buildReferenceProfileFromData(
      { meta, rows: typedRows },
      spec.mode === 'scorecard' ? spec.scoring : null,
      {
        labelColumn: labelCol,
        scoreColumn: spec.mode === 'score_column' ? (spec.scoreColumn ?? undefined) : undefined,
        featureRegistry: spec.featureRegistry,
      },
    );

    // ── 6. Binning & Skewness warnings ──────────────────────────────────────
    for (const key of numericFeatureKeys) {
      const def = spec.featureRegistry[key];
      const displayName = def?.displayName || key;
      const vals = (profile.features[key] ?? []).filter(Number.isFinite);
      if (vals.length === 0) continue;

      const hasConfigBins =
        Boolean(def?.binning?.boundaries?.length) ||
        Boolean(spec.thresholds?.csi_features?.[key]?.bins?.length);
      if (!hasConfigBins) {
        const boundaries = quantileBoundaries(vals, 10);
        const binLabels = defaultBinLabels(boundaries);
        autoGeneratedBins[key] = { boundaries, binLabels };
        warnings.push({
          code: 'AUTO_QUANTILE_BINS',
          field: key,
          message: `ตัวแปร "${displayName}" ไม่ได้กำหนดช่วง Bin — ระบบสร้างช่วง Quantile 10 กลุ่มอัตโนมัติ`,
        });
      }

      const dist = computeDistributionStats(vals);
      const transform: AnomalyTransform = def?.anomalyTransform ?? 'none';
      const recommendLog1p = Math.abs(dist.skewness) > 2 && transform !== 'log1p';
      featureSkewness[key] = {
        skewness: +dist.skewness.toFixed(4),
        anomalyTransform: transform,
        recommendLog1p,
      };
      if (recommendLog1p) {
        warnings.push({
          code: 'HIGH_SKEWNESS_RECOMMEND_LOG1P',
          field: key,
          message: `ตัวแปร "${displayName}" มีความเบ้สูง (skewness = ${dist.skewness.toFixed(2)}) และยังไม่ได้ตั้ง anomalyTransform — แนะนำให้ตั้งเป็น log1p`,
        });
      }
    }

    // ── 7. Reference AUC / Gini / KS & scoreDirection warning ───────────────
    if (profile.hasLabels && profile.hasScores) {
      const pts: DataPoint[] = profile.scores.map((s, i) => ({
        score: s,
        label: profile.labels[i],
      }));
      const auc = calculateAUC(pts, spec.scoreDirection);
      const gini = calculateGini(pts, spec.scoreDirection);
      const ks = calculateKS(pts);
      const rel = assessMetricReliability(pts, auc, ks, minBads);
      performanceReport = {
        auc,
        gini,
        ks,
        reliable: rel.reliable,
        warnings: rel.warnings,
      };
      if (auc < 0.55) {
        warnings.push({
          code: 'LOW_REFERENCE_AUC',
          field: 'scoreDirection',
          message: `AUC บน Reference = ${auc.toFixed(4)} (< 0.55) — กรุณาตรวจสอบการตั้งค่า scoreDirection (${spec.scoreDirection})`,
        });
      }
    }

    // ── 8. Verify IF/LOF Multivariate Fit & Reference Flagged % ─────────────
    try {
      const registryForFit: Record<string, FeatureDefinition> = { ...spec.featureRegistry };
      for (const f of numericFeatureKeys) {
        if (!registryForFit[f]) {
          registryForFit[f] = {
            columnName: f,
            displayName: f,
            dataType: 'numeric',
            required: true,
            monitoringEnabled: true,
          };
        }
      }
      const modelLike = {
        id: spec.modelId,
        featureRegistry: registryForFit,
        anomalyConfig: spec.anomalyConfig,
      };
      const cfg = resolveAnomalyConfig(modelLike, profile);
      const t0 = performance.now();
      const fit = fitMultivariate(profile, registryForFit, {
        nTrees: cfg.nTrees,
        sampleSize: cfg.sampleSize,
        seed: cfg.seed,
        k: cfg.k,
        contamination: cfg.contamination,
      });
      const elapsed = performance.now() - t0;
      multivariateFitMs = +(fit.fitMs || elapsed).toFixed(2);

      const flaggedSet = referenceFlaggedIndices(profile, modelLike);
      referenceFlaggedCount = flaggedSet.size;
      referenceFlaggedPct = rowCount > 0 ? +((referenceFlaggedCount / rowCount) * 100).toFixed(2) : 0;
    } catch (err) {
      errors.push({
        code: 'MULTIVARIATE_FIT_FAILED',
        message: `ไม่สามารถ Fit โมเดลตรวจจับความผิดปกติ (IF/LOF) บน Reference Dataset ได้: ${String(err)}`,
      });
    }
  }

  // ── 9. Model Table Consistency Check (Optional) ───────────────────────────
  let modelTableComparison: ScorecardComparisonReport | null = null;
  const rawModelTable = baseline.modelTable || spec.modelTable;
  if (rawModelTable && Array.isArray(rawModelTable.rows) && rawModelTable.rows.length > 0 && spec.scoreColumn) {
    const res = importModelTableFromRows(rawModelTable.rows, {
      referenceRows: typedRows,
      scoreColumn: spec.scoreColumn,
      tolerancePct: 95,
    });
    if (res.scoreComparison) {
      modelTableComparison = res.scoreComparison;
      for (const w of res.warnings) {
        warnings.push({
          code: 'LOW_MODEL_TABLE_SCORE_MATCH',
          message: w,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    validatedAt: new Date().toISOString(),
    referenceId,
    sha256,
    errors,
    warnings,
    computed: {
      rowCount,
      hasLabels,
      labeledRowCount,
      badCount,
      badRate,
      performance: performanceReport,
      autoGeneratedBins,
      featureSkewness,
      referenceFlaggedCount,
      referenceFlaggedPct,
      multivariateFitMs,
      modelTableComparison,
    },
  };
}
