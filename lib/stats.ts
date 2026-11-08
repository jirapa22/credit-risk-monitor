/**
 * Statistical primitives for monitoring.
 *
 * Bin convention (used everywhere — scorecard, CSI, PSI):
 *   boundaries b[0] < b[1] < … < b[k-1]  →  k+1 bins
 *   value <= b[0]            → bin 0
 *   b[i-1] < value <= b[i]   → bin i
 *   value > b[k-1]           → bin k
 * This equals pandas.cut(right=True), which is what ascore_model_report.xlsx used.
 *
 * PSI / CSI = Σ (A% − E%) × ln(A% / E%)
 *   zero proportions are replaced by EPS (0.0001) before the log, the same
 *   treatment as the original implementation.
 */

export const PSI_EPS = 0.0001;

export interface DataPoint {
  score: number | null;
  label: number | null; // 0 = Good, 1 = Bad (Default), null = missing
}

/** Which way the score points. A-Score: higher score = lower risk ('higher_is_safer' / 'higher_is_better'). */
export type ScoreDirection = 'higher_is_safer' | 'higher_is_better' | 'higher_is_riskier';

// ─── Binning ────────────────────────────────────────────────────────────────
export function getBinIndex(value: number, boundaries: number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (value <= boundaries[i]) return i;
  }
  return boundaries.length;
}

export function countBins(values: number[], boundaries: number[]): number[] {
  const counts = new Array(boundaries.length + 1).fill(0);
  for (const v of values) counts[getBinIndex(v, boundaries)]++;
  return counts;
}

/**
 * Quantile boundaries (upper-inclusive) from a reference sample.
 * Duplicate boundaries (caused by tied/discrete values such as scorecard
 * scores) are removed, so the result may have fewer than numBins-1 cut points.
 */
export function quantileBoundaries(values: number[], numBins = 10): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const cuts: number[] = [];
  for (let i = 1; i < numBins; i++) {
    const idx = Math.ceil((sorted.length * i) / numBins) - 1;
    const v = sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
    if (cuts.length === 0 || v > cuts[cuts.length - 1]) cuts.push(v);
  }
  // the last cut must leave something in the top bin
  while (cuts.length > 0 && cuts[cuts.length - 1] >= sorted[sorted.length - 1]) cuts.pop();
  return cuts;
}

export function defaultBinLabels(boundaries: number[]): string[] {
  if (boundaries.length === 0) return ['All'];
  const f = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  const labels = [`≤${f(boundaries[0])}`];
  for (let i = 1; i < boundaries.length; i++) labels.push(`${f(boundaries[i - 1])}–${f(boundaries[i])}`);
  labels.push(`>${f(boundaries[boundaries.length - 1])}`);
  return labels;
}

// ─── PSI / CSI ──────────────────────────────────────────────────────────────
export interface PsiBreakdown {
  value: number;
  bins: { expectedCount: number; actualCount: number; expectedPct: number; actualPct: number; contribution: number }[];
}

/** PSI from bin counts. Both arrays must have the same length. */
export function psiFromCounts(expectedCounts: number[], actualCounts: number[]): PsiBreakdown {
  if (expectedCounts.length !== actualCounts.length) {
    throw new Error(`psiFromCounts: bin count mismatch (${expectedCounts.length} vs ${actualCounts.length})`);
  }
  const eTotal = expectedCounts.reduce((a, b) => a + b, 0);
  const aTotal = actualCounts.reduce((a, b) => a + b, 0);
  if (eTotal === 0 || aTotal === 0) return { value: 0, bins: [] };

  let value = 0;
  const bins = expectedCounts.map((ec, i) => {
    const ac = actualCounts[i];
    const ePct = ec / eTotal;
    const aPct = ac / aTotal;
    const e = ePct === 0 ? PSI_EPS : ePct;
    const a = aPct === 0 ? PSI_EPS : aPct;
    const contribution = (a - e) * Math.log(a / e);
    value += contribution;
    return { expectedCount: ec, actualCount: ac, expectedPct: ePct, actualPct: aPct, contribution };
  });
  return { value, bins };
}

/** PSI/CSI with FIXED boundaries (preferred: comparable across periods). */
export function psiWithBoundaries(baseValues: number[], actualValues: number[], boundaries: number[]): PsiBreakdown {
  return psiFromCounts(countBins(baseValues, boundaries), countBins(actualValues, boundaries));
}

/**
 * Legacy: PSI with decile boundaries derived from baseValues.
 * Kept for backward compatibility (simulation route).
 */
export function calculatePSI(baseValues: number[], actualValues: number[]): number {
  if (baseValues.length === 0 || actualValues.length === 0) return 0;
  return psiWithBoundaries(baseValues, actualValues, quantileBoundaries(baseValues, 10)).value;
}

/** Legacy name — CSI with fixed bins. */
export function calculateCSIWithBins(baseValues: number[], actualValues: number[], binBoundaries: number[]): number {
  if (baseValues.length === 0 || actualValues.length === 0) return 0;
  return psiWithBoundaries(baseValues, actualValues, binBoundaries).value;
}

// ─── Discrimination metrics ─────────────────────────────────────────────────
interface ValidDataPoint {
  score: number;
  label: 0 | 1;
}

