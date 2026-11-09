/**
 * Frozen Reference Datasets.
 *
 * PSI/CSI must always compare against the SAME reference so results are
 * comparable across uploads. Reference files are immutable (see
 * scripts/build_reference_dataset.py) and identified by referenceId + sha256.
 * The model config points to its reference via `referenceDatasetId`.
 */
import type { ReferenceDatasetMeta, ScoringConfig } from './types';
import { DEFAULT_LABEL_COLUMN } from './defaults';
import { calculateAScore } from './scoring';
import { quantileBoundaries } from './stats';
import ascoreV1Dev855 from '../data/reference/ascore_v1_dev855.json';

interface ReferenceFile {
  meta: ReferenceDatasetMeta;
  rows: Record<string, string | number | null | undefined>[];
}

const REGISTRY: Record<string, ReferenceFile> = {
  ascore_v1_dev855: ascoreV1Dev855 as unknown as ReferenceFile,
};

export interface ReferenceProfile {
  meta: ReferenceDatasetMeta;
  /** numeric columns, one array per feature (same row order) */
  features: Record<string, number[]>;
  /** binary target per row from model.labelColumn (default 'default_flag'); null when missing/blank. */
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
}

const cache = new Map<string, ReferenceProfile>();

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

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
 * Profile is cached per (referenceId, sha256, scoring fingerprint, label/score column) —
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
  const key = `${referenceId}|${sha256}|${labelColumn}|${scoreColumn}|${JSON.stringify([
    scoring?.base_points, scoring?.features, scoring?.scorecard,
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

  const numericCols = file.meta.columns.filter(c =>
    file.rows.some(r => !isBlank(r[c]) && typeof r[c] !== 'boolean' && Number.isFinite(Number(r[c]))),
  );
  const features: Record<string, number[]> = {};
  for (const c of numericCols) {
    features[c] = file.rows.map(r => (isBlank(r[c]) ? NaN : Number(r[c])));
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
