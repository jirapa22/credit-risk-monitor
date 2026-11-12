/**
 * Step 11a — New Drift Injections, Multi-Month Sequence Simulation, and AI Primary Strategy Tests.
 */
import { describe, expect, it } from 'vitest';
import { injectAnomaly, SEVERITY_TABLE } from '../lib/injection';
import { runMonitoring } from '../lib/monitoring';
import { runSequence } from '../lib/sequence';
import { getEffectiveModel, loadReferenceProfile } from '../lib/storage/repositories';
import { calibrateThresholds } from '../lib/calibration';
import { CombinedSuggestionProvider } from '../lib/suggest/combined';
import { AiSuggestionProvider } from '../lib/suggest/ai';
import { buildDatasetProfile } from '../lib/suggest/heuristic';
import type { FeatureDefinition } from '../lib/types';

describe('Step 11a — New Drift Scenarios and Multi-Month Sequence Simulation', () => {

  // ── (1) label_shift medium → label ไม่ STABLE, covariate STABLE, trigger = RECALIBRATE ──
  it('(1) label_shift medium: label section alarms, covariate STABLE, trigger = RECALIBRATE', async () => {
    const model = await getEffectiveModel('ascore_v1');
    const inj = injectAnomaly(model, {
      type: 'label_shift',
      severity: 'medium',
      rate: 1,
      seed: 42,
    });

    expect(inj.skipped).toBeFalsy();
    expect(inj.expected.section).toBe('label');
    expect(inj.expected.expectedAction).toBe('RECALIBRATE');

    const { run } = runMonitoring({
      model,
      fileName: 'label_shift_med.csv',
      csvText: inj.csvText,
      history: [],
      recordTriggerEvent: false,
    });

    // Label section should alarm (WARNING or CRITICAL)
    expect(run.driftReport!.label.status).not.toBe('STABLE');
    expect(run.driftReport!.label.status).not.toBe('NOT_AVAILABLE');

    // Covariate section must remain STABLE (features were untouched)
    expect(run.driftReport!.covariate.status).toBe('STABLE');

    // Trigger action must be RECALIBRATE (Rule R5)
    expect(run.trigger?.action).toBe('RECALIBRATE');
  });

  // ── (2) concept_shift high → concept ไม่ STABLE, label STABLE, trigger = CONSIDER_RETRAIN ──
  it('(2) concept_shift high: concept alarms, label STABLE (bad rate constant +-1%), trigger = CONSIDER_RETRAIN', async () => {
    const model = await getEffectiveModel('ascore_v1');
    const inj = injectAnomaly(model, {
      type: 'concept_shift',
      severity: 'high',
      rate: 1,
      seed: 42,
    });

    expect(inj.skipped).toBeFalsy();
    expect(inj.expected.section).toBe('concept');
    expect(inj.expected.expectedAction).toBe('CONSIDER_RETRAIN');

    const { run } = runMonitoring({
      model,
      fileName: 'concept_shift_high.csv',
      csvText: inj.csvText,
      history: [],
      recordTriggerEvent: false,
    });

    // Concept section alarms
    expect(run.driftReport!.concept.status).not.toBe('STABLE');

    // Label section must remain STABLE (bad rate constant)
    expect(run.driftReport!.label.status).toBe('STABLE');

    // Bad rate delta must be within +-1 percentage point (0.01)
    const refBadRate = run.driftReport!.label.metrics?.referenceBadRate ?? 0;
    const actBadRate = run.driftReport!.label.metrics?.actualBadRate ?? 0;
    expect(Math.abs(actBadRate - refBadRate)).toBeLessThanOrEqual(0.01);

    // Trigger action must be CONSIDER_RETRAIN (Rule R4)
    expect(run.trigger?.action).toBe('CONSIDER_RETRAIN');
  });

  // ── (3) mix_shift high → covariate ของตัวแปรนั้นไม่ STABLE ──
  it('(3) mix_shift high: covariate of targeted feature is not STABLE', async () => {
    const model = await getEffectiveModel('ascore_v1');
    const inj = injectAnomaly(model, {
      type: 'mix_shift',
      severity: 'high',
      rate: 1,
      seed: 42,
    });

    expect(inj.skipped).toBeFalsy();
    expect(inj.expected.section).toBe('covariate');

    const targetFeat = inj.spec.targetFeatures[0];
    expect(targetFeat).toBeDefined();

    const { run } = runMonitoring({
      model,
      fileName: 'mix_shift_high.csv',
      csvText: inj.csvText,
      history: [],
      recordTriggerEvent: false,
    });

    // Covariate of targeted feature must not be STABLE
    const featRep = run.driftReport!.covariate.metrics.features[targetFeat];
    expect(featRep).toBeDefined();
    expect(featRep.status).not.toBe('STABLE');
    expect(run.driftReport!.covariate.status).not.toBe('STABLE');
  });

  // ── (4) missing_drift high → missing ไม่ STABLE ──
  it('(4) missing_drift high: missing section alarms on model with imputable feature', async () => {
    const baseModel = await getEffectiveModel('ascore_v1');

    // Create a model clone where monthly_income has fillMedian missingStrategy
    const modelWithImputable: any = {
      ...baseModel,
      id: 'ascore_v1_imputable_test',
      featureRegistry: {
        ...baseModel.featureRegistry,
        monthly_income: {
          ...baseModel.featureRegistry.monthly_income,
          required: false,
          validation: {
            ...baseModel.featureRegistry.monthly_income?.validation,
            allowNull: true,
            missingStrategy: 'fillMedian',
          },
        },
      },
    };

    const inj = injectAnomaly(modelWithImputable, {
      type: 'missing_drift',
      severity: 'high',
      rate: 1,
      seed: 42,
    });

    expect(inj.skipped).toBeFalsy();
    expect(inj.expected.section).toBe('missing');

    const { run } = runMonitoring({
      model: modelWithImputable,
      fileName: 'missing_drift_high.csv',
      csvText: inj.csvText,
      history: [],
      recordTriggerEvent: false,
    });

    // Missing section alarms
    expect(run.driftReport!.missing.status).not.toBe('STABLE');
    const missFeat = run.driftReport!.missing.metrics?.features?.monthly_income;
    expect(missFeat).toBeDefined();
    expect(missFeat!.status).not.toBe('STABLE');
  });

  // ── (5) sequence sudden mean_shift −20% เริ่มเดือน 6 → กฎ persistence ──
  it('(5) sequence sudden mean_shift -20% starting month 6: no alarm before month 6, alarms month 6/7, CONSIDER_RETRAIN on 2nd alarm', async () => {
    const baseModel = await getEffectiveModel('ascore_v1');

    // บันทึกข้อจำกัดของเกณฑ์อุตสาหกรรม: CSI ไม่ไวต่อ drift ระดับนี้
    const fixedResult = await runSequence(baseModel, {
      type: 'mean_shift',
      pattern: 'sudden',
      startMonth: 6,
      endMagnitude: -0.10,
      seed: 42,
      monthsCount: 12,
    });
    expect(fixedResult.months[5].covariateStatus).toBe('STABLE');

    // Sensitivity assertion in calibrated mode
    const refProfile = await loadReferenceProfile(baseModel.referenceDatasetId, baseModel);
    const cal = calibrateThresholds(refProfile, baseModel, { sizes: [855], resamples: 200, seed: 42 });
    const calModel = {
      ...baseModel,
      driftConfig: { ...baseModel.driftConfig, thresholdMode: 'calibrated' },
      calibratedThresholds: cal,
    };

    const result = await runSequence(calModel, {
      type: 'mean_shift',
      pattern: 'sudden',
      startMonth: 6,
      endMagnitude: -0.20,
      seed: 42,
      monthsCount: 12,
    });

    const { summary, months } = result;

    // No false alarm before month 6
    expect(summary.falseAlarmsBeforeStart).toBe(0);
    for (let m = 1; m <= 5; m++) {
      expect(months[m - 1].overallStatus).toBe('STABLE');
      expect(months[m - 1].triggerAction).toBe('CONTINUE');
    }

    // Alarms in month 6 or 7
    expect(summary.firstAlarmMonth).toBeGreaterThanOrEqual(6);
    expect(summary.firstAlarmMonth).toBeLessThanOrEqual(7);

    // In month 6, trigger action is NOT CONSIDER_RETRAIN (only 1st run of critical drift)
    const m6 = months[5];
    expect(m6.triggerAction).not.toBe('CONSIDER_RETRAIN');

    // In month 7 (2nd consecutive critical run), persistence rule R6 triggers CONSIDER_RETRAIN
    const m7 = months[6];
    expect(m7.triggerAction).toBe('CONSIDER_RETRAIN');
    expect(summary.firstRetrainMonth).toBe(7);
  });

  // ── (6) sequence gradual: รายงาน detection delay ตามจริง ──
  it('(6) sequence gradual: executes cleanly and reports actual detection delay', async () => {
    const result = await runSequence('ascore_v1', {
      type: 'mean_shift',
      pattern: 'gradual',
      startMonth: 6,
      endMagnitude: -0.20,
      seed: 42,
      monthsCount: 12,
    });

    expect(result.summary.falseAlarmsBeforeStart).toBe(0);
    // Detection delay reported as a number (or null if subtle)
    expect(result.summary.firstAlarmMonth).toBeDefined();
    if (result.summary.firstAlarmMonth !== null) {
      expect(result.summary.detectionDelay).toBe(result.summary.firstAlarmMonth - 6);
    }
    expect(result.months.length).toBe(12);
  });

  // ── (7) ทุกชนิดใหม่ทำงานกับโมเดลปลอม (score_column) และข้ามพร้อมเหตุผลเมื่อทำไม่ได้ ──
  it('(7) new types work with model without scorecard (score_column), and skip gracefully when preconditions are missing', async () => {
    // Model with label and scoreColumn
    const fakeModel: any = {
      id: 'fake_model_step11',
      referenceDatasetId: 'ascore_v1_dev855',
      dateColumn: 'application_date',
      idColumn: 'customer_id',
      labelColumn: 'default_flag',
      scoreColumn: 'monthly_income', // uses income as score proxy
      featureRegistry: {
        loan_amount: {
          columnName: 'loan_amount',
          dataType: 'numeric',
          monitoringEnabled: true,
          validation: { minValue: 0, maxValue: 1000000 },
        },
      },
    };

    // label_shift works
    const injLabel = injectAnomaly(fakeModel, { type: 'label_shift', severity: 'medium', rate: 1 });
    expect(injLabel.skipped).toBeFalsy();

    // concept_shift works
    const injConcept = injectAnomaly(fakeModel, { type: 'concept_shift', severity: 'medium', rate: 1 });
    expect(injConcept.skipped).toBeFalsy();

    // missing_drift skips with clear Thai reason because no feature has imputable strategy
    const injMiss = injectAnomaly(fakeModel, { type: 'missing_drift', severity: 'medium', rate: 1 });
    expect(injMiss.skipped).toBe(true);
    expect(injMiss.skipReason).toContain('ไม่มีตัวแปรที่ missingStrategy เป็นแบบเติมค่า');

    // Model without label column -> label_shift skips with clear reason
    const noLabelModel: any = {
      ...fakeModel,
      labelColumn: undefined,
    };
    const injNoLabel = injectAnomaly(noLabelModel, { type: 'label_shift', severity: 'medium', rate: 1 });
    expect(injNoLabel.skipped).toBe(true);
    expect(injNoLabel.skipReason).toContain('ไม่มีคอลัมน์ label หรือไม่มีข้อมูล label');
  });

  // ── AI Primary Combined Strategy Test ──
  it('combinedStrategy ai_primary prioritizes AI suggestion on disagreement and keeps heuristic as second opinion', async () => {
    const mockProfile = buildDatasetProfile('test_ref', [
      { id: '1', amt: 500 },
    ], ['id', 'amt']);

    const mockAiClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              name: 'provide_column_suggestions',
              input: {
                suggestions: [
                  { column: 'id', role: 'id', type: 'string', confidence: 0.90, reason: 'AI id' },
                  // Disagreement: AI says score, heuristic says feature
                  { column: 'amt', role: 'score', type: 'numeric', confidence: 0.70, reason: 'AI says score' },
                ],
              },
            },
          ],
        }),
      },
    };

    const aiProvider = new AiSuggestionProvider({ client: mockAiClient as any });

    // 1. ai_primary strategy (default)
    const combinedAiPrimary = new CombinedSuggestionProvider(aiProvider, { strategy: 'ai_primary' });
    const suggestionsAiPrimary = await combinedAiPrimary.suggestColumns(mockProfile);
    const amtSug1 = suggestionsAiPrimary.find(s => s.column === 'amt')!;
    expect(amtSug1.agreement).toBe('disagree');
    expect(amtSug1.role).toBe('score'); // AI role chosen even if confidence (0.70) is lower than heuristic (0.80+)
    expect(amtSug1.reason).toContain('ความเห็นที่สอง');
    expect(amtSug1.heuristicProposal).toBeDefined();

    // 2. confidence strategy (legacy)
    const combinedConfidence = new CombinedSuggestionProvider(aiProvider, { strategy: 'confidence' });
    const suggestionsConf = await combinedConfidence.suggestColumns(mockProfile);
    const amtSug2 = suggestionsConf.find(s => s.column === 'amt')!;
    expect(amtSug2.agreement).toBe('disagree');
    // Heuristic confidence for amt is 0.85 > AI 0.70, so heuristic role 'feature' wins under confidence strategy
    expect(amtSug2.role).toBe('feature');
  });
});
