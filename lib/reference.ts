/**
 * Frozen Reference Datasets.
 *
 * PSI/CSI must always compare against the SAME reference so results are
 * comparable across uploads. Reference files are immutable (see
 * scripts/build_reference_dataset.py) and identified by referenceId + sha256.
 * The model config points to its reference via `referenceDatasetId`.
 */
import type { ReferenceDatasetMeta, ScoringConfig } from './types';
import { calculateAScore } from './scoring';
import { quantileBoundaries } from './stats';
import ascoreV1Dev855 from '../data/reference/ascore_v1_dev855.json';

interface ReferenceFile {
  meta: ReferenceDatasetMeta;
  rows: Record<string, string | number>[];
}

const REGISTRY: Record<string, ReferenceFile> = {
  ascore_v1_dev855: ascoreV1Dev855 as unknown as ReferenceFile,
};

export interface ReferenceProfile {
  meta: ReferenceDatasetMeta;
  /** numeric columns, one array per feature (same row order) */
  features: Record<string, number[]>;
  labels: number[];
  scores: number[];
  /** fixed score-PSI boundaries (deciles of the reference score distribution) */
  scoreBoundaries: number[];
}

const cache = new Map<string, ReferenceProfile>();

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
  return { columns: [...file.meta.columns], rows: file.rows.map(r => ({ ...r })) };
}

/**
 * Profile is cached per (referenceId, scoring fingerprint) — if the scorecard
 * changes, scores are recomputed, but the underlying rows never change.
 */
export function getReferenceProfile(referenceId: string, scoring: ScoringConfig): ReferenceProfile {
  const file = REGISTRY[referenceId];
  if (!file) throw new Error(`Unknown reference dataset "${referenceId}"`);
  const key = `${referenceId}|${JSON.stringify([scoring.base_points, scoring.features, scoring.scorecard])}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const numericCols = file.meta.columns.filter(c => typeof file.rows[0]?.[c] === 'number');
  const features: Record<string, number[]> = {};
  for (const c of numericCols) features[c] = file.rows.map(r => Number(r[c]));
  const labels = file.rows.map(r => Number(r.default_flag ?? 0));
  const scores = file.rows.map(r => {
    const rec: Record<string, number> = {};
    for (const f of scoring.features) rec[f] = Number(r[f]);
    return calculateAScore(scoring, rec);
  });

  const profile: ReferenceProfile = {
    meta: file.meta,
    features,
    labels,
    scores,
    scoreBoundaries: quantileBoundaries(scores, 10),
  };
  cache.set(key, profile);
  return profile;
}
