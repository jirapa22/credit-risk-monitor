/**
 * Layer 3 — Univariate outlier detection (warning-only).
 *
 * Runs on CleanRow[] AFTER Data Validation and BEFORE Drift Detection.
 * It never removes rows: it only returns AnomalyFlag[]; the user decides.
 *
 * All reference statistics (Q1/Q3/IQR, median/MAD) are computed from the
 * frozen Reference dataset ONLY — never from the uploaded data — so a
 * shifted upload cannot "normalise" its own outliers.
 *
 * Features are taken from featureRegistry (numeric, monitoringEnabled,
 * excluding default_flag) — no feature names are hard-coded.
 *
 * Per-feature `anomalyTransform` (default 'none'): right-skewed features
 * (income, loan amount) use 'log1p' so that IQR/MAD are computed on a roughly
 * symmetric scale. The same transform is applied to Reference and new data.
 * Flags always report the ORIGINAL value; IQR fences are shown in original
 * units (expm1) for readability.
 */
import type { AnomalyFlag, AnomalyTransform, FeatureDefinition } from '../types';
import type { ReferenceProfile } from '../reference';
import type { CleanRow } from '../validation';

export interface CrossFieldRule {
  id?: string;                 // defaults to "numerator/denominator"
  numerator: string;
  denominator: string;
  op: '>' | '<';
  threshold: number;
  label?: string;              // Thai description shown in reason
}

export interface UnivariateOptions {
  iqrK?: number;               // default 1.5
  madThreshold?: number;       // |robust z| threshold, default 3.5
  methods?: ('iqr' | 'mad' | 'cross_field')[]; // default all
  crossFieldRules?: CrossFieldRule[];
  /** Override registry transforms, e.g. { monthly_income: 'none' } (used for comparisons). */
  transformOverride?: Record<string, AnomalyTransform>;
}

export interface FeatureStats {
  feature: string;
  transform: AnomalyTransform;
  n: number;
  /** Below: all on the transformed scale (= original when transform is 'none'). */
  q1: number; q3: number; iqr: number;
  lowerFence: number; upperFence: number;
  median: number; mad: number;
  /** IQR fences converted back to original units. */
  lowerFenceOriginal: number; upperFenceOriginal: number;
}

export interface UnivariateResult {
  flags: AnomalyFlag[];
  stats: Record<string, FeatureStats>;
  warnings: string[];          // e.g. MAD = 0 → feature skipped
}

const MAD_CONST = 0.6745;

/** Linear-interpolated quantile (same as numpy default / Excel QUARTILE.INC). */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

const forward = (t: AnomalyTransform, x: number) => (t === 'log1p' ? Math.log1p(x) : x);
const inverse = (t: AnomalyTransform, y: number) => (t === 'log1p' ? Math.expm1(y) : y);

/** Numeric features in the registry that layer 3 should check. */
export function univariateFeatures(registry: Record<string, FeatureDefinition>): string[] {
  return Object.entries(registry)
    .filter(([k, d]) => d.dataType === 'numeric' && d.monitoringEnabled !== false && k !== 'default_flag')
    .map(([k]) => k);
}

