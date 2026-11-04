import { describe, expect, it } from 'vitest';
import {
  assessMetricReliability, calculateAUC, calculateKS, countBins, getBinIndex, psiFromCounts, psiWithBoundaries, quantileBoundaries,
} from '../lib/stats';
import { calculateAScore, scoreToPD, validateScoringConfig } from '../lib/scoring';
import { getReferenceProfile } from '../lib/reference';
import { runDriftDetection } from '../lib/drift';
import modelConfig from '../app/model-config.json';
import type { FeatureDefinition, MonitoringThresholds, ScoringConfig } from '../lib/types';

const model = (modelConfig as any).models.ascore_v1;
const scoring = model.scoring as ScoringConfig;
const registry = model.featureRegistry as Record<string, FeatureDefinition>;
const thresholds = model.thresholds as MonitoringThresholds;

describe('binning (pandas.cut right=True convention)', () => {
  const b = [17800, 22300, 27520, 36360];
  it('value equal to a boundary falls in the lower bin', () => {
    expect(getBinIndex(17800, b)).toBe(0);
    expect(getBinIndex(17800.01, b)).toBe(1);
    expect(getBinIndex(36360, b)).toBe(3);
    expect(getBinIndex(36361, b)).toBe(4);
    expect(getBinIndex(-1, b)).toBe(0);
  });
  it('reproduces the development bin counts of the model report (train + test)', () => {
    const ref = getReferenceProfile('ascore_v1_dev855', scoring);
    // Scorecard sheet (train) + PSI&CSI sheet (test) per bin
    expect(countBins(ref.features.monthly_income, b)).toEqual([124 + 61, 117 + 36, 118 + 60, 119 + 46, 120 + 54]);
    expect(countBins(ref.features.loan_amount, [46000, 63000, 81000, 112000])).toEqual([121 + 54, 119 + 45, 122 + 44, 118 + 65, 118 + 49]);
    expect(countBins(ref.features.dti_ratio, [0.264, 0.36, 0.47, 0.606])).toEqual([120 + 53, 122 + 55, 121 + 45, 115 + 55, 120 + 49]);
  });
  it('quantile boundaries drop duplicates from tied values', () => {
    // 20/40/60/80th percentiles = 1, 1, 2, 3 → duplicates removed
    expect(quantileBoundaries([1, 1, 1, 1, 2, 2, 3, 3, 4, 5], 5)).toEqual([1, 2, 3]);
    expect(quantileBoundaries([7, 7, 7], 10)).toEqual([]);
  });
});

describe('PSI / CSI', () => {
  it('hand-computed example', () => {
    // (0.25-0.5)ln(0.5) + (0.75-0.5)ln(1.5)
    expect(psiFromCounts([50, 50], [25, 75]).value).toBeCloseTo(0.274653, 6);
  });
  it('identical distributions → 0, and PSI is non-negative', () => {
    expect(psiFromCounts([10, 20, 30], [1, 2, 3]).value).toBeCloseTo(0, 12);
    expect(psiFromCounts([10, 20, 30], [30, 20, 10]).value).toBeGreaterThan(0);
  });
  it('contributions sum to the total', () => {
    const r = psiFromCounts([124, 117, 118, 119, 120], [61, 36, 60, 46, 54]);
    expect(r.bins.reduce((s, b) => s + b.contribution, 0)).toBeCloseTo(r.value, 12);
  });
  it('matches the CSI values published in ascore_model_report.xlsx', () => {
    expect(psiFromCounts([124, 117, 118, 119, 120], [61, 36, 60, 46, 54]).value).toBeCloseTo(0.0313, 4);
    expect(psiFromCounts([121, 119, 122, 118, 118], [54, 45, 44, 65, 49]).value).toBeCloseTo(0.0231, 4);
    expect(psiFromCounts([120, 122, 121, 115, 120], [53, 55, 45, 55, 49]).value).toBeCloseTo(0.0074, 4);
  });
  it('empty bin uses epsilon instead of producing Infinity', () => {
    const v = psiFromCounts([50, 50], [100, 0]).value;
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(1);
  });
  it('rejects mismatched bin arrays', () => {
    expect(() => psiFromCounts([1, 2], [1, 2, 3])).toThrow();
  });
});

