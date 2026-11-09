/**
 * Layer 4 — Multivariate anomaly detection (warning-only). Pure TypeScript.
 *
 *   - Isolation Forest (Liu, Ting & Zhou, 2008)
 *   - Local Outlier Factor, novelty mode (Breunig et al., 2000)
 *
 * Catches rows whose values are individually plausible but jointly unusual
 * (e.g. low income + very large loan + very low DTI) — which layer 3 misses.
 *
 * Everything is fitted on the Reference dataset ONLY: robust standardisation
 * (median / MAD), the trees, the LOF neighbourhood and the score thresholds
 * (percentile of leave-one-out reference scores). Fits are cached per
 * reference + config, so uploads only pay the scoring cost.
 */
import type { AnomalyFlag, AnomalyTransform, FeatureDefinition } from '../types';
import type { ReferenceProfile } from '../reference';
import type { CleanRow } from '../validation';
import { quantile, median, univariateFeatures, categoricalFeatures, type UnivariateColumnOptions } from './univariate';

const MAD_CONST = 0.6745;
const IQR_CONST = 1.349;
const EULER = 0.5772156649;
const EPS = 1e-10;

// ─── RNG ────────────────────────────────────────────────────────────────────
import { mulberry32 } from '../random';
export { mulberry32 };   // re-exported for backward compatibility

// ─── Preprocessing ──────────────────────────────────────────────────────────
export interface Preprocessor {
  features: string[];
  transforms: AnomalyTransform[];
  center: number[];          // median on transformed scale (Reference)
  scale: number[];           // MAD/0.6745, or IQR/1.349 fallback
  warnings: string[];
  /** Returns standardized vector, or null if a value is missing / not transformable. */
  transform(values: Record<string, number>): number[] | null;
}

export function preprocess(
  reference: ReferenceProfile,
  registry: Record<string, FeatureDefinition>,
  columns?: UnivariateColumnOptions,
): Preprocessor {
  const warnings: string[] = [];
  const catFeats = categoricalFeatures(registry, columns);
  if (catFeats.length > 0) {
    warnings.push(
      `ชั้นหลายตัวแปร (IF/LOF) ไม่ใช้ตัวแปรแบบกลุ่ม (categorical) — ข้ามตัวแปร: ${catFeats.map(k => registry[k]?.displayName || k).join(', ')}`,
    );
  }
  const features: string[] = [], transforms: AnomalyTransform[] = [], center: number[] = [], scale: number[] = [];
  for (const key of univariateFeatures(registry, columns)) {
    const t = registry[key].anomalyTransform ?? 'none';
    const raw = (reference.features[key] ?? []).filter(v => Number.isFinite(v) && (t !== 'log1p' || v >= 0));
    if (raw.length === 0) { warnings.push(`ไม่มีตัวแปร "${key}" ใน Reference — ไม่ใช้ในชั้นหลายตัวแปร`); continue; }
    const vals = raw.map(v => (t === 'log1p' ? Math.log1p(v) : v)).sort((a, b) => a - b);
    const med = quantile(vals, 0.5);
    let s = median(vals.map(v => Math.abs(v - med))) / MAD_CONST;
    if (s === 0) s = (quantile(vals, 0.75) - quantile(vals, 0.25)) / IQR_CONST;
    if (s === 0) { warnings.push(`"${registry[key].displayName || key}" ใน Reference ไม่มีความแปรปรวน (MAD = IQR = 0) — ข้ามตัวแปรนี้ในชั้นหลายตัวแปร`); continue; }
    features.push(key); transforms.push(t); center.push(med); scale.push(s);
  }
  return {
    features, transforms, center, scale, warnings,
    transform(values) {
      const out = new Array<number>(features.length);
      for (let j = 0; j < features.length; j++) {
        let x = values[features[j]];
        if (!Number.isFinite(x)) return null;
        if (transforms[j] === 'log1p') { if (x < 0) return null; x = Math.log1p(x); }
        out[j] = (x - center[j]) / scale[j];
      }
      return out;
    },
  };
}

