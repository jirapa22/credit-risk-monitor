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
import { psiForCategories, psiWithBoundaries, jensenShannonDistance, calculateGini, getBinIndex, type DataPoint } from './stats';
import { ksTwoSample, wassersteinScaled, linearQuantile } from './driftReport';
import type {
  AnomalyTransform,
  CalibratedMetricThresholds,
  CalibratedThresholdPair,
  CalibratedThresholds,
} from './types';

export const DEFAULT_CALIBRATION_SIZES = [100, 250, 500, 1000, 2500];
export const DEFAULT_CALIBRATION_RESAMPLES = 1000;
export const DEFAULT_CALIBRATION_SEED = 42;

export interface CalibrateOptions {
  sizes?: number[];
  resamples?: number;
  seed?: number;
  k?: number;
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

function calculatePercentilePair(
  values: number[],
  warnQuantile = 0.95,
  critQuantile = 0.99,
): CalibratedThresholdPair {
  const sorted = [...values].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { warning: 0.10, critical: 0.25 };
  }
  const w = linearQuantile(sorted, warnQuantile);
  const c = linearQuantile(sorted, critQuantile);
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

  const hasLabels = Boolean(reference.hasLabels && reference.labels && reference.labels.length > 0);
  const refLabels = hasLabels ? reference.labels : [];
  let refBadCount = 0;
  let refLabeledCount = 0;
  if (hasLabels) {
    for (let i = 0; i < N; i++) {
      const l = refLabels[i];
      if (l === 0 || l === 1) {
        refLabeledCount++;
        if (l === 1) refBadCount++;
      }
    }
  }
  const refBadRate = refLabeledCount > 0 ? refBadCount / refLabeledCount : 0;

  const scoreDirection = model?.scoring?.score_direction ?? model?.scoreDirection ?? 'higher_is_safer';
  let refGini: number | null = null;
  if (hasLabels && hasScore) {
    const refPts: DataPoint[] = [];
    for (let i = 0; i < N; i++) {
      const l = refLabels[i];
      if (l === 0 || l === 1) {
        refPts.push({ score: refScores[i], label: l });
      }
    }
    if (refPts.length > 0) {
      refGini = calculateGini(refPts, scoreDirection);
    }
  }

  // Precompute bin allocations for Concept worst-bin-ratio
  interface PrecomputedFeatureBins {
    key: string;
    numBins: number;
    binIndices: Int32Array;
    refBinTotals: number[];
    refBinBads: number[];
    candidateBins: number[];
  }
  const precomputedFeatures: PrecomputedFeatureBins[] = [];
  if (hasLabels) {
    for (const f of csiFeatures) {
      if (f.skipped) continue;
      if (f.dataType === 'numeric') {
        const refVals = reference.features[f.key];
        if (!refVals || refVals.length === 0) continue;
        const numBins = f.bins.length + 1;
        const binIndices = new Int32Array(N);
        const refBinTotals = new Array<number>(numBins).fill(0);
        const refBinBads = new Array<number>(numBins).fill(0);
        for (let i = 0; i < N; i++) {
          const b = getBinIndex(refVals[i], f.bins);
          binIndices[i] = b;
          refBinTotals[b]++;
          if (refLabels[i] === 1) refBinBads[b]++;
        }
        const candidateBins: number[] = [];
        for (let b = 0; b < numBins; b++) {
          if (refBinBads[b] >= 5) candidateBins.push(b);
        }
        precomputedFeatures.push({ key: f.key, numBins, binIndices, refBinTotals, refBinBads, candidateBins });
      } else if (f.dataType === 'categorical') {
        const refCats = reference.categoricalFeatures?.[f.key] ?? [];
        if (refCats.length === 0) continue;
        const baseCats = f.categories ?? [];
        const catMap = new Map<string, number>(baseCats.map((c, idx) => [c, idx]));
        const numBins = baseCats.length + 1;
        const binIndices = new Int32Array(N);
        const refBinTotals = new Array<number>(numBins).fill(0);
        const refBinBads = new Array<number>(numBins).fill(0);
        for (let i = 0; i < N; i++) {
          const c = refCats[i];
          const b = c && catMap.has(c) ? catMap.get(c)! : numBins - 1;
          binIndices[i] = b;
          refBinTotals[b]++;
          if (refLabels[i] === 1) refBinBads[b]++;
        }
        const candidateBins: number[] = [];
        for (let b = 0; b < numBins; b++) {
          if (refBinBads[b] >= 5) candidateBins.push(b);
        }
        precomputedFeatures.push({ key: f.key, numBins, binIndices, refBinTotals, refBinBads, candidateBins });
      }
    }
  }

