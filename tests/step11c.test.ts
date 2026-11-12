/**
 * Step 11c Unit & Validation Tests:
 *   (1) extreme_outlier medium rate 0.05 on ascore_v1: >= 80% get INVESTIGATE_DATA in both fixed and calibrated modes, and INVESTIGATE_DRIFT <= 10%
 *   (2) mix_shift high (true drift): 100% get INVESTIGATE_DRIFT or CONSIDER_RETRAIN (never INVESTIGATE_DATA)
 *   (3) clean data 100 seeds on ascore_v1:
 *       - non-CONTINUE action rate <= 10% in both fixed & calibrated modes
 *       - covariate alarm <= 10% in both modes
 *       - concept alarm <= 5% in both modes
 *       - label alarm <= 5% in both modes
 *       - R8b triggers <= 5%
 *   (4) concept_shift high and label_shift high detection >= 90%
 *   (5) skipped anomaly types set spec.skipped = true and skipReason
 *   (6) drift detection metrics evaluate against expected drift section and record detectedCalibrated
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { getEffectiveModel, loadReferenceProfile } from '../lib/storage/repositories';
import { injectAnomaly } from '../lib/injection';
import { runMonitoring } from '../lib/monitoring';
import { runTrial } from '../lib/experiment';
import { calibrateThresholds } from '../lib/calibration';
import { evaluateTrigger } from '../lib/trigger';

describe('Step 11c — Drift Section Detection, R2 Exclusion, and Family Calibration', () => {
  let model: any;
  let cal: any;

  beforeAll(async () => {
    model = await getEffectiveModel('ascore_v1');
    const ref = await loadReferenceProfile(model.referenceDatasetId, model);
    cal = calibrateThresholds(ref, model, { sizes: [855], resamples: 1000, seed: 42 });
  });

  it('(1) extreme_outlier medium rate 0.05 on ascore_v1: >= 80% get INVESTIGATE_DATA (R2/R8b) in fixed & calibrated', async () => {
    let fixedDataCount = 0;
    let calDataCount = 0;
    let fixedDriftCount = 0;
    let calDriftCount = 0;
    const totalSeeds = 30;

    for (let seed = 1; seed <= totalSeeds; seed++) {
      const inj = injectAnomaly(model, { type: 'extreme_outlier', severity: 'medium', rate: 0.05, seed });

      // Fixed mode
      const { run: runFixed } = runMonitoring({
        model: { ...model, calibratedThresholds: cal, driftConfig: { ...model.driftConfig, thresholdMode: 'fixed' } },
        fileName: `extreme_fixed_${seed}.csv`,
        csvText: inj.csvText,
        maxValidationIssues: Infinity,
        maxStoredFlaggedRows: Infinity,
        history: [],
        recordTriggerEvent: false,
      });
      if (runFixed.trigger?.action === 'INVESTIGATE_DATA') fixedDataCount++;
      if (runFixed.trigger?.action === 'INVESTIGATE_DRIFT') fixedDriftCount++;

      // Calibrated mode
      const { run: runCal } = runMonitoring({
        model: { ...model, calibratedThresholds: cal, driftConfig: { ...model.driftConfig, thresholdMode: 'calibrated' } },
        fileName: `extreme_cal_${seed}.csv`,
        csvText: inj.csvText,
        maxValidationIssues: Infinity,
        maxStoredFlaggedRows: Infinity,
        history: [],
        recordTriggerEvent: false,
      });
      if (runCal.trigger?.action === 'INVESTIGATE_DATA') calDataCount++;
      if (runCal.trigger?.action === 'INVESTIGATE_DRIFT') calDriftCount++;
    }

    const fixedRate = fixedDataCount / totalSeeds;
    const calRate = calDataCount / totalSeeds;
    const fixedDriftRate = fixedDriftCount / totalSeeds;
    const calDriftRate = calDriftCount / totalSeeds;

    console.log(`[Test (1)] INVESTIGATE_DATA fixed: ${(fixedRate * 100).toFixed(1)}%, cal: ${(calRate * 100).toFixed(1)}% | DRIFT fixed: ${(fixedDriftRate * 100).toFixed(1)}%, cal: ${(calDriftRate * 100).toFixed(1)}%`);

    expect(fixedRate).toBeGreaterThanOrEqual(0.80);
    expect(calRate).toBeGreaterThanOrEqual(0.80);
    expect(fixedDriftRate).toBeLessThanOrEqual(0.10);
    expect(calDriftRate).toBeLessThanOrEqual(0.10);
  });

  it('(2) mix_shift high: must get INVESTIGATE_DRIFT or CONSIDER_RETRAIN (never INVESTIGATE_DATA)', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const inj = injectAnomaly(model, { type: 'mix_shift', severity: 'high', rate: 1, seed });
      const { run } = runMonitoring({
        model,
        fileName: `mix_shift_${seed}.csv`,
        csvText: inj.csvText,
        maxValidationIssues: Infinity,
        maxStoredFlaggedRows: Infinity,
        history: [],
        recordTriggerEvent: false,
      });

      expect(run.trigger?.action).not.toBe('INVESTIGATE_DATA');
      expect(['INVESTIGATE_DRIFT', 'CONSIDER_RETRAIN']).toContain(run.trigger?.action);
    }
  });

  it('(3) clean data 100 seeds on ascore_v1: covariate, concept, label, R8b, non-CONTINUE limits', async () => {
    let fixedCovAlarms = 0;
    let calCovAlarms = 0;
    let fixedConceptAlarms = 0;
    let calConceptAlarms = 0;
    let fixedLabelAlarms = 0;
    let calLabelAlarms = 0;
    let fixedNonContinue = 0;
    let calNonContinue = 0;
    let r8bAlarms = 0;
    const seeds = 100;

    for (let seed = 1; seed <= seeds; seed++) {
      const inj = injectAnomaly(model, { type: 'none', severity: 'none', rate: 0, seed });

      // Run single calibrated monitoring pass
      const { run: runCal } = runMonitoring({
        model: { ...model, calibratedThresholds: cal, driftConfig: { ...model.driftConfig, thresholdMode: 'calibrated' } },
        fileName: `clean_${seed}.csv`,
        rows: inj.rows,
        maxValidationIssues: Infinity,
        maxStoredFlaggedRows: Infinity,
        history: [],
        recordTriggerEvent: false,
      });

      if (runCal.driftReport?.covariate?.status !== 'STABLE') calCovAlarms++;
      if (runCal.driftReport?.concept?.status !== 'STABLE') calConceptAlarms++;
      if (runCal.driftReport?.label?.status !== 'STABLE') calLabelAlarms++;
      if (runCal.trigger?.action !== 'CONTINUE') calNonContinue++;

      // Fixed mode evaluation
      const runFixed = {
        ...runCal,
        driftReport: {
          ...runCal.driftReport!,
          covariate: {
            ...runCal.driftReport!.covariate,
            status: runCal.driftReport!.covariate.statusFixed,
          },
          summary: {
            ...runCal.driftReport!.summary,
            overallStatus: runCal.driftReport!.summary.statusFixed ?? runCal.driftReport!.statusFixed ?? 'STABLE',
          },
        },
      };
      const triggerFixed = evaluateTrigger(runFixed as any, {
        ...model,
        driftConfig: { ...model.driftConfig, thresholdMode: 'fixed' },
      });

      if (runFixed.driftReport?.covariate?.status !== 'STABLE') fixedCovAlarms++;
      if (runFixed.driftReport?.concept?.status !== 'STABLE') fixedConceptAlarms++;
      if (runFixed.driftReport?.label?.status !== 'STABLE') fixedLabelAlarms++;
      if (triggerFixed.action !== 'CONTINUE') fixedNonContinue++;
      if (triggerFixed.matchedRuleId === 'R8b') r8bAlarms++;
    }

    console.log(`[Test (3) Actual Rates]
  - Fixed non-CONTINUE: ${(fixedNonContinue / seeds * 100).toFixed(1)}% (limit <= 10%)
  - Calibrated non-CONTINUE: ${(calNonContinue / seeds * 100).toFixed(1)}% (limit <= 10%)
  - Fixed covariate: ${(fixedCovAlarms / seeds * 100).toFixed(1)}% (limit <= 10%)
  - Calibrated covariate: ${(calCovAlarms / seeds * 100).toFixed(1)}% (limit <= 10%)
  - Fixed concept: ${(fixedConceptAlarms / seeds * 100).toFixed(1)}% (limit <= 5%)
  - Calibrated concept: ${(calConceptAlarms / seeds * 100).toFixed(1)}% (limit <= 5%)
  - Fixed label: ${(fixedLabelAlarms / seeds * 100).toFixed(1)}% (limit <= 5%)
  - Calibrated label: ${(calLabelAlarms / seeds * 100).toFixed(1)}% (limit <= 5%)
  - R8b data quality: ${(r8bAlarms / seeds * 100).toFixed(1)}% (limit <= 5%)`);

    expect(fixedCovAlarms / seeds).toBeLessThanOrEqual(0.10);
    expect(calCovAlarms / seeds).toBeLessThanOrEqual(0.10);
    expect(fixedConceptAlarms / seeds).toBeLessThanOrEqual(0.05);
    expect(calConceptAlarms / seeds).toBeLessThanOrEqual(0.05);
    expect(fixedLabelAlarms / seeds).toBeLessThanOrEqual(0.05);
    expect(calLabelAlarms / seeds).toBeLessThanOrEqual(0.05);
    expect(fixedNonContinue / seeds).toBeLessThanOrEqual(0.10);
    expect(calNonContinue / seeds).toBeLessThanOrEqual(0.10);
    expect(r8bAlarms / seeds).toBeLessThanOrEqual(0.05);
  }, 15000);

  it('(4) concept_shift high and label_shift high detection >= 90%', async () => {
    const totalSeeds = 20;
    let conceptDetected = 0;
    let labelDetected = 0;

    for (let seed = 1; seed <= totalSeeds; seed++) {
      const injConcept = injectAnomaly(model, { type: 'concept_shift', severity: 'high', rate: 1, seed });
      const { run: runConcept } = runMonitoring({
        model,
        fileName: `concept_shift_${seed}.csv`,
        csvText: injConcept.csvText,
        history: [],
        recordTriggerEvent: false,
      });
      if (runConcept.driftReport?.concept?.status !== 'STABLE') conceptDetected++;

      const injLabel = injectAnomaly(model, { type: 'label_shift', severity: 'high', rate: 1, seed });
      const { run: runLabel } = runMonitoring({
        model,
        fileName: `label_shift_${seed}.csv`,
        csvText: injLabel.csvText,
        history: [],
        recordTriggerEvent: false,
      });
      if (runLabel.driftReport?.label?.status !== 'STABLE') labelDetected++;
    }

    const conceptRate = conceptDetected / totalSeeds;
    const labelRate = labelDetected / totalSeeds;

    console.log(`[Test (4) Detection Rates]
  - concept_shift high: ${(conceptRate * 100).toFixed(1)}% (target >= 90%)
  - label_shift high: ${(labelRate * 100).toFixed(1)}% (target >= 90%)`);

    expect(conceptRate).toBeGreaterThanOrEqual(0.90);
    expect(labelRate).toBeGreaterThanOrEqual(0.90);
  });

  it('(5) skipped anomaly types set spec.skipped = true and skipReason', async () => {
    const trial = runTrial(model, { type: 'category_shift', severity: 'medium', rate: 1, seed: 1 });
    expect(trial.spec.skipped).toBe(true);
    expect(trial.spec.skipReason).toMatch(/ไม่มีตัวแปรแบบกลุ่ม/);
  });

  it('(6) drift detection metrics evaluate against expected drift section and record detectedCalibrated', async () => {
    const trial = runTrial(model, { type: 'mix_shift', severity: 'high', rate: 1, seed: 1 });
    expect(trial.file.detected).toBe(true);
    expect(trial.file.detectedCalibrated).toBe(true);
    expect(trial.file.expectedSection).toBe('covariate');
  });
});
