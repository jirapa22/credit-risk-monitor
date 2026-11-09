/**
 * Frozen Reference Datasets.
 *
 * PSI/CSI must always compare against the SAME reference so results are
 * comparable across uploads. Reference files are immutable (see
 * scripts/build_reference_dataset.py) and identified by referenceId + sha256.
 * The model config points to its reference via `referenceDatasetId`.
 */
import type { FeatureDefinition, ReferenceDatasetMeta, ScoringConfig } from './types';
import { DEFAULT_LABEL_COLUMN } from './defaults';
import { calculateAScore } from './scoring';
import { quantileBoundaries } from './stats';
import ascoreV1Dev855 from '../data/reference/ascore_v1_dev855.json';

export const OTHER_CATEGORY = '__OTHER__';
export const UNSEEN_CATEGORY = '__UNSEEN__';
export const DEFAULT_RARE_CATEGORY_THRESHOLD = 0.01;

interface ReferenceFile {
  meta: ReferenceDatasetMeta;
  rows: Record<string, string | number | null | undefined>[];
}

const REGISTRY: Record<string, ReferenceFile> = {
  ascore_v1_dev855: ascoreV1Dev855 as unknown as ReferenceFile,
};

export interface ReferenceCategorySpec {
  /** Active canonical categories in Reference (plus '__OTHER__' when rare categories exist). */
  categories: string[];
  /** Case-insensitive lookup: trimmed lowercase -> canonical category name (or '__OTHER__'). */
  canonicalByLower: Record<string, string>;
  /** Most frequent canonical category in Reference (used by missingStrategy = 'fillMode'). */
  modeCategory: string | null;
  rareCategoryThreshold: number;
  counts: Record<string, number>;
}

export interface ReferenceProfile {
  meta: ReferenceDatasetMeta;
  /** numeric columns, one array per feature (same row order) */
  features: Record<string, number[]>;
  /** categorical columns, one array of canonical category strings (or null when blank) per feature */
  categoricalFeatures: Record<string, (string | null)[]>;
  /** category metadata (canonical names, lowercase lookup, mode, rare threshold) per categorical column */
  categorySpecs: Record<string, ReferenceCategorySpec>;
  /** binary target per row from model.labelColumn; null when missing/blank. */
  labels: (number | null)[];
  hasLabels: boolean;
  scores: number[];
  hasScores: boolean;
  /** fixed score-PSI boundaries (deciles of the reference score distribution) */
  scoreBoundaries: number[];
  /** missing count & rate (0–1) per column in the raw reference dataset */
  missingCount: Record<string, number>;
  missingRate: Record<string, number>;
}

export interface ReferenceProfileOptions {
  labelColumn?: string;
  scoreColumn?: string;
  featureRegistry?: Record<string, FeatureDefinition>;
}

const cache = new Map<string, ReferenceProfile>();

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

/** Normalize a raw category cell by trimming whitespace; returns canonical category or null if unseen. */
export function resolveCanonicalCategory(
  raw: unknown,
  spec?: ReferenceCategorySpec,
  def?: FeatureDefinition,
): { canonical: string; unseen: boolean; rawTrimmed: string } {
  const rawTrimmed = String(raw ?? '').trim();
  const lower = rawTrimmed.toLowerCase();

  if (spec && lower in spec.canonicalByLower) {
    return { canonical: spec.canonicalByLower[lower], unseen: false, rawTrimmed };
  }
  if (def?.allowedCategories?.length) {
    for (const ac of def.allowedCategories) {
      const t = String(ac).trim();
      if (t.toLowerCase() === lower) {
        return { canonical: t, unseen: false, rawTrimmed };
      }
    }
  }
  return { canonical: UNSEEN_CATEGORY, unseen: true, rawTrimmed };
}