describe('A-Score scoring', () => {
  it('scorecard config is internally consistent', () => {
    expect(validateScoringConfig(scoring)).toEqual([]);
  });
  it('CUS100000: 19,100 / 62,000 / 0.62 → 554.2 − 2.1 + 4.6 − 20.7 = 536.0', () => {
    const s = calculateAScore(scoring, { monthly_income: 19100, loan_amount: 62000, dti_ratio: 0.62 });
    expect(s).toBeCloseTo(536.0, 6);
    expect(scoreToPD(scoring, s)).toBeCloseTo(0.1553, 4);
  });
  it('best and worst possible scores', () => {
    expect(calculateAScore(scoring, { monthly_income: 99999, loan_amount: 1000, dti_ratio: 0.1 })).toBeCloseTo(554.2 + 13.6 + 13.3 + 22.4, 6);
    expect(calculateAScore(scoring, { monthly_income: 1000, loan_amount: 999999, dti_ratio: 2 })).toBeCloseTo(554.2 - 10.2 - 13.6 - 20.7, 6);
  });
  it('higher score → lower PD; score at offset → PD 0.5', () => {
    expect(scoreToPD(scoring, scoring.offset)).toBeCloseTo(0.5, 4);
    expect(scoreToPD(scoring, 600)).toBeLessThan(scoreToPD(scoring, 520));
  });
  it('refuses to score a missing feature instead of treating it as 0', () => {
    expect(() => calculateAScore(scoring, { monthly_income: 20000, loan_amount: 50000 } as any)).toThrow();
  });
});

describe('fixed reference dataset', () => {
  const ref = getReferenceProfile('ascore_v1_dev855', scoring);
  it('is the frozen development population', () => {
    expect(ref.meta.rowCount).toBe(855);
    expect(ref.meta.badCount).toBe(80);
    expect(ref.scores).toHaveLength(855);
  });
  it('is deterministic — same profile every call (no random baseline)', () => {
    const again = getReferenceProfile('ascore_v1_dev855', scoring);
    expect(again.scores).toEqual(ref.scores);
    expect(again.scoreBoundaries).toEqual(ref.scoreBoundaries);
  });
  it('reference vs itself → PSI = 0 and every CSI = 0', () => {
    const d = runDriftDetection(ref, ref.scores, ref.features, registry, thresholds);
    expect(d.psi.value).toBeCloseTo(0, 12);
    for (const c of Object.values(d.csi)) expect(c.value).toBeCloseTo(0, 12);
    expect(d.overallStatus).toBe('STABLE');
  });
  it('a clear shift is detected and attributed to the shifted feature', () => {
    const shifted: Record<string, number[]> = { ...ref.features, dti_ratio: ref.features.dti_ratio.map(v => v + 0.25) };
    const scores = ref.scores.map((_, i) => calculateAScore(scoring, {
      monthly_income: shifted.monthly_income[i], loan_amount: shifted.loan_amount[i], dti_ratio: shifted.dti_ratio[i],
    }));
    const d = runDriftDetection(ref, scores, shifted, registry, thresholds);
    expect(d.csi.dti_ratio.status).toBe('CRITICAL');
    expect(d.csi.monthly_income.value).toBeCloseTo(0, 12);
    expect(d.triggered).toContain('csi:dti_ratio');
  });
  it('score PSI uses fixed reference deciles', () => {
    const r = psiWithBoundaries(ref.scores, ref.scores, ref.scoreBoundaries);
    expect(r.bins.length).toBe(ref.scoreBoundaries.length + 1);
  });
});

describe('discrimination metrics & the AUC = 1.000 / KS = 100% issue', () => {
  const ref = getReferenceProfile('ascore_v1_dev855', scoring);
  const data = ref.scores.map((s, i) => ({ score: s, label: ref.labels[i] }));

  it('A-Score on the development data gives a plausible AUC/KS (direction matters)', () => {
    const auc = calculateAUC(data, 'higher_is_better');
    expect(auc).toBeGreaterThan(0.65);
    expect(auc).toBeLessThan(0.78);
    // the old default direction returns 1 − AUC for a scorecard
    expect(calculateAUC(data)).toBeCloseTo(1 - auc, 10);
    const ks = calculateKS(data);
    expect(ks).toBeGreaterThan(0.25);
    expect(ks).toBeLessThan(0.45);
    expect(assessMetricReliability(data, auc, ks).reliable).toBe(true);
  });

  it('KS is not inflated by tied scores (old implementation returned 1.0 here)', () => {
    const tied = [{ score: 1, label: 0 }, { score: 1, label: 1 }, { score: 2, label: 0 }, { score: 2, label: 1 }];
    expect(calculateKS(tied)).toBe(0);
    expect(calculateAUC(tied)).toBe(0.5);
  });

  it('target leakage produces AUC = 1 / KS = 100% and is flagged', () => {
    const leaked = ref.labels.map(l => ({ score: l, label: l })); // "score" derived from the outcome
    const auc = calculateAUC(leaked);
    const ks = calculateKS(leaked);
    expect(auc).toBe(1);
    expect(ks).toBe(1);
    const r = assessMetricReliability(leaked, auc, ks);
    expect(r.reliable).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/leakage/);
  });

  it('too few bads is flagged', () => {
    const tiny = [{ score: 1, label: 1 }, { score: 2, label: 0 }, { score: 3, label: 0 }];
    expect(assessMetricReliability(tiny, calculateAUC(tiny), calculateKS(tiny)).reliable).toBe(false);
  });
});