function validPoints(data: DataPoint[]): ValidDataPoint[] {
  const out: ValidDataPoint[] = [];
  for (const d of data) {
    if (d.score !== null && Number.isFinite(d.score) && (d.label === 0 || d.label === 1)) {
      out.push({ score: d.score, label: d.label });
    }
  }
  return out;
}

/** Convert so that "higher = riskier", which the rank formulas below assume. */
function orient(data: DataPoint[], direction: ScoreDirection): ValidDataPoint[] {
  const valid = validPoints(data);
  const safer = direction === 'higher_is_safer' || direction === 'higher_is_better';
  return safer ? valid.map(d => ({ score: -d.score, label: d.label })) : valid;
}

/**
 * AUC via Mann–Whitney U with average ranks for ties.
 * AUC = P(score of a random Bad is riskier than a random Good).
 *
 * IMPORTANT: pass direction = 'higher_is_safer' (or 'higher_is_better') for A-Score.
 * The previous implementation assumed higher = riskier, which returns 1 − AUC for a
 * scorecard (e.g. 0.29 instead of 0.71).
 */
export function calculateAUC(data: DataPoint[], direction: ScoreDirection = 'higher_is_riskier'): number {
  const d = orient(data, direction);
  const n = d.length;
  if (n === 0) return 0.5;
  const totalBad = d.filter(x => x.label === 1).length;
  const totalGood = n - totalBad;
  if (totalGood === 0 || totalBad === 0) return 0.5;

  const sorted = [...d].sort((a, b) => a.score - b.score);
  let rankSumBad = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && sorted[j].score === sorted[i].score) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (sorted[k].label === 1) rankSumBad += avgRank;
    i = j;
  }
  const auc = (rankSumBad - (totalBad * (totalBad + 1)) / 2) / (totalGood * totalBad);
  return Math.min(Math.max(auc, 0), 1);
}

export function calculateGini(data: DataPoint[], direction: ScoreDirection = 'higher_is_riskier'): number {
  return 2 * calculateAUC(data, direction) - 1;
}

/**
 * KS = max |CDF_bad − CDF_good|, evaluated only at the END of each group of
 * tied scores (evaluating inside a tie group inflates KS — previous bug).
 */
export function calculateKS(data: DataPoint[]): number {
  const valid = validPoints(data);
  if (valid.length === 0) return 0;
  const totalBad = valid.filter(d => d.label === 1).length;
  const totalGood = valid.length - totalBad;
  if (totalGood === 0 || totalBad === 0) return 0;

  const sorted = [...valid].sort((a, b) => a.score - b.score);
  let cumGood = 0, cumBad = 0, maxDiff = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].label === 1) cumBad++; else cumGood++;
    const endOfTie = i === sorted.length - 1 || sorted[i + 1].score !== sorted[i].score;
    if (endOfTie) maxDiff = Math.max(maxDiff, Math.abs(cumGood / totalGood - cumBad / totalBad));
  }
  return maxDiff;
}

/** Cumulative lift in the riskiest `percentile` of the population. */
export function calculateLift(data: DataPoint[], percentile = 0.1, direction: ScoreDirection = 'higher_is_riskier'): number {
  const d = orient(data, direction);
  const n = d.length;
  if (n === 0) return 0;
  const totalBad = d.filter(x => x.label === 1).length;
  if (totalBad === 0) return 0;
  const sorted = [...d].sort((a, b) => b.score - a.score);
  const cutOff = Math.max(1, Math.floor(n * percentile));
  const topBad = sorted.slice(0, cutOff).filter(x => x.label === 1).length;
  return (topBad / cutOff) / (totalBad / n);
}

// ─── Sanity checks for performance metrics ──────────────────────────────────
export interface MetricReliability {
  reliable: boolean;
  warnings: string[];
}

/**
 * Flags results that are mathematically possible but almost never genuine
 * for a credit scorecard — e.g. AUC = 1.000 / KS = 100%.
 * Typical causes: target leakage (a column derived from the outcome such as
 * current_dpd / dpd_bucket), the label being generated from the score itself,
 * scoring the training data, or too few bad accounts.
 */
export function assessMetricReliability(data: DataPoint[], auc: number, ks: number, minBads = 30): MetricReliability {
  const valid = validPoints(data);
  const warnings: string[] = [];
  const bads = valid.filter(d => d.label === 1).length;
  const goods = valid.length - bads;
  if (bads === 0 || goods === 0) warnings.push('มีเพียง class เดียว (ไม่มี Bad หรือไม่มี Good) — คำนวณ AUC/KS ไม่ได้');
  else if (bads < minBads) warnings.push(`จำนวน Bad มีเพียง ${bads} ราย (< ${minBads}) — AUC/KS แกว่งสูง ไม่ควรสรุปผล`);
  if (auc >= 0.99 || auc <= 0.01) warnings.push(`AUC = ${auc.toFixed(3)} สูง/ต่ำผิดปกติ — ตรวจ target leakage หรือ label ที่สร้างจาก score`);
  if (ks >= 0.99) warnings.push(`KS = ${(ks * 100).toFixed(1)}% แยกได้สมบูรณ์ — ตรวจ target leakage หรือการใช้ข้อมูลชุดเดียวกับที่ fit`);
  if (auc > 0 && auc < 0.5) warnings.push(`AUC < 0.5 — ทิศทางของคะแนนอาจกลับด้าน (ตรวจ ScoreDirection)`);
  return { reliable: warnings.length === 0, warnings };
}