function referenceMatrix(reference: ReferenceProfile, pp: Preprocessor): { X: number[][]; refIndex: number[] } {
  const n = reference.features[pp.features[0]]?.length ?? 0;
  const X: number[][] = [], refIndex: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = pp.transform(Object.fromEntries(pp.features.map(f => [f, reference.features[f][i]])));
    if (v) { X.push(v); refIndex.push(i); }
  }
  return { X, refIndex };
}

// ─── Isolation Forest ───────────────────────────────────────────────────────
/** Average path length of an unsuccessful BST search: c(n) = 2H(n−1) − 2(n−1)/n. */
export function cFactor(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
}

type INode = { leaf: true; size: number } | { leaf: false; feature: number; split: number; left: INode; right: INode };

function buildTree(X: number[][], idx: number[], depth: number, maxDepth: number, rnd: () => number): INode {
  if (depth >= maxDepth || idx.length <= 1) return { leaf: true, size: idx.length };
  const d = X[0].length;
  // Candidate features with spread in this node.
  const cands: { j: number; lo: number; hi: number }[] = [];
  for (let j = 0; j < d; j++) {
    let lo = Infinity, hi = -Infinity;
    for (const i of idx) { const v = X[i][j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi > lo) cands.push({ j, lo, hi });
  }
  if (cands.length === 0) return { leaf: true, size: idx.length };
  const c = cands[Math.floor(rnd() * cands.length)];
  const split = c.lo + rnd() * (c.hi - c.lo);
  const L: number[] = [], R: number[] = [];
  for (const i of idx) (X[i][c.j] < split ? L : R).push(i);
  return { leaf: false, feature: c.j, split, left: buildTree(X, L, depth + 1, maxDepth, rnd), right: buildTree(X, R, depth + 1, maxDepth, rnd) };
}

function pathLength(x: number[], node: INode, depth = 0): number {
  while (!node.leaf) { node = x[node.feature] < node.split ? node.left : node.right; depth++; }
  return depth + cFactor(node.size);
}

export interface IsolationForestModel {
  trees: INode[];
  inBag: Set<number>[];
  psi: number;
  cPsi: number;
}

export function fitIsolationForest(X: number[][], nTrees = 100, sampleSize = 256, seed = 42): IsolationForestModel {
  const rnd = mulberry32(seed);
  const n = X.length;
  const psi = Math.min(sampleSize, n);
  const maxDepth = Math.ceil(Math.log2(Math.max(psi, 2)));
  const trees: INode[] = [], inBag: Set<number>[] = [];
  const all = Array.from({ length: n }, (_, i) => i);
  for (let t = 0; t < nTrees; t++) {
    // Partial Fisher–Yates → sample without replacement.
    const a = all.slice();
    for (let i = 0; i < psi; i++) { const j = i + Math.floor(rnd() * (n - i)); [a[i], a[j]] = [a[j], a[i]]; }
    const sample = a.slice(0, psi);
    trees.push(buildTree(X, sample, 0, maxDepth, rnd));
    inBag.push(new Set(sample));
  }
  return { trees, inBag, psi, cPsi: cFactor(psi) };
}

/** s(x) = 2^(−E[h(x)] / c(ψ)). Pass `excludeIndex` for out-of-bag (leave-one-out) scoring of a reference row. */
export function isolationScore(m: IsolationForestModel, x: number[], excludeIndex?: number): number {
  let sum = 0, cnt = 0;
  for (let t = 0; t < m.trees.length; t++) {
    if (excludeIndex !== undefined && m.inBag[t].has(excludeIndex)) continue;
    sum += pathLength(x, m.trees[t]); cnt++;
  }
  if (cnt === 0) return NaN;
  return Math.pow(2, -(sum / cnt) / m.cPsi);
}

// ─── LOF (novelty) ──────────────────────────────────────────────────────────
const dist = (a: number[], b: number[]) => { let s = 0; for (let j = 0; j < a.length; j++) { const d = a[j] - b[j]; s += d * d; } return Math.sqrt(s); };

function kNearest(X: number[][], x: number[], k: number, exclude = -1): { i: number; d: number }[] {
  const best: { i: number; d: number }[] = [];
  for (let i = 0; i < X.length; i++) {
    if (i === exclude) continue;
    const d = dist(X[i], x);
    if (best.length < k) { best.push({ i, d }); best.sort((a, b) => a.d - b.d); }
    else if (d < best[k - 1].d) { best[k - 1] = { i, d }; best.sort((a, b) => a.d - b.d); }
  }
  return best;
}

export interface LofModel { X: number[][]; k: number; kDist: number[]; lrd: number[]; looScores: number[] }

function lrdOf(nbrs: { i: number; d: number }[], kDist: number[]): number {
  let s = 0;
  for (const nb of nbrs) s += Math.max(kDist[nb.i], nb.d);
  return 1 / Math.max(s / nbrs.length, EPS);
}

export function fitLof(X: number[][], k = 20): LofModel {
  const kk = Math.min(k, X.length - 1);
  const nbrs = X.map((x, i) => kNearest(X, x, kk, i));   // self excluded
  const kDist = nbrs.map(nb => nb[nb.length - 1].d);
  const lrd = nbrs.map(nb => lrdOf(nb, kDist));
  const looScores = nbrs.map((nb, i) => nb.reduce((s, o) => s + lrd[o.i], 0) / nb.length / lrd[i]);
  return { X, k: kk, kDist, lrd, looScores };
}

export function lofScore(m: LofModel, x: number[]): number {
  const nb = kNearest(m.X, x, m.k);
  const l = lrdOf(nb, m.kDist);
  return nb.reduce((s, o) => s + m.lrd[o.i], 0) / nb.length / l;
}

// ─── Fit cache + detection ──────────────────────────────────────────────────
export interface MultivariateOptions {
  methods?: ('isolation_forest' | 'lof')[];
  nTrees?: number;          // 100
  sampleSize?: number;      // 256
  seed?: number;            // 42
  k?: number;               // 20
  contamination?: number;   // 0.01 → threshold = 99th percentile of reference LOO scores
  columns?: UnivariateColumnOptions;
}

export interface MultivariateFit {
  pp: Preprocessor;
  X: number[][];
  /** X[j] came from reference row refIndex[j] (0-based). */
  refIndex: number[];
  forest: IsolationForestModel;
  lof: LofModel;
  referenceScores: { isolation_forest: number[]; lof: number[] };   // leave-one-out, aligned with X (NaN if no OOB tree)
  thresholds: { isolation_forest: number; lof: number };
  fitMs: number;
}

const fitCache = new Map<string, MultivariateFit>();
export function clearMultivariateCache() { fitCache.clear(); }

export function fitMultivariate(reference: ReferenceProfile, registry: Record<string, FeatureDefinition>, options: MultivariateOptions = {}): MultivariateFit {
  const { nTrees = 100, sampleSize = 256, seed = 42, k = 20, contamination = 0.01, columns } = options;
  const feats = univariateFeatures(registry, columns).map(f => [f, registry[f].anomalyTransform ?? 'none']);
  const key = JSON.stringify([reference.meta.referenceId, reference.meta.sha256, feats, nTrees, sampleSize, seed, k, contamination]);
  const hit = fitCache.get(key);
  if (hit) return hit;

  const t0 = performance.now();
  const pp = preprocess(reference, registry, columns);
  const { X, refIndex } = referenceMatrix(reference, pp);
  const forest = fitIsolationForest(X, nTrees, sampleSize, seed);
  const lof = fitLof(X, k);
  const ifLoo = X.map((x, i) => isolationScore(forest, x, i));
  const pct = (a: number[]) => quantile(a.filter(Number.isFinite).sort((p, q) => p - q), 1 - contamination);
  const fit: MultivariateFit = {
    pp, X, refIndex, forest, lof,
    referenceScores: { isolation_forest: ifLoo, lof: lof.looScores },
    thresholds: { isolation_forest: pct(ifLoo), lof: pct(lof.looScores) },
    fitMs: performance.now() - t0,
  };
  fitCache.set(key, fit);
  return fit;
}

export interface MultivariateResult {
  flags: AnomalyFlag[];
  thresholds: { isolation_forest: number; lof: number };
  warnings: string[];
  scores: { row: number; isolation_forest: number | null; lof: number | null }[];
  timing: { fitMs: number; scoreMs: number; cached: boolean };
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

function explain(z: number[], values: Record<string, number>, pp: Preprocessor, registry: Record<string, FeatureDefinition>): string {
  const top = z.map((v, j) => ({ j, v })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 2).filter(t => Math.abs(t.v) >= 0.5);
  if (top.length === 0) return 'ไม่มีตัวแปรใดเบี่ยงจาก median ชัดเจน — ความผิดปกติมาจากความสัมพันธ์ระหว่างตัวแปร';
  return 'ตัวแปรที่เบี่ยงมากสุด: ' + top.map(({ j, v }) => {
    const f = pp.features[j];
    return `${registry[f]?.displayName || f} = ${fmt(values[f])} (${v > 0 ? 'สูงกว่า' : 'ต่ำกว่า'} median ${Math.abs(v).toFixed(1)} หน่วย robust SD)`;
  }).join(', ');
}

export function detectMultivariateAnomaliesDetailed(
  reference: ReferenceProfile,
  cleanRows: CleanRow[],
  registry: Record<string, FeatureDefinition>,
  options: MultivariateOptions = {},
): MultivariateResult {
  const methods = options.methods ?? ['isolation_forest', 'lof'];
  const before = fitCache.size;
  const fit = fitMultivariate(reference, registry, options);
  const cached = fitCache.size === before;
  const warnings = [...fit.pp.warnings];
  const flags: AnomalyFlag[] = [];
  const scores: MultivariateResult['scores'] = [];
  let skipped = 0;

  const t0 = performance.now();
  for (const r of cleanRows) {
    const z = fit.pp.transform(r.values);
    if (!z) { skipped++; scores.push({ row: r.row, isolation_forest: null, lof: null }); continue; }
    const s = {
      isolation_forest: methods.includes('isolation_forest') ? isolationScore(fit.forest, z) : null,
      lof: methods.includes('lof') ? lofScore(fit.lof, z) : null,
    };
    scores.push({ row: r.row, ...s });
    const why = explain(z, r.values, fit.pp, registry);
    if (s.isolation_forest !== null && s.isolation_forest > fit.thresholds.isolation_forest) {
      flags.push({ row: r.row, method: 'isolation_forest', feature: 'multivariate', value: s.isolation_forest, score: s.isolation_forest,
        reason: `Isolation Forest score = ${s.isolation_forest.toFixed(3)} เกินเกณฑ์ ${fit.thresholds.isolation_forest.toFixed(3)} (เปอร์เซ็นไทล์ที่ ${Math.round((1 - (options.contamination ?? 0.01)) * 100)} ของ Reference) — ${why}` });
    }
    if (s.lof !== null && s.lof > fit.thresholds.lof) {
      flags.push({ row: r.row, method: 'lof', feature: 'multivariate', value: s.lof, score: s.lof,
        reason: `LOF = ${s.lof.toFixed(2)} เกินเกณฑ์ ${fit.thresholds.lof.toFixed(2)} (ความหนาแน่นต่ำกว่าเพื่อนบ้านใน Reference) — ${why}` });
    }
  }
  if (skipped) warnings.push(`ข้าม ${skipped} แถวในชั้นหลายตัวแปร เพราะค่าว่างหรือติดลบในตัวแปรที่ใช้ log (ดูธงจากชั้นค่าโดดแทน)`);

  return { flags, thresholds: fit.thresholds, warnings, scores, timing: { fitMs: fit.fitMs, scoreMs: performance.now() - t0, cached } };
}

export function detectMultivariateAnomalies(
  reference: ReferenceProfile, cleanRows: CleanRow[], registry: Record<string, FeatureDefinition>, options: MultivariateOptions = {},
): AnomalyFlag[] {
  return detectMultivariateAnomaliesDetailed(reference, cleanRows, registry, options).flags;
}