/** Q1/Q3/IQR/median/MAD per feature — from the Reference dataset only. */
export function computeReferenceStats(
  reference: ReferenceProfile, registry: Record<string, FeatureDefinition>, iqrK = 1.5,
  transformOverride: Record<string, AnomalyTransform> = {},
): { stats: Record<string, FeatureStats>; warnings: string[] } {
  const stats: Record<string, FeatureStats> = {};
  const warnings: string[] = [];
  for (const key of univariateFeatures(registry)) {
    const transform = transformOverride[key] ?? registry[key].anomalyTransform ?? 'none';
    const raw = (reference.features[key] ?? []).filter(Number.isFinite);
    if (raw.length === 0) { warnings.push(`ไม่มีตัวแปร "${key}" ใน Reference Dataset — ข้ามการตรวจค่าโดด`); continue; }
    const usable = transform === 'log1p' ? raw.filter(v => v >= 0) : raw;
    if (usable.length < raw.length) {
      warnings.push(`Reference ของ "${key}" มีค่าติดลบ ${raw.length - usable.length} ค่า — ไม่นำมาคำนวณบน log scale`);
    }
    const vals = usable.map(v => forward(transform, v));
    const sorted = [...vals].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
    const med = quantile(sorted, 0.5);
    const mad = median(vals.map(v => Math.abs(v - med)));
    const lowerFence = q1 - iqrK * iqr, upperFence = q3 + iqrK * iqr;
    stats[key] = {
      feature: key, transform, n: vals.length, q1, q3, iqr, lowerFence, upperFence, median: med, mad,
      lowerFenceOriginal: inverse(transform, lowerFence), upperFenceOriginal: inverse(transform, upperFence),
    };
  }
  return { stats, warnings };
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

export function detectUnivariateAnomaliesDetailed(
  reference: ReferenceProfile,
  cleanRows: CleanRow[],
  registry: Record<string, FeatureDefinition>,
  options: UnivariateOptions = {},
): UnivariateResult {
  const {
    iqrK = 1.5, madThreshold = 3.5, methods = ['iqr', 'mad', 'cross_field'], crossFieldRules = [], transformOverride = {},
  } = options;
  const { stats, warnings } = computeReferenceStats(reference, registry, iqrK, transformOverride);
  const flags: AnomalyFlag[] = [];
  const name = (k: string) => registry[k]?.displayName || k;
  const scaleNote = (s: FeatureStats) => (s.transform === 'log1p' ? ' (คำนวณบน log scale)' : '');

  const iqrOn = methods.includes('iqr');
  const madOn = methods.includes('mad');
  const madFeatures = new Set<string>();
  const iqrFeatures = new Set<string>();
  for (const s of Object.values(stats)) {
    if (madOn) {
      if (s.mad === 0) warnings.push(`MAD ของ "${name(s.feature)}" ใน Reference = 0 — ข้ามการตรวจ Robust Z-score ของตัวแปรนี้`);
      else madFeatures.add(s.feature);
    }
    if (iqrOn) {
      if (s.iqr === 0) warnings.push(`IQR ของ "${name(s.feature)}" ใน Reference = 0 — ค่าที่ต่างจาก ${fmt(inverse(s.transform, s.q1))} ทุกค่าจะโดนธง IQR`);
      iqrFeatures.add(s.feature);
    }
  }

  for (const r of cleanRows) {
    for (const s of Object.values(stats)) {
      const x = r.values[s.feature];
      if (!Number.isFinite(x)) continue;

      // Negative value cannot be log-transformed → flag directly.
      if (s.transform === 'log1p' && x < 0) {
        const reason = `"${name(s.feature)}" = ${fmt(x)} ติดลบ — ไม่สามารถแปลง log ได้ จึงถือว่าผิดปกติ`;
        if (iqrFeatures.has(s.feature)) flags.push({ row: r.row, method: 'iqr', feature: s.feature, value: x, score: Infinity, reason });
        if (madFeatures.has(s.feature)) flags.push({ row: r.row, method: 'mad', feature: s.feature, value: x, score: -Infinity, reason });
        continue;
      }
      const y = forward(s.transform, x);

      if (iqrFeatures.has(s.feature) && (y < s.lowerFence || y > s.upperFence)) {
        const below = y < s.lowerFence;
        const dist = below ? s.lowerFence - y : y - s.upperFence;
        flags.push({
          row: r.row, method: 'iqr', feature: s.feature, value: x,
          score: s.iqr > 0 ? dist / s.iqr : Infinity,
          reason: `"${name(s.feature)}" = ${fmt(x)} ${below ? 'ต่ำกว่า' : 'สูงกว่า'}ขอบ IQR ของ Reference [${fmt(s.lowerFenceOriginal)}, ${fmt(s.upperFenceOriginal)}] (k = ${iqrK})${scaleNote(s)}`,
        });
      }

      if (madFeatures.has(s.feature)) {
        const z = (MAD_CONST * (y - s.median)) / s.mad;
        if (Math.abs(z) > madThreshold) {
          flags.push({
            row: r.row, method: 'mad', feature: s.feature, value: x, score: z,
            reason: `"${name(s.feature)}" = ${fmt(x)} มี Robust Z = ${z.toFixed(2)} (|z| > ${madThreshold}) เทียบ median ${fmt(inverse(s.transform, s.median))} ของ Reference${scaleNote(s)}`,
          });
        }
      }
    }

    if (methods.includes('cross_field')) {
      for (const rule of crossFieldRules) {
        const num = r.values[rule.numerator], den = r.values[rule.denominator];
        if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) continue;
        const ratio = num / den;
        if (rule.op === '>' ? ratio > rule.threshold : ratio < rule.threshold) {
          const id = rule.id ?? `${rule.numerator}/${rule.denominator}`;
          flags.push({
            row: r.row, method: 'cross_field', feature: id, value: ratio, score: ratio / rule.threshold,
            reason: `${rule.label ?? `${name(rule.numerator)} / ${name(rule.denominator)}`} = ${ratio.toFixed(2)} ${rule.op === '>' ? 'เกิน' : 'ต่ำกว่า'}เกณฑ์ ${rule.threshold}`,
          });
        }
      }
    }
  }

  // Warn about rules referencing unknown features (config typo).
  for (const rule of crossFieldRules) {
    for (const f of [rule.numerator, rule.denominator]) {
      if (!registry[f]) warnings.push(`กฎข้ามตัวแปรอ้างถึง "${f}" ซึ่งไม่มีใน featureRegistry`);
    }
  }

  return { flags, stats, warnings };
}

/** Main entry: returns flags only. Use the *Detailed variant for stats & warnings. */
export function detectUnivariateAnomalies(
  reference: ReferenceProfile,
  cleanRows: CleanRow[],
  registry: Record<string, FeatureDefinition>,
  options: UnivariateOptions = {},
): AnomalyFlag[] {
  return detectUnivariateAnomaliesDetailed(reference, cleanRows, registry, options).flags;
}