  // Family size for concept: Gini drop + worstBinRatio (or 1 if no scores)
  const kConcept = hasScore && refGini !== null ? 2 : 1;
  const conceptWarnQuantile = 1 - 0.05 / kConcept;
  const conceptCritQuantile = 1 - 0.01 / kConcept;

  // Family size for label: 1
  const labelWarnQuantile = 0.95;
  const labelCritQuantile = 0.99;

  // Calculate family size k = number of decision metrics in the covariate section
  let k = 0;
  if (hasScore) k += 1;
  for (const f of csiFeatures) {
    if (f.skipped) continue;
    if (f.dataType === 'numeric') k += 3; // csi, ks, wasserstein
    else if (f.dataType === 'categorical') k += 2; // csi, js
    else k += 1;
  }
  k = Math.max(1, options?.k ?? k);

  const familyWarnQuantile = 1 - 0.05 / k;
  const familyCritQuantile = 1 - 0.01 / k;

  const bySize: Record<number, CalibratedMetricThresholds> = {};
  const bySizeUnadjusted: Record<number, CalibratedMetricThresholds> = {};

  for (const n of sizes) {
    const psiList: number[] = [];
    const csiLists: Record<string, number[]> = {};
    const ksLists: Record<string, number[]> = {};
    const wassLists: Record<string, number[]> = {};
    const jsLists: Record<string, number[]> = {};
    const giniDropList: number[] = [];
    const badRateRelChangeList: number[] = [];
    const worstBinRatioList: number[] = [];

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

      // Concept & Label statistics under null
      if (hasLabels) {
        let sampleLabeled = 0;
        let sampleBads = 0;
        const samplePts: DataPoint[] = [];

        for (let i = 0; i < n; i++) {
          const idx = sampleIndices[i];
          const l = refLabels[idx];
          if (l === 0 || l === 1) {
            sampleLabeled++;
            if (l === 1) sampleBads++;
            if (hasScore) {
              samplePts.push({ score: refScores[idx], label: l });
            }
          }
        }

        // 1. Label relative change
        if (sampleLabeled > 0 && refBadRate > 0) {
          const sampleBadRate = sampleBads / sampleLabeled;
          const badRateRel = Math.abs(sampleBadRate - refBadRate) / refBadRate;
          badRateRelChangeList.push(badRateRel);
        }

        // 2. Relative Gini drop
        if (refGini !== null && samplePts.length > 0 && Math.abs(refGini) > 1e-12) {
          const sampleGini = calculateGini(samplePts, scoreDirection);
          const giniDrop = (refGini - sampleGini) / Math.abs(refGini);
          giniDropList.push(giniDrop);
        }

        // 3. Worst bin bad rate ratio
        let maxDev = 1.0;
        for (const feat of precomputedFeatures) {
          const actTotals = new Array<number>(feat.numBins).fill(0);
          const actBads = new Array<number>(feat.numBins).fill(0);
          for (let i = 0; i < n; i++) {
            const idx = sampleIndices[i];
            const b = feat.binIndices[idx];
            actTotals[b]++;
            if (refLabels[idx] === 1) actBads[b]++;
          }
          for (const b of feat.candidateBins) {
            if (actBads[b] >= 5 && actTotals[b] > 0) {
              const rRate = feat.refBinBads[b] / feat.refBinTotals[b];
              const aRate = actBads[b] / actTotals[b];
              if (rRate > 0 && aRate > 0) {
                const ratio = aRate / rRate;
                const dev = Math.max(ratio, 1 / ratio);
                if (dev > maxDev) maxDev = dev;
              }
            }
          }
        }
        worstBinRatioList.push(maxDev);
      }
    }

