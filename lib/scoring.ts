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

export function featurePoints(scoring: ScoringConfig, feature: string, value: number): number {
  const sc = scoring.scorecard[feature];
  if (!sc) return 0;
  return sc.points[getBinIndex(value, sc.bins)] ?? 0;
}

/**
 * @throws if a scorecard feature is missing/non-finite — the caller must
 * validate first (scoring a missing value as 0 silently would bias the score).
 */
export function calculateAScore(scoring: ScoringConfig, record: Record<string, number>): number {
  let score = scoring.base_points;
  for (const feature of scoring.features) {
    const v = record[feature];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`calculateAScore: feature "${feature}" is missing or not a number`);
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
    if (sc.points.length !== sc.bins.length + 1) problems.push(`"${f}": points (${sc.points.length}) ≠ bins+1 (${sc.bins.length + 1})`);
    for (let i = 1; i < sc.bins.length; i++) if (!(sc.bins[i] > sc.bins[i - 1])) problems.push(`"${f}": bins not strictly increasing at ${i}`);
  }
  return problems;
}
