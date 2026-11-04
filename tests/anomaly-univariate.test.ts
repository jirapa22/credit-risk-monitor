import { describe, expect, it } from 'vitest';
import { getReferenceProfile } from '../lib/reference';
import { detectUnivariateAnomaliesDetailed, detectUnivariateAnomalies, univariateFeatures, type CrossFieldRule } from '../lib/anomaly/univariate';
import type { CleanRow } from '../lib/validation';
import type { FeatureDefinition } from '../lib/types';
import modelConfig from '../app/model-config.json';

const model = (modelConfig as any).models.ascore_v1;
const registry = model.featureRegistry as Record<string, FeatureDefinition>;
const reference = getReferenceProfile(model.referenceDatasetId, model.scoring);
const features = univariateFeatures(registry);
const rules: CrossFieldRule[] = [{ numerator: 'loan_amount', denominator: 'monthly_income', op: '>', threshold: 20, label: 'วงเงินกู้ต่อรายได้' }];

const row = (n: number, values: Record<string, number>): CleanRow => ({ row: n, id: `C${n}`, date: null, values, label: null, imputed: [] });
/** A "typical" row: median of each feature in the reference. */
const medianRow = (n: number) => {
  const v: Record<string, number> = {};
  for (const f of features) { const s = [...reference.features[f]].sort((a, b) => a - b); v[f] = s[Math.floor(s.length / 2)]; }
  return row(n, v);
};
const referenceRows = (): CleanRow[] =>
  reference.labels.map((_, i) => row(i + 1, Object.fromEntries(features.map(f => [f, reference.features[f][i]]))));

describe('layer 3 — univariate anomalies (reference-based)', () => {
  it('uses registry numeric features, excluding default_flag', () => {
    expect(features.length).toBeGreaterThan(0);
    expect(features).not.toContain('default_flag');
  });

  it('(1) a typical row is not flagged', () => {
    expect(detectUnivariateAnomalies(reference, [medianRow(1)], registry, { crossFieldRules: rules })).toEqual([]);
  });

  it('(2) monthly_income = 28,000,000 is flagged by both iqr and mad', () => {
    const r = medianRow(7); r.values.monthly_income = 28_000_000;
    const flags = detectUnivariateAnomalies(reference, [r], registry).filter(f => f.feature === 'monthly_income');
    expect(flags.map(f => f.method).sort()).toEqual(['iqr', 'mad']);
    expect(flags.every(f => f.row === 7 && f.reason.length > 0)).toBe(true);
  });

  it('(3) loan_amount 30× income triggers cross_field', () => {
    const r = medianRow(3); r.values.loan_amount = r.values.monthly_income * 30;
    const cf = detectUnivariateAnomalies(reference, [r], registry, { crossFieldRules: rules }).filter(f => f.method === 'cross_field');
    expect(cf).toHaveLength(1);
    expect(cf[0].value).toBeCloseTo(30);
    expect(cf[0].feature).toBe('loan_amount/monthly_income');
  });

  it('(4) the reference itself: mad flags ≲ 5% of rows', () => {
    const rows = referenceRows();
    const { flags, warnings } = detectUnivariateAnomaliesDetailed(reference, rows, registry, { crossFieldRules: rules });
    const rowsBy = (m: string) => new Set(flags.filter(f => f.method === m).map(f => f.row)).size;
    const summary = { total: rows.length, iqr: rowsBy('iqr'), mad: rowsBy('mad'), cross_field: rowsBy('cross_field'), warnings };
    console.log('[reference flag summary]', JSON.stringify(summary));
    expect(summary.mad / rows.length).toBeLessThanOrEqual(0.05);
  });

  it('(5) monthly_income = 25 (wrong unit) is flagged by iqr on the low side', () => {
    const r = medianRow(5); r.values.monthly_income = 25;
    const iqr = detectUnivariateAnomalies(reference, [r], registry).filter(f => f.method === 'iqr' && f.feature === 'monthly_income');
    expect(iqr).toHaveLength(1);
    expect(iqr[0].value).toBe(25);
    expect(iqr[0].reason).toContain('ต่ำกว่า');
    expect(iqr[0].reason).toContain('log scale');
  });

  it('uses registry transforms and stores original-unit fences', () => {
    const { stats } = detectUnivariateAnomaliesDetailed(reference, [], registry);
    expect(stats.monthly_income.transform).toBe('log1p');
    expect(stats.dti_ratio.transform).toBe('none');
    expect(stats.monthly_income.upperFenceOriginal).toBeCloseTo(Math.expm1(stats.monthly_income.upperFence));
    expect(stats.dti_ratio.upperFenceOriginal).toBe(stats.dti_ratio.upperFence);
  });

  it('negative value on a log1p feature is flagged without computing log', () => {
    const r = medianRow(9); r.values.loan_amount = -100;
    const f = detectUnivariateAnomalies(reference, [r], registry).filter(x => x.feature === 'loan_amount');
    expect(f.map(x => x.method).sort()).toEqual(['iqr', 'mad']);
    expect(f.every(x => x.value === -100 && x.reason.includes('ติดลบ'))).toBe(true);
  });

  it('report: none vs log1p on the reference', () => {
    const rows = referenceRows();
    const none = Object.fromEntries(features.map(f => [f, 'none' as const]));
    const out: Record<string, unknown> = {};
    for (const [label, override] of [['none', none], ['registry', {}]] as const) {
      const { flags, stats } = detectUnivariateAnomaliesDetailed(reference, rows, registry, { crossFieldRules: rules, transformOverride: override });
      const uniq = (pred: (f: typeof flags[number]) => boolean) => new Set(flags.filter(pred).map(f => f.row)).size;
      out[label] = {
        iqr: uniq(f => f.method === 'iqr'), mad: uniq(f => f.method === 'mad'), cross_field: uniq(f => f.method === 'cross_field'),
        perFeature: Object.fromEntries(features.map(k => [k, { iqr: uniq(f => f.method === 'iqr' && f.feature === k), mad: uniq(f => f.method === 'mad' && f.feature === k), fence: [stats[k].lowerFenceOriginal, stats[k].upperFenceOriginal] }])),
      };
    }
    console.log('REPORT ' + JSON.stringify(out));
  });

  it('skips a feature with MAD = 0 and warns', () => {
    const constRef = { ...reference, features: { ...reference.features, dti_ratio: reference.features.dti_ratio.map(() => 0.3) } };
    const r = medianRow(1); r.values.dti_ratio = 0.9;
    const { flags, warnings } = detectUnivariateAnomaliesDetailed(constRef, [r], registry, { methods: ['mad'] });
    expect(flags).toEqual([]);
    expect(warnings.some(w => w.includes('MAD'))).toBe(true);
  });

  it('k and z threshold are configurable', () => {
    const rows = referenceRows();
    const loose = detectUnivariateAnomalies(reference, rows, registry, { iqrK: 3, madThreshold: 10 });
    const strict = detectUnivariateAnomalies(reference, rows, registry, { iqrK: 1.5, madThreshold: 3.5 });
    expect(loose.length).toBeLessThanOrEqual(strict.length);
  });
});
