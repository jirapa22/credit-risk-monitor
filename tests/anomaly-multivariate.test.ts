import { describe, expect, it } from 'vitest';
import { getReferenceProfile } from '../lib/reference';
import { detectUnivariateAnomalies, detectUnivariateAnomaliesDetailed, univariateFeatures, quantile } from '../lib/anomaly/univariate';
import {
  cFactor, clearMultivariateCache, detectMultivariateAnomaliesDetailed, fitMultivariate,
} from '../lib/anomaly/multivariate';
import type { CleanRow } from '../lib/validation';
import type { FeatureDefinition } from '../lib/types';
import modelConfig from '../app/model-config.json';

const model = (modelConfig as any).models.ascore_v1;
const registry = model.featureRegistry as Record<string, FeatureDefinition>;
const reference = getReferenceProfile(model.referenceDatasetId, model.scoring);
const features = univariateFeatures(registry);

const row = (n: number, values: Record<string, number>): CleanRow => ({ row: n, id: `C${n}`, date: null, values, label: null, imputed: [] });
const pctOf = (f: string, p: number) => quantile([...reference.features[f]].sort((a, b) => a - b), p);
const referenceRows = () => reference.labels.map((_, i) => row(i + 1, Object.fromEntries(features.map(f => [f, reference.features[f][i]]))));

