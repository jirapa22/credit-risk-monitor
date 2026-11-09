/**
 * Anomaly Screening (layers 3–4) — single entry point used by the pipeline.
 *
 *   CleanRow[] ──► univariate (IQR / MAD / cross-field) ─┐
 *              └─► multivariate (Isolation Forest / LOF) ┴─► AnomalyResult
 *
 * Warning-only: rows are never removed here. The pipeline uses the result to
 * compute a what-if drift without flagged rows; the user decides what to exclude.
 *
 * Every option is read from model.anomalyConfig first, then code defaults; the
 * resolved values are stored in configSnapshot so a run can be reproduced.
 */
import type {
  AnomalyConfigSnapshot, AnomalyFlag, AnomalyFlaggedRow, AnomalyMethod, AnomalyResult, AnomalyTransform,
  FeatureDefinition, StoredAnomalyFlag,
} from '../types';
import type { ReferenceProfile } from '../reference';
import type { CleanRow } from '../validation';
import { resolveModelColumns } from '../defaults';
import { detectUnivariateAnomaliesDetailed, univariateFeatures, categoricalFeatures, type CrossFieldRule } from './univariate';
import { detectMultivariateAnomaliesDetailed, fitMultivariate } from './multivariate';

export const ANOMALY_DEFAULTS = {
  iqrK: 1.5, madThreshold: 3.5, contamination: 0.01, seed: 42, k: 20, nTrees: 100, sampleSize: 256, maxStoredRows: 500,
};

const METHOD_ORDER: AnomalyMethod[] = ['iqr', 'mad', 'cross_field', 'unseen_category', 'isolation_forest', 'lof'];