export function buildCategorySpecFromRows(
  rows: Record<string, unknown>[],
  column: string,
  def?: FeatureDefinition,
): { spec: ReferenceCategorySpec; values: (string | null)[] } {
  const rareThreshold =
    typeof def?.rareCategoryThreshold === 'number'
      ? def.rareCategoryThreshold
      : DEFAULT_RARE_CATEGORY_THRESHOLD;

  const lowerCounts = new Map<string, number>();
  const firstSpelling = new Map<string, string>();
  let nonBlankTotal = 0;

  if (def?.allowedCategories?.length) {
    for (const ac of def.allowedCategories) {
      const t = String(ac).trim();
      if (t) firstSpelling.set(t.toLowerCase(), t);
    }
  }

  for (const r of rows) {
    const raw = r[column];
    if (isBlank(raw)) continue;
    const trimmed = String(raw).trim();
    const lower = trimmed.toLowerCase();
    nonBlankTotal++;
    lowerCounts.set(lower, (lowerCounts.get(lower) ?? 0) + 1);
    if (!firstSpelling.has(lower)) firstSpelling.set(lower, trimmed);
  }

  const canonicalByLower: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const categories: string[] = [];
  let hasOther = false;

  for (const [lower, cnt] of lowerCounts.entries()) {
    const share = nonBlankTotal > 0 ? cnt / nonBlankTotal : 0;
    if (share < rareThreshold) {
      canonicalByLower[lower] = OTHER_CATEGORY;
      counts[OTHER_CATEGORY] = (counts[OTHER_CATEGORY] ?? 0) + cnt;
      hasOther = true;
    } else {
      const canon = firstSpelling.get(lower) ?? lower;
      canonicalByLower[lower] = canon;
      counts[canon] = (counts[canon] ?? 0) + cnt;
      if (!categories.includes(canon)) categories.push(canon);
    }
  }

  if (def?.allowedCategories?.length) {
    for (const ac of def.allowedCategories) {
      const t = String(ac).trim();
      if (!t) continue;
      const lower = t.toLowerCase();
      if (!(lower in canonicalByLower)) {
        canonicalByLower[lower] = t;
        counts[t] = counts[t] ?? 0;
        if (!categories.includes(t)) categories.push(t);
      }
    }
  }

  if (hasOther && !categories.includes(OTHER_CATEGORY)) {
    categories.push(OTHER_CATEGORY);
  }

  let modeCategory: string | null = null;
  let maxCount = -1;
  for (const [cat, cnt] of Object.entries(counts)) {
    if (cnt > maxCount) {
      maxCount = cnt;
      modeCategory = cat;
    }
  }

  const values: (string | null)[] = rows.map(r => {
    const raw = r[column];
    if (isBlank(raw)) return null;
    const lower = String(raw).trim().toLowerCase();
    return canonicalByLower[lower] ?? OTHER_CATEGORY;
  });

  return {
    spec: {
      categories,
      canonicalByLower,
      modeCategory,
      rareCategoryThreshold: rareThreshold,
      counts,
    },
    values,
  };
}

/** Register an in-memory reference dataset (used for custom/test models). */
export function registerReferenceDataset(
  meta: ReferenceDatasetMeta,
  rows: Record<string, string | number | null | undefined>[],
): void {
  REGISTRY[meta.referenceId] = { meta, rows: rows.map(r => ({ ...r })) };
  for (const k of cache.keys()) if (k.startsWith(`${meta.referenceId}|`)) cache.delete(k);
}

export function listReferenceDatasets(): ReferenceDatasetMeta[] {
  return Object.values(REGISTRY).map(r => r.meta);
}

export function getReferenceMeta(referenceId: string): ReferenceDatasetMeta | null {
  return REGISTRY[referenceId]?.meta ?? null;
}

/** Raw frozen rows (read-only copy) — used by the Sandbox to bootstrap test files. */
export function getReferenceRows(referenceId: string): { columns: string[]; rows: Record<string, string | number>[] } {
  const file = REGISTRY[referenceId];
  if (!file) throw new Error(`Unknown reference dataset "${referenceId}"`);
  return {
    columns: [...file.meta.columns],
    rows: file.rows.map(r => ({ ...(r as Record<string, string | number>) })),
  };
}

/**
 * Profile is cached per (referenceId, sha256, scoring fingerprint, label/score column, categorical config) —
 * if the scorecard or reference sha256 changes, scores and profiles are recomputed.
 */