describe('layer 4 — multivariate anomalies', () => {
  it('(5) c(256) ≈ 10.24', () => {
    expect(cFactor(256)).toBeCloseTo(10.24, 2);
    expect(cFactor(1)).toBe(0);
  });

  it('(1) same seed → identical scores; different seed → different IF scores', () => {
    const rows = referenceRows().slice(0, 50);
    clearMultivariateCache();
    const a = detectMultivariateAnomaliesDetailed(reference, rows, registry, { seed: 42 }).scores;
    clearMultivariateCache();
    const b = detectMultivariateAnomaliesDetailed(reference, rows, registry, { seed: 42 }).scores;
    const c = detectMultivariateAnomaliesDetailed(reference, rows, registry, { seed: 7 }).scores;
    expect(b).toEqual(a);
    expect(c.map(s => s.isolation_forest)).not.toEqual(a.map(s => s.isolation_forest));
  });

  // Isolation Forest (Liu et al., 2008) splits ONE axis at a time (axis-parallel cuts).
  // A point whose values are each unremarkable on its own axis — but whose
  // COMBINATION contradicts the joint structure (low income + large loan + low DTI) —
  // sits inside the bulk on every single axis, so random axis cuts rarely isolate it
  // early. LOF compares local density in the full space and does catch it.
  // Hence IF is only logged here (not asserted); this is why layer 4 uses both methods.
  const jointRow = () => row(1, { monthly_income: pctOf('monthly_income', 0.10), loan_amount: pctOf('loan_amount', 0.95), dti_ratio: pctOf('dti_ratio', 0.05) });

  it('(2) jointly-unusual row: LOF flags it, IQR/MAD do not (IF logged only)', () => {
    const r = jointRow();
    const uni = detectUnivariateAnomalies(reference, [r], registry).filter(f => f.method === 'iqr' || f.method === 'mad');
    expect(uni).toEqual([]);
    const { flags, scores, thresholds } = detectMultivariateAnomaliesDetailed(reference, [r], registry);
    console.log('JOINT ' + JSON.stringify({ values: r.values, ifScore: scores[0].isolation_forest, ifThreshold: thresholds.isolation_forest, ifFlagged: flags.some(f => f.method === 'isolation_forest'), lof: scores[0].lof, lofThreshold: thresholds.lof }));
    expect(flags.some(f => f.method === 'lof')).toBe(true);
    expect(flags.every(f => f.feature === 'multivariate')).toBe(true);
  });

  it('(2b) IF robustness across seeds 1..30 (report only)', () => {
    const r = jointRow();
    const rowsOut: { seed: number; score: number; threshold: number; flagged: boolean }[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const res = detectMultivariateAnomaliesDetailed(reference, [r], registry, { seed, methods: ['isolation_forest'] });
      const score = res.scores[0].isolation_forest!;
      rowsOut.push({ seed, score, threshold: res.thresholds.isolation_forest, flagged: score > res.thresholds.isolation_forest });
    }
    const ms = (a: number[]) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return { mean: m, sd: Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) }; };
    console.log('SEEDS ' + JSON.stringify({
      flaggedSeeds: rowsOut.filter(x => x.flagged).length, of: rowsOut.length,
      score: ms(rowsOut.map(x => x.score)), threshold: ms(rowsOut.map(x => x.threshold)), margin: ms(rowsOut.map(x => x.score - x.threshold)),
      rows: rowsOut.map(x => [x.seed, +x.score.toFixed(4), +x.threshold.toFixed(4), x.flagged]),
    }));
  });

  it('(2c) more extreme combination (p5 / p99 / p2): LOF flags it', () => {
    const r = row(1, { monthly_income: pctOf('monthly_income', 0.05), loan_amount: pctOf('loan_amount', 0.99), dti_ratio: pctOf('dti_ratio', 0.02) });
    const uni = detectUnivariateAnomaliesDetailed(reference, [r], registry);
    const { flags, scores, thresholds } = detectMultivariateAnomaliesDetailed(reference, [r], registry);
    console.log('EXTREME ' + JSON.stringify({
      values: r.values,
      if: { score: scores[0].isolation_forest, threshold: thresholds.isolation_forest, flagged: flags.some(f => f.method === 'isolation_forest') },
      lof: { score: scores[0].lof, threshold: thresholds.lof, flagged: flags.some(f => f.method === 'lof') },
      univariate: uni.flags.map(f => `${f.method}:${f.feature}:${f.score.toFixed(2)}`),
    }));
    expect(flags.some(f => f.method === 'lof')).toBe(true);
  });

  it('(3) all-median row is not flagged', () => {
    const r = row(1, Object.fromEntries(features.map(f => [f, pctOf(f, 0.5)])));
    expect(detectMultivariateAnomaliesDetailed(reference, [r], registry).flags).toEqual([]);
  });

  it('(4) reference: each method flags ≈1% (≤ 2%)', () => {
    clearMultivariateCache();
    const fit = fitMultivariate(reference, registry);
    const n = fit.X.length;
    const loo = {
      isolation_forest: fit.referenceScores.isolation_forest.filter(s => s > fit.thresholds.isolation_forest).length,
      lof: fit.referenceScores.lof.filter(s => s > fit.thresholds.lof).length,
    };
    const res = detectMultivariateAnomaliesDetailed(reference, referenceRows(), registry);
    const rowsBy = (m: string) => new Set(res.flags.filter(f => f.method === m).map(f => f.row));
    const ifRows = rowsBy('isolation_forest'), lofRows = rowsBy('lof');
    const both = [...ifRows].filter(r => lofRows.has(r)).length;
    console.log('REF ' + JSON.stringify({ n, thresholds: fit.thresholds, looFlagged: loo, inSampleFlagged: { isolation_forest: ifRows.size, lof: lofRows.size, both }, timing: { fitMs: +fit.fitMs.toFixed(1), scoreMs: +res.timing.scoreMs.toFixed(1), cached: res.timing.cached } }));
    expect(loo.isolation_forest / n).toBeLessThanOrEqual(0.02);
    expect(loo.lof / n).toBeLessThanOrEqual(0.02);
    expect(ifRows.size / n).toBeLessThanOrEqual(0.02);
    expect(lofRows.size / n).toBeLessThanOrEqual(0.02);
  });

  it('fit is cached per reference + config', () => {
    clearMultivariateCache();
    const a = fitMultivariate(reference, registry);
    expect(fitMultivariate(reference, registry)).toBe(a);
    expect(fitMultivariate(reference, registry, { k: 10 })).not.toBe(a);
  });
});
