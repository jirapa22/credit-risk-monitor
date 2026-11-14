/**
 * Config-driven A-Score scoring engine.
 *
 *   Score = base_points + Σ_f points_f[ bin(value_f) ]
 *   ln(odds_good:bad) = (Score − offset) / factor
 *   PD = 1 / (1 + odds)
 *
 * All parameters come from model-config.json (scoring block), so adding a new
 * scorecard variable only requires a config change — no code change.
 */
import type { ScoringConfig } from './types';
import { getBinIndex } from './stats';

export function featurePoints(scoring: ScoringConfig, feature: string, value: unknown): number {
  const sc = scoring.scorecard[feature];
  if (!sc) return 0;
  if (sc.dataType === 'categorical' || (sc.categories && sc.categories.length > 0)) {
    const rawVal = String(value ?? '').trim().toLowerCase();
    const categories = sc.categories ?? [];
    for (let i = 0; i < categories.length; i++) {
      const cats = categories[i];
      if (cats && cats.some(c => c.trim().toLowerCase() === rawVal)) {
        return sc.points[i] ?? 0;
      }
    }
    return sc.points[sc.points.length - 1] ?? 0;
  }
  const numVal = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numVal)) return 0;
  return sc.points[getBinIndex(numVal, sc.bins)] ?? 0;
}

/**
 * @throws if a scorecard feature is missing/non-finite — the caller must
 * validate first (scoring a missing value as 0 silently would bias the score).
 */
export function calculateAScore(scoring: ScoringConfig, record: Record<string, unknown>): number {
  let score = scoring.base_points;
  for (const feature of scoring.features) {
    const v = record[feature];
    const sc = scoring.scorecard[feature];
    const isCategorical = sc?.dataType === 'categorical' || Boolean(sc?.categories && sc.categories.length > 0);
    if (isCategorical) {
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
        throw new Error(`calculateAScore: feature "${feature}" is missing`);
      }
    } else {
      const numVal = typeof v === 'number' ? v : Number(v);
      if (v === null || v === undefined || !Number.isFinite(numVal)) {
        throw new Error(`calculateAScore: feature "${feature}" is missing or not a number`);
      }
    }
    score += featurePoints(scoring, feature, v);
  }
  return Math.round(score * 100) / 100;
}

export function scoreToPD(scoring: ScoringConfig, score: number): number {
  const odds = Math.exp((score - scoring.offset) / scoring.factor);
  return Math.round((1 / (1 + odds)) * 10000) / 10000;
}

/** Sanity check: points arrays must match bins, features must exist. */
export function validateScoringConfig(scoring: ScoringConfig): string[] {
  const problems: string[] = [];
  for (const f of scoring.features) {
    const sc = scoring.scorecard[f];
    if (!sc) { problems.push(`scorecard missing for feature "${f}"`); continue; }
    if (sc.dataType === 'categorical' || (sc.categories && sc.categories.length > 0)) {
      if (sc.categories && sc.points.length !== sc.categories.length) {
        problems.push(`"${f}": points (${sc.points.length}) ≠ categories (${sc.categories.length})`);
      }
    } else {
      if (sc.points.length !== sc.bins.length + 1) problems.push(`"${f}": points (${sc.points.length}) ≠ bins+1 (${sc.bins.length + 1})`);
      for (let i = 1; i < sc.bins.length; i++) if (!(sc.bins[i] > sc.bins[i - 1])) problems.push(`"${f}": bins not strictly increasing at ${i}`);
    }
  }
  return problems;
}
