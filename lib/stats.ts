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

// ─── Categorical PSI / Chi-Square / Jensen–Shannon ──────────────────────────
export interface CategoricalPsiBreakdown extends PsiBreakdown {
  categories: string[];
  labels: string[];
}

export function formatCategoryDisplayLabel(cat: string): string {
  if (cat === '__OTHER__') return 'อื่นๆ (__OTHER__)';
  if (cat === '__UNSEEN__') return 'ไม่เคยพบ (__UNSEEN__)';
  return cat;
}

/**
 * CSI / PSI for categorical features across canonical categories
 * (including __OTHER__ and __UNSEEN__ when present in either sample).
 */
export function psiForCategories(
  baseValues: (string | null)[],
  actualValues: (string | null)[],
  baseCategories: string[],
  categoryPools?: Array<{ label: string; categories: string[] }>,
): CategoricalPsiBreakdown {
  if (categoryPools && categoryPools.length > 0) {
    const catToPool = new Map<string, string>();
    for (const p of categoryPools) {
      for (const c of p.categories) {
        catToPool.set(c, p.label);
      }
    }
    const mapToPool = (v: string | null): string => {
      if (!v) return '__OTHER__';
      return catToPool.get(v) ?? '__OTHER__';
    };
    const mappedBase = baseValues.map(mapToPool);
    const mappedActual = actualValues.map(mapToPool);
    const poolCats = categoryPools.map(p => p.label);
    if (!poolCats.includes('__OTHER__')) poolCats.push('__OTHER__');

    return psiForCategories(mappedBase, mappedActual, poolCats);
  }
  const validBase = baseValues.filter((v): v is string => typeof v === 'string' && v.length > 0);
  const validActual = actualValues.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (validBase.length === 0 || validActual.length === 0) {
    return { value: 0, bins: [], categories: [], labels: [] };
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  const pushCat = (c: string) => {
    if (!seen.has(c)) {
      seen.add(c);
      ordered.push(c);
    }
  };
  for (const c of baseCategories) {
    if (c !== '__OTHER__' && c !== '__UNSEEN__') pushCat(c);
  }
  const allValues = [...validBase, ...validActual];
  for (const v of allValues) {
    if (v !== '__OTHER__' && v !== '__UNSEEN__') pushCat(v);
  }
  if (baseCategories.includes('__OTHER__') || allValues.includes('__OTHER__')) pushCat('__OTHER__');
  if (baseCategories.includes('__UNSEEN__') || allValues.includes('__UNSEEN__')) pushCat('__UNSEEN__');

  const eMap = new Map<string, number>();
  const aMap = new Map<string, number>();
  for (const v of validBase) eMap.set(v, (eMap.get(v) ?? 0) + 1);
  for (const v of validActual) aMap.set(v, (aMap.get(v) ?? 0) + 1);

  const expectedCounts = ordered.map(c => eMap.get(c) ?? 0);
  const actualCounts = ordered.map(c => aMap.get(c) ?? 0);
  const psi = psiFromCounts(expectedCounts, actualCounts);
  return {
    value: psi.value,
    bins: psi.bins,
    categories: ordered,
    labels: ordered.map(formatCategoryDisplayLabel),
  };
}

/** Log-gamma via Lanczos approximation for chi-square p-value. */
function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (a <= 0) return 0;
  if (x < a + 1) {
    // Series representation for P(a, x)
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n <= 200; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    const p = sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
    return Math.max(0, Math.min(1, 1 - p));
  }
  // Continued fraction representation for Q(a, x)
  let b = x + 1 - a;
  let c = 1 / 1e-30;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = b + an / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  return Math.max(0, Math.min(1, q));
}

/**
 * Two-sample homogeneity Chi-square test across category counts.
 */
export function chiSquareTwoSample(
  expectedCounts: number[],
  actualCounts: number[],
): { statistic: number; df: number; pValue: number } {
  const n1 = expectedCounts.reduce((a, b) => a + b, 0);
  const n2 = actualCounts.reduce((a, b) => a + b, 0);
  const total = n1 + n2;
  if (n1 === 0 || n2 === 0 || expectedCounts.length === 0) {
    return { statistic: 0, df: 0, pValue: 1 };
  }
  let stat = 0;
  let nonEmptyCols = 0;
  for (let i = 0; i < expectedCounts.length; i++) {
    const colTotal = expectedCounts[i] + actualCounts[i];
    if (colTotal <= 0) continue;
    nonEmptyCols++;
    const e1 = (n1 * colTotal) / total;
    const e2 = (n2 * colTotal) / total;
    if (e1 > 0) stat += ((expectedCounts[i] - e1) ** 2) / e1;
    if (e2 > 0) stat += ((actualCounts[i] - e2) ** 2) / e2;
  }
  const df = Math.max(1, nonEmptyCols - 1);
  const pValue = gammaQ(df / 2, stat / 2);
  return { statistic: stat, df, pValue };
}

/**
 * Jensen–Shannon divergence and distance (base-2 log, bounded in [0, 1]).
 */
export function jensenShannonDistance(
  expectedCounts: number[],
  actualCounts: number[],
): { distance: number; divergence: number } {
  const eTotal = expectedCounts.reduce((a, b) => a + b, 0);
  const aTotal = actualCounts.reduce((a, b) => a + b, 0);
  if (eTotal === 0 || aTotal === 0 || expectedCounts.length === 0) {
    return { distance: 0, divergence: 0 };
  }
  let klPM = 0;
  let klQM = 0;
  for (let i = 0; i < expectedCounts.length; i++) {
    const p = expectedCounts[i] / eTotal;
    const q = actualCounts[i] / aTotal;
    const m = 0.5 * (p + q);
    if (m <= 0) continue;
    if (p > 0) klPM += p * Math.log2(p / m);
    if (q > 0) klQM += q * Math.log2(q / m);
  }
  const divergence = Math.max(0, Math.min(1, 0.5 * (klPM + klQM)));
  const distance = Math.sqrt(divergence);
  return { distance, divergence };
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