export function resolveAnomalyConfig(model: any, _reference?: ReferenceProfile): AnomalyConfigSnapshot & { maxStoredRows: number } {
  const cfg = model?.anomalyConfig ?? {};
  const registry = (model?.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const cols = resolveModelColumns(model);
  const pick = <K extends keyof typeof ANOMALY_DEFAULTS>(k: K): number =>
    typeof cfg[k] === 'number' ? cfg[k] : ANOMALY_DEFAULTS[k];
  const transforms: Record<string, AnomalyTransform> = {};
  for (const f of univariateFeatures(registry, cols)) transforms[f] = registry[f].anomalyTransform ?? 'none';
  const crossFieldRules: CrossFieldRule[] = Array.isArray(cfg.crossFieldRules) ? cfg.crossFieldRules : [];
  const catFeats = categoricalFeatures(registry, cols);
  const warnings: string[] = catFeats.length > 0
    ? [`ชั้นหลายตัวแปร (IF/LOF) ไม่ใช้ตัวแปรแบบกลุ่ม (categorical) — ข้ามตัวแปร: ${catFeats.map(k => registry[k]?.displayName || k).join(', ')}`]
    : [];
  return {
    iqrK: pick('iqrK'), madThreshold: pick('madThreshold'), contamination: pick('contamination'),
    seed: pick('seed'), k: pick('k'), nTrees: pick('nTrees'), sampleSize: pick('sampleSize'),
    maxStoredRows: pick('maxStoredRows'),
    transforms, crossFieldRules,
    excludedCategoricalFeatures: catFeats,
    warnings,
  };
}

/** JSON-safe: ±Infinity / NaN → null + extreme: true. */
export function toStoredFlag(f: AnomalyFlag): StoredAnomalyFlag {
  if (Number.isFinite(f.score)) return { ...f };
  return { ...f, score: null, extreme: true };
}

// ─── Reference-side flags (for symmetric what-if drift) ─────────────────────────────────
/**
 * 0-based reference row indices flagged with the SAME rules/thresholds as uploads:
 *   - IQR / MAD / cross-field on the reference rows themselves
 *   - IF / LOF using the leave-one-out reference scores (a row is never its own evidence)
 * Cached per reference + resolved config.
 */
const refFlagCache = new Map<string, Set<number>>();
export function referenceFlaggedIndices(reference: ReferenceProfile, model: any): Set<number> {
  const registry = (model?.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const cols = resolveModelColumns(model);
  const cfg = resolveAnomalyConfig(model, reference);
  const key = JSON.stringify([reference.meta.referenceId, reference.meta.sha256, cfg, cols]);
  const hit = refFlagCache.get(key);
  if (hit) return hit;

  const feats = univariateFeatures(registry, cols);
  const catFeats = categoricalFeatures(registry, cols);
  const n = reference.labels.length;
  const refRows: CleanRow[] = Array.from({ length: n }, (_, i) => ({
    row: i + 1, id: `REF_${i + 1}`, date: null, label: null, imputed: [],
    values: Object.fromEntries(feats.filter(f => reference.features[f]).map(f => [f, reference.features[f][i]])),
    categories: Object.fromEntries(
      catFeats
        .filter(f => reference.categoricalFeatures?.[f]?.[i] !== null && reference.categoricalFeatures?.[f]?.[i] !== undefined)
        .map(f => [f, reference.categoricalFeatures[f][i] as string]),
    ),
  }));
  const out = new Set<number>();
  for (const f of detectUnivariateAnomaliesDetailed(reference, refRows, registry, {
    iqrK: cfg.iqrK, madThreshold: cfg.madThreshold, crossFieldRules: cfg.crossFieldRules, columns: cols,
  }).flags) out.add(f.row - 1);

  const fit = fitMultivariate(reference, registry, {
    nTrees: cfg.nTrees, sampleSize: cfg.sampleSize, seed: cfg.seed, k: cfg.k, contamination: cfg.contamination, columns: cols,
  });
  fit.refIndex.forEach((ri, j) => {
    if (fit.referenceScores.isolation_forest[j] > fit.thresholds.isolation_forest) out.add(ri);
    if (fit.referenceScores.lof[j] > fit.thresholds.lof) out.add(ri);
  });
  refFlagCache.set(key, out);
  return out;
}

/** Reference without the given rows. scoreBoundaries are KEPT from the full reference (never recomputed). */
export function referenceWithout(reference: ReferenceProfile, drop: Set<number>): ReferenceProfile {
  const keep = (_: unknown, i: number) => !drop.has(i);
  const labels = reference.labels.filter(keep);
  return {
    meta: reference.meta,
    features: Object.fromEntries(Object.entries(reference.features).map(([k, v]) => [k, v.filter(keep)])),
    categoricalFeatures: Object.fromEntries(
      Object.entries(reference.categoricalFeatures ?? {}).map(([k, v]) => [k, v.filter(keep)]),
    ),
    categorySpecs: reference.categorySpecs ?? {},
    labels,
    hasLabels: labels.some(l => l !== null),
    scores: reference.scores.filter(keep),
    hasScores: reference.hasScores,
    scoreBoundaries: reference.scoreBoundaries,
    missingCount: reference.missingCount,
    missingRate: reference.missingRate,
  };
}

export function runAnomalyScreening(reference: ReferenceProfile, cleanRows: CleanRow[], model: any): AnomalyResult {
  const t0 = performance.now();
  const registry = (model?.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const cols = resolveModelColumns(model);
  const cfg = resolveAnomalyConfig(model, reference);

  const uni = detectUnivariateAnomaliesDetailed(reference, cleanRows, registry, {
    iqrK: cfg.iqrK, madThreshold: cfg.madThreshold, crossFieldRules: cfg.crossFieldRules, columns: cols,
  });
  const t1 = performance.now();
  const multi = detectMultivariateAnomaliesDetailed(reference, cleanRows, registry, {
    nTrees: cfg.nTrees, sampleSize: cfg.sampleSize, seed: cfg.seed, k: cfg.k, contamination: cfg.contamination, columns: cols,
  });

  const idOf = new Map(cleanRows.map(r => [r.row, r.id]));
  const byRow = new Map<number, AnomalyFlaggedRow>();
  for (const f of [...uni.flags, ...multi.flags]) {
    let e = byRow.get(f.row);
    if (!e) { e = { row: f.row, id: idOf.get(f.row) ?? `ROW_${f.row}`, methods: [], reasons: [], flags: [] }; byRow.set(f.row, e); }
    if (!e.methods.includes(f.method)) e.methods.push(f.method);
    e.reasons.push(f.reason);
    e.flags.push(toStoredFlag(f));
  }
  const flaggedRows = [...byRow.values()];
  for (const e of flaggedRows) e.methods.sort((a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b));
  flaggedRows.sort((a, b) => b.methods.length - a.methods.length || a.row - b.row);

  const byMethod: AnomalyResult['byMethod'] = {};
  for (const m of METHOD_ORDER) byMethod[m] = flaggedRows.filter(e => e.methods.includes(m)).length;

  const total = cleanRows.length;
  const { maxStoredRows: _omit, ...configSnapshot } = cfg;
  return {
    flaggedRows,
    truncated: false,
    byMethod,
    totalRows: total,
    flaggedRowCount: flaggedRows.length,
    flaggedPct: total ? Math.round((flaggedRows.length / total) * 1000) / 10 : 0,
    referenceFlaggedCount: referenceFlaggedIndices(reference, model).size,
    thresholds: multi.thresholds,
    warnings: [...uni.warnings, ...multi.warnings],
    timing: {
      univariateMs: +(t1 - t0).toFixed(1),
      multivariateFitMs: multi.timing.cached ? 0 : +multi.timing.fitMs.toFixed(1),
      multivariateScoreMs: +multi.timing.scoreMs.toFixed(1),
      fitCached: multi.timing.cached,
      totalMs: +(performance.now() - t0).toFixed(1),
    },
    configSnapshot,
  };
}

/** Keep at most `max` flagged rows for storage; summary counts stay complete. */
export function truncateAnomalyResult(result: AnomalyResult, max: number): AnomalyResult {
  if (result.flaggedRows.length <= max) return result;
  return { ...result, flaggedRows: result.flaggedRows.slice(0, max), truncated: true };
}