export function buildReferenceProfileFromData(
  file: { meta: ReferenceDatasetMeta; rows: Record<string, string | number | null | undefined>[] },
  scoring?: ScoringConfig | null,
  options: ReferenceProfileOptions = {},
): ReferenceProfile {
  const referenceId = file.meta.referenceId;
  const sha256 = file.meta.sha256 || 'no_sha';
  const labelColumn = options.labelColumn || DEFAULT_LABEL_COLUMN;
  const scoreColumn = options.scoreColumn || '';
  const catFingerprint = options.featureRegistry
    ? Object.entries(options.featureRegistry)
        .filter(([, d]) => d.dataType === 'categorical')
        .map(([k, d]) => [k, d.allowedCategories, d.rareCategoryThreshold])
    : [];
  const key = `${referenceId}|${sha256}|${labelColumn}|${scoreColumn}|${JSON.stringify([
    scoring?.base_points,
    scoring?.features,
    scoring?.scorecard,
    catFingerprint,
  ])}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const total = file.rows.length || 1;
  const missingCount: Record<string, number> = {};
  const missingRate: Record<string, number> = {};
  for (const c of file.meta.columns) {
    const mc = file.rows.filter(r => isBlank(r[c])).length;
    missingCount[c] = mc;
    missingRate[c] = mc / total;
  }

  const numericCols = file.meta.columns.filter(c => {
    const regType = options.featureRegistry?.[c]?.dataType;
    if (regType === 'categorical' || regType === 'string' || regType === 'date') return false;
    return file.rows.some(r => !isBlank(r[c]) && typeof r[c] !== 'boolean' && Number.isFinite(Number(r[c])));
  });
  const features: Record<string, number[]> = {};
  for (const c of numericCols) {
    features[c] = file.rows.map(r => (isBlank(r[c]) ? NaN : Number(r[c])));
  }

  // Categorical columns: either declared in featureRegistry as 'categorical', or non-numeric text columns with <= 50 unique values
  const numericColSet = new Set(numericCols);
  const categoricalFeatures: Record<string, (string | null)[]> = {};
  const categorySpecs: Record<string, ReferenceCategorySpec> = {};

  for (const c of file.meta.columns) {
    if (c === labelColumn || c === scoreColumn) continue;
    const def = options.featureRegistry?.[c];
    const isDeclaredCat = def?.dataType === 'categorical';
    const isTextCol = !numericColSet.has(c) && file.rows.some(r => !isBlank(r[c]));
    if (!isDeclaredCat && !isTextCol) continue;
    if (def && def.dataType !== 'categorical') continue;

    // If not explicitly declared in registry, only treat as categorical when unique values <= 50
    if (!isDeclaredCat) {
      const uniq = new Set(
        file.rows.filter(r => !isBlank(r[c])).map(r => String(r[c]).trim().toLowerCase()),
      );
      if (uniq.size > 50) continue;
    }

    const built = buildCategorySpecFromRows(file.rows, c, def);
    categoricalFeatures[c] = built.values;
    categorySpecs[c] = built.spec;
  }

  const labels: (number | null)[] = file.rows.map(r => {
    const raw = r[labelColumn];
    if (isBlank(raw)) return null;
    const n = Number(raw);
    return n === 0 || n === 1 ? n : null;
  });
  const hasLabels = labels.some(l => l === 0 || l === 1);

  const hasScorecard = Boolean(
    scoring && Array.isArray(scoring.features) &&
    scoring.features.length > 0 &&
    scoring.scorecard && scoring.features.every(f => scoring.scorecard[f] && file.meta.columns.includes(f)),
  );
  let scores: number[] = [];
  if (scoreColumn && file.meta.columns.includes(scoreColumn)) {
    scores = file.rows.map(r => Number(r[scoreColumn])).filter(Number.isFinite);
  } else if (hasScorecard && scoring) {
    scores = file.rows.map(r => {
      const rec: Record<string, number> = {};
      for (const f of scoring.features) rec[f] = Number(r[f]);
      return calculateAScore(scoring, rec);
    });
  }
  const hasScores = scores.length > 0;

  const profile: ReferenceProfile = {
    meta: file.meta,
    features,
    categoricalFeatures,
    categorySpecs,
    labels,
    hasLabels,
    scores,
    hasScores,
    scoreBoundaries: hasScores ? quantileBoundaries(scores, 10) : [],
    missingCount,
    missingRate,
  };
  cache.set(key, profile);
  return profile;
}

export function getReferenceProfile(
  referenceId: string,
  scoring?: ScoringConfig | null,
  options: ReferenceProfileOptions = {},
): ReferenceProfile {
  const file = REGISTRY[referenceId];
  if (!file) throw new Error(`Unknown reference dataset "${referenceId}"`);
  return buildReferenceProfileFromData(file, scoring, options);
}
