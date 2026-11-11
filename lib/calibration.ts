/**
 * Null-distribution Calibration for Drift Detection (Step 11b.1).
 *
 * Automatically calibrates warning (p95) and critical (p99) thresholds
 * for PSI, CSI, KS, Wasserstein, and JS Distance across file sizes n
 * via bootstrap resampling from the Reference dataset without any injection.
 */
import { mulberry32 } from './random';
import type { ReferenceProfile } from './reference';
import { resolveCsiFeatures } from './drift';
import { psiForCategories, psiWithBoundaries, jensenShannonDistance } from './stats';
import { ksTwoSample, wassersteinScaled, linearQuantile } from './driftReport';
import type {
  AnomalyTransform,
  CalibratedMetricThresholds,
  CalibratedThresholdPair,
  CalibratedThresholds,
} from './types';

export const DEFAULT_CALIBRATION_SIZES = [100, 250, 500, 1000, 2500];
export const DEFAULT_CALIBRATION_RESAMPLES = 200;
export const DEFAULT_CALIBRATION_SEED = 42;

export interface CalibrateOptions {
  sizes?: number[];
  resamples?: number;
  seed?: number;
}

export function getNearestSize(sizes: number[], n: number): number {
  if (!sizes || sizes.length === 0) return n;
  let nearest = sizes[0];
  let minDiff = Math.abs(sizes[0] - n);
  for (let i = 1; i < sizes.length; i++) {
    const diff = Math.abs(sizes[i] - n);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = sizes[i];
    }
  }
  return nearest;
}

function calculatePercentilePair(values: number[]): CalibratedThresholdPair {
  const sorted = [...values].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { warning: 0.10, critical: 0.25 };
  }
  const w = linearQuantile(sorted, 0.95);
  const c = linearQuantile(sorted, 0.99);
  // Ensure critical is at least equal to warning
  const critical = Math.max(w, c);
  return {
    warning: Number(w.toFixed(6)),
    critical: Number(critical.toFixed(6)),
  };
}

/**
 * Calibrates thresholds by computing the empirical null distribution
 * of drift statistics on bootstrap samples from the reference dataset.
 */
export function calibrateThresholds(
  reference: ReferenceProfile,
  model: any,
  options?: CalibrateOptions,
): CalibratedThresholds {
  const sizes = options?.sizes ?? DEFAULT_CALIBRATION_SIZES;
  const resamples = options?.resamples ?? DEFAULT_CALIBRATION_RESAMPLES;
  const baseSeed = options?.seed ?? DEFAULT_CALIBRATION_SEED;

  const N = reference.meta.rowCount;
  if (!N || N <= 0) {
    throw new Error(`Cannot calibrate thresholds: reference dataset has 0 rows`);
  }

  const registry = model?.featureRegistry ?? {};
  const thresholds = model?.thresholds ?? { csi_features: {} };
  const csiFeatures = resolveCsiFeatures(registry, thresholds, reference);

  const hasScore = Boolean(reference.hasScores && reference.scores && reference.scores.length > 0);
  const refScores = hasScore ? reference.scores : [];
  const scoreBoundaries = hasScore ? reference.scoreBoundaries : [];

  const bySize: Record<number, CalibratedMetricThresholds> = {};

  for (const n of sizes) {
    const psiList: number[] = [];
    const csiLists: Record<string, number[]> = {};
    const ksLists: Record<string, number[]> = {};
    const wassLists: Record<string, number[]> = {};
    const jsLists: Record<string, number[]> = {};

    for (const f of csiFeatures) {
      if (f.skipped) continue;
      csiLists[f.key] = [];
      if (f.dataType === 'numeric') {
        ksLists[f.key] = [];
        wassLists[f.key] = [];
      } else if (f.dataType === 'categorical') {
        jsLists[f.key] = [];
      }
    }

    const rnd = mulberry32(baseSeed + n * 17);

    for (let r = 0; r < resamples; r++) {
      // Bootstrap sample row indices with replacement
      const sampleIndices = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        sampleIndices[i] = Math.floor(rnd() * N);
      }

      // Sampled score PSI
      if (hasScore) {
        const sampledScores = new Array<number>(n);
        for (let i = 0; i < n; i++) {
          sampledScores[i] = refScores[sampleIndices[i]];
        }
        const psiRes = psiWithBoundaries(refScores, sampledScores, scoreBoundaries);
        psiList.push(psiRes.value);
      }

      // Sampled feature metrics
      for (const f of csiFeatures) {
        if (f.skipped) continue;

        if (f.dataType === 'numeric') {
          const refVals = reference.features[f.key];
          if (!refVals || refVals.length === 0) continue;

          const sampledVals = new Array<number>(n);
          for (let i = 0; i < n; i++) {
            sampledVals[i] = refVals[sampleIndices[i]];
          }

          // CSI
          const csiRes = psiWithBoundaries(refVals, sampledVals, f.bins);
          csiLists[f.key].push(csiRes.value);

          // KS D
          const ksRes = ksTwoSample(refVals, sampledVals);
          ksLists[f.key].push(ksRes.d);

          // Wasserstein
          const transform = (registry[f.key]?.anomalyTransform ?? 'none') as AnomalyTransform;
          const wassRes = wassersteinScaled(refVals, sampledVals, transform);
          wassLists[f.key].push(wassRes.scaled);
        } else if (f.dataType === 'categorical') {
          const refCats = reference.categoricalFeatures?.[f.key] ?? [];
          if (refCats.length === 0) continue;

          const baseCats = f.categories ?? [];
          const sampledCats = new Array<string | null>(n);
          for (let i = 0; i < n; i++) {
            sampledCats[i] = refCats[sampleIndices[i]];
          }

          // Cat CSI
          const catPsi = psiForCategories(refCats, sampledCats, baseCats);
          csiLists[f.key].push(catPsi.value);

          // JS Distance
          const expectedCounts = catPsi.bins.map(b => b.expectedCount);
          const actualCounts = catPsi.bins.map(b => b.actualCount);
          const jsRaw = jensenShannonDistance(expectedCounts, actualCounts);
          jsLists[f.key].push(jsRaw.distance);
        }
      }
    }

    // Compute 95th and 99th percentiles
    const metricThresholds: CalibratedMetricThresholds = {
      csi: {},
      ks: {},
      wasserstein: {},
      js: {},
    };

    if (hasScore && psiList.length > 0) {
      metricThresholds.psi = calculatePercentilePair(psiList);
    }

    for (const [key, vals] of Object.entries(csiLists)) {
      if (vals.length > 0) metricThresholds.csi[key] = calculatePercentilePair(vals);
    }
    for (const [key, vals] of Object.entries(ksLists)) {
      if (vals.length > 0) metricThresholds.ks[key] = calculatePercentilePair(vals);
    }
    for (const [key, vals] of Object.entries(wassLists)) {
      if (vals.length > 0) metricThresholds.wasserstein[key] = calculatePercentilePair(vals);
    }
    for (const [key, vals] of Object.entries(jsLists)) {
      if (vals.length > 0) metricThresholds.js[key] = calculatePercentilePair(vals);
    }

    bySize[n] = metricThresholds;
  }

  return {
    calibratedAt: new Date().toISOString(),
    resamples,
    seed: baseSeed,
    sizes,
    bySize,
  };
}