    // Compute family-wise (Bonferroni) and unadjusted percentiles
    const metricThresholds: CalibratedMetricThresholds = {
      csi: {},
      ks: {},
      wasserstein: {},
      js: {},
    };
    const metricThresholdsUnadjusted: CalibratedMetricThresholds = {
      csi: {},
      ks: {},
      wasserstein: {},
      js: {},
    };

    if (hasScore && psiList.length > 0) {
      metricThresholds.psi = calculatePercentilePair(psiList, familyWarnQuantile, familyCritQuantile);
      metricThresholdsUnadjusted.psi = calculatePercentilePair(psiList, 0.95, 0.99);
    }

    for (const [key, vals] of Object.entries(csiLists)) {
      if (vals.length > 0) {
        metricThresholds.csi[key] = calculatePercentilePair(vals, familyWarnQuantile, familyCritQuantile);
        metricThresholdsUnadjusted.csi[key] = calculatePercentilePair(vals, 0.95, 0.99);
      }
    }
    for (const [key, vals] of Object.entries(ksLists)) {
      if (vals.length > 0) {
        metricThresholds.ks[key] = calculatePercentilePair(vals, familyWarnQuantile, familyCritQuantile);
        metricThresholdsUnadjusted.ks[key] = calculatePercentilePair(vals, 0.95, 0.99);
      }
    }
    for (const [key, vals] of Object.entries(wassLists)) {
      if (vals.length > 0) {
        metricThresholds.wasserstein[key] = calculatePercentilePair(vals, familyWarnQuantile, familyCritQuantile);
        metricThresholdsUnadjusted.wasserstein[key] = calculatePercentilePair(vals, 0.95, 0.99);
      }
    }
    for (const [key, vals] of Object.entries(jsLists)) {
      if (vals.length > 0) {
        metricThresholds.js[key] = calculatePercentilePair(vals, familyWarnQuantile, familyCritQuantile);
        metricThresholdsUnadjusted.js[key] = calculatePercentilePair(vals, 0.95, 0.99);
      }
    }

    if (hasLabels) {
      if (badRateRelChangeList.length > 0) {
        const pair = calculatePercentilePair(badRateRelChangeList, labelWarnQuantile, labelCritQuantile);
        metricThresholds.label = { badRateRelChange: pair };
        metricThresholdsUnadjusted.label = { badRateRelChange: pair };
      }

      const sortedGini = [...giniDropList].sort((a, b) => a - b);
      const nullP95Gini = sortedGini.length > 0 ? linearQuantile(sortedGini, 0.95) : 0.15;
      const nullP99Gini = sortedGini.length > 0 ? linearQuantile(sortedGini, 0.99) : 0.25;

      metricThresholds.concept = {
        giniDrop: calculatePercentilePair(giniDropList, conceptWarnQuantile, conceptCritQuantile),
        worstBinRatio: calculatePercentilePair(worstBinRatioList, conceptWarnQuantile, conceptCritQuantile),
        nullP95GiniDrop: Number(nullP95Gini.toFixed(4)),
        nullP99GiniDrop: Number(nullP99Gini.toFixed(4)),
      };
      metricThresholdsUnadjusted.concept = {
        giniDrop: calculatePercentilePair(giniDropList, 0.95, 0.99),
        worstBinRatio: calculatePercentilePair(worstBinRatioList, 0.95, 0.99),
        nullP95GiniDrop: Number(nullP95Gini.toFixed(4)),
        nullP99GiniDrop: Number(nullP99Gini.toFixed(4)),
      };
    }

    bySize[n] = metricThresholds;
    bySizeUnadjusted[n] = metricThresholdsUnadjusted;
  }

  return {
    calibratedAt: new Date().toISOString(),
    resamples,
    seed: baseSeed,
    sizes,
    k,
    bySize,
    bySizeUnadjusted,
  };
}

