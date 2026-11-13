/**
 * Step 11d Unit & Validation Tests:
 *   (1) unit_error medium, negative_value, type_error, duplicate_rows at rate 0.05 on ascore_v1:
 *       INVESTIGATE_DATA >= 95% (rule R1b triggers because validation issues/rejected rows > 1%)
 *   (2) clean data on ascore_v1: R1b triggers 0%
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { getEffectiveModel, loadReferenceProfile } from '../lib/storage/repositories';
import { injectAnomaly } from '../lib/injection';
import { runMonitoring } from '../lib/monitoring';

describe('Step 11d — Trigger Rule R1b for Validation Issues & Rejected Rows', () => {
  let model: any;

  beforeAll(async () => {
    model = await getEffectiveModel('ascore_v1');
    await loadReferenceProfile(model.referenceDatasetId, model);
  });

  const typesToTest = [
    { type: 'unit_error' as const, severity: 'medium' as const },
    { type: 'negative_value' as const, severity: 'medium' as const },
    { type: 'type_error' as const, severity: 'medium' as const },
    { type: 'duplicate_rows' as const, severity: 'medium' as const },
  ];

  for (const { type, severity } of typesToTest) {
    it(`(1) ${type} rate 0.05: INVESTIGATE_DATA >= 95% (caught by R1b)`, () => {
      let dataCount = 0;
      let r1bCount = 0;
      const totalSeeds = 30;

      for (let seed = 1; seed <= totalSeeds; seed++) {
        const inj = injectAnomaly(model, { type, severity, rate: 0.05, seed });
        const { run } = runMonitoring({
          model,
          fileName: `test_${type}_${seed}.csv`,
          csvText: inj.csvText,
          maxValidationIssues: Infinity,
          maxStoredFlaggedRows: Infinity,
          history: [],
          recordTriggerEvent: false,
        });

        if (run.trigger?.action === 'INVESTIGATE_DATA') {
          dataCount++;
        }
        if (run.trigger?.matchedRuleId === 'R1b') {
          r1bCount++;
        }
      }

      const dataRate = dataCount / totalSeeds;
      const r1bRate = r1bCount / totalSeeds;
      console.log(`[R1b Test] ${type} rate=0.05: INVESTIGATE_DATA=${(dataRate * 100).toFixed(1)}%, R1b=${(r1bRate * 100).toFixed(1)}%`);

      expect(dataRate).toBeGreaterThanOrEqual(0.95);
      expect(r1bRate).toBeGreaterThanOrEqual(0.95);
    });
  }

  it('(2) clean data: R1b triggers 0%', () => {
    let r1bCount = 0;
    const totalSeeds = 30;

    for (let seed = 1; seed <= totalSeeds; seed++) {
      const inj = injectAnomaly(model, { type: 'none', severity: 'none', rate: 0, seed });
      const { run } = runMonitoring({
        model,
        fileName: `clean_${seed}.csv`,
        csvText: inj.csvText,
        maxValidationIssues: Infinity,
        maxStoredFlaggedRows: Infinity,
        history: [],
        recordTriggerEvent: false,
      });

      if (run.trigger?.matchedRuleId === 'R1b') {
        r1bCount++;
      }
    }

    const r1bRate = r1bCount / totalSeeds;
    expect(r1bRate).toBe(0);
  });
});

