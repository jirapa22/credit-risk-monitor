/**
 * Step 9 — Trigger & Recommended Actions tests (tests/trigger.test.ts):
 *   (1) Clean bootstrap → CONTINUE or MONITOR_CLOSELY
 *   (2) schema_break → BLOCKED_INVALID_DATA (R1)
 *   (3) unit_error low rate 0.20 → INVESTIGATE_DATA (R2)
 *   (4) mean_shift high → INVESTIGATE_DRIFT (R7); 2nd consecutive run in history → CONSIDER_RETRAIN (R6)
 *   (5) label shift (~9% → ~18%) → RECALIBRATE (R5)
 *   (6) concept drift (permute labels so Gini ≈ 0) → CONSIDER_RETRAIN (R4)
 *   (7) custom triggerConfig override (covariate ≥ WARNING → CONSIDER_RETRAIN)
 *   (8) invalid triggerConfig (duplicate rule id) → falls back to DEFAULT_TRIGGER_RULES with warning
 *   (9) second fake model (no label column) → evaluateTrigger works, label/concept rules do not match
 *  (10) review API (GET /api/triggers + POST /api/triggers/[eventId]/review) → REVIEWED + 409 on duplicate review
 */
import { describe, it, expect, beforeEach } from 'vitest';
import modelConfig from '../app/model-config.json';
import { getReferenceProfile, getReferenceRows, registerReferenceDataset } from '../lib/reference';
import { injectAnomaly } from '../lib/injection';
import { runMonitoring } from '../lib/monitoring';
import { evaluateTrigger, resolveTriggerRules } from '../lib/trigger';
import { calibrateThresholds } from '../lib/calibration';
import { mulberry32 } from '../lib/random';
import { createMemoryStore, setStore } from '../lib/storage/store';
import { GET as getTriggersRoute } from '../app/api/triggers/route';
import { POST as reviewTriggerRoute } from '../app/api/triggers/[eventId]/review/route';
import type { FeatureDefinition, ScoringConfig, TriggerDecision } from '../lib/types';

const baseModel = (modelConfig as any).models.ascore_v1;
const refData = getReferenceRows(baseModel.referenceDatasetId);
const refProfile = getReferenceProfile(baseModel.referenceDatasetId, baseModel.scoring as ScoringConfig, {
  labelColumn: baseModel.labelColumn,
  scoreColumn: baseModel.scoreColumn,
});

interface SummaryRow {
  test: string;
  action: string;
  matchedRuleId: string;
  severity: string;
  reason: string;
}

const reportRows: SummaryRow[] = [];

function recordRow(test: string, d: TriggerDecision) {
  reportRows.push({
    test,
    action: d.action,
    matchedRuleId: d.matchedRuleId,
    severity: d.severity,
    reason: d.reasons.join(' | '),
  });
}

describe('Step 9 — Trigger Rules & Review Workflow (tests/trigger.test.ts)', () => {
  beforeEach(() => {
    setStore(createMemoryStore());
  });

  it('(1) bootstrap สะอาด → CONTINUE หรือ MONITOR_CLOSELY', () => {
    const inj = injectAnomaly(baseModel, { type: 'none', seed: 101 });
    const { run } = runMonitoring({
      model: baseModel,
      fileName: 'clean_bootstrap.csv',
      csvText: inj.csvText,
      history: [],
    });
    const decision = run.trigger!;
    recordRow('(1) clean bootstrap', decision);

    expect(decision).toBeDefined();
    expect(['CONTINUE', 'MONITOR_CLOSELY']).toContain(decision.action);
    expect(['R8', 'R9']).toContain(decision.matchedRuleId);
  });

  it('(2) schema_break → BLOCKED_INVALID_DATA', () => {
    const inj = injectAnomaly(baseModel, { type: 'schema_break', severity: 'medium', seed: 42 });
    const { run } = runMonitoring({
      model: baseModel,
      fileName: 'schema_break.csv',
      csvText: inj.csvText,
      history: [],
    });
    const decision = run.trigger!;
    recordRow('(2) schema_break', decision);

    expect(decision.action).toBe('BLOCKED_INVALID_DATA');
    expect(decision.matchedRuleId).toBe('R1');
    expect(decision.severity).toBe('critical');
  });

  it('(3) unit_error low rate 0.20 → INVESTIGATE_DATA', () => {
    const inj = injectAnomaly(baseModel, {
      type: 'unit_error',
      severity: 'low',
      rate: 0.20,
      seed: 42,
    });
    const { run } = runMonitoring({
      model: baseModel,
      fileName: 'unit_error_low_20pct.csv',
      csvText: inj.csvText,
      history: [],
    });
    const decision = run.trigger!;
    recordRow('(3) unit_error low 0.20', decision);

    console.log('\n[Test (3) Diagnostic]', {
      action: decision.action,
      matchedRuleId: decision.matchedRuleId,
      officialDrift: run.drift?.overallStatus,
      officialPsi: run.drift?.psi.value,
      driftExcludingFlagged: run.driftExcludingFlagged?.overallStatus,
      exclPsi: run.driftExcludingFlagged?.psi.value,
      flaggedPct: run.anomaly?.flaggedPct,
      refFlaggedCount: run.anomaly?.referenceFlaggedCount,
      reasons: decision.reasons,
    });

    expect(decision.action).toBe('INVESTIGATE_DATA');
    expect(['R1b', 'R2']).toContain(decision.matchedRuleId);
  });

  it('(4) mean_shift high → INVESTIGATE_DRIFT และเมื่อรันซ้ำครั้งที่ 2 (มีครั้งแรกใน history) → CONSIDER_RETRAIN', () => {
    const inj1 = injectAnomaly(baseModel, {
      type: 'mean_shift',
      severity: 'high',
      seed: 42,
    });
    const { run: run1 } = runMonitoring({
      model: baseModel,
      fileName: 'mean_shift_high_run1.csv',
      csvText: inj1.csvText,
      history: [],
    });
    const decision1 = run1.trigger!;
    recordRow('(4a) mean_shift high (run 1)', decision1);

    expect(decision1.action).toBe('INVESTIGATE_DRIFT');
    expect(decision1.matchedRuleId).toBe('R7');

    // Second consecutive run with run1 in history
    const inj2 = injectAnomaly(baseModel, {
      type: 'mean_shift',
      severity: 'high',
      seed: 43,
    });
    const { run: run2 } = runMonitoring({
      model: baseModel,
      fileName: 'mean_shift_high_run2.csv',
      csvText: inj2.csvText,
      history: [run1],
    });
    const decision2 = run2.trigger!;
    recordRow('(4b) mean_shift high (run 2 w/ history)', decision2);

    expect(decision2.action).toBe('CONSIDER_RETRAIN');
    expect(decision2.matchedRuleId).toBe('R6');
  });

  it('(5) label shift (bad rate ~9% → ~18%) → RECALIBRATE', () => {
    // Flip Good -> Bad on the riskiest (lowest A-Score) Good applicants so bad rate doubles (~9.36% -> ~18.01%)
    // while the scorecard's rank-ordering power (Gini) remains intact.
    const refRowsCopy = refData.rows.map(r => ({ ...r }));
    const targetBads = Math.round(refRowsCopy.length * 0.18);
    let currentBads = refRowsCopy.filter(r => Number(r.default_flag) === 1).length;

    const goodIndicesByRisk = refRowsCopy
      .map((r, i) => ({ i, score: refProfile.scores[i], label: Number(r.default_flag) }))
      .filter(x => x.label === 0)
      .sort((a, b) => a.score - b.score);

    for (const item of goodIndicesByRisk) {
      if (currentBads >= targetBads) break;
      refRowsCopy[item.i].default_flag = 1;
      currentBads++;
    }

    const { run } = runMonitoring({
      model: baseModel,
      fileName: 'label_shift_18pct.csv',
      rows: refRowsCopy,
      history: [],
    });
    const decision = run.trigger!;
    recordRow('(5) label shift (~9% -> ~18%)', decision);

    expect(run.driftReport?.label.status).toBe('CRITICAL');
    expect(run.driftReport?.concept.status).toBe('STABLE');
    expect(decision.action).toBe('RECALIBRATE');
    expect(decision.matchedRuleId).toBe('R5');
  });

  it('(6) concept drift: สลับ label แบบสุ่มทั้งไฟล์ (permute) ให้ Gini ใกล้ 0 → CONSIDER_RETRAIN', () => {
    const rnd = mulberry32(12345);
    const permutedRows = refData.rows.map(r => ({ ...r }));
    const labels = permutedRows.map(r => r.default_flag);
    for (let i = labels.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [labels[i], labels[j]] = [labels[j], labels[i]];
    }
    permutedRows.forEach((r, i) => {
      r.default_flag = labels[i];
    });

    const { run } = runMonitoring({
      model: baseModel,
      fileName: 'concept_drift_permuted_labels.csv',
      rows: permutedRows,
      history: [],
    });
    const decision = run.trigger!;
    recordRow('(6) concept drift (permuted labels)', decision);

    const actualGini = run.driftReport?.concept.metrics?.performance.actual?.gini ?? 1;
    expect(Math.abs(actualGini)).toBeLessThan(0.10);
    expect(run.driftReport?.concept.status).toBe('CRITICAL');
    expect(decision.action).toBe('CONSIDER_RETRAIN');
    expect(decision.matchedRuleId).toBe('R4');
  });

  it('(7) config ที่ทับกฎ: ตั้งกฎใหม่ให้ covariate ≥ WARNING → CONSIDER_RETRAIN ทันที ผลต้องเปลี่ยนตาม', () => {
    const inj = injectAnomaly(baseModel, {
      type: 'mean_shift',
      severity: 'low',
      seed: 42,
    });
    // In fixed mode (CSI only), mean_shift -10% does not exceed CSI 0.10
    const { run: defaultRun } = runMonitoring({
      model: baseModel,
      fileName: 'custom_rule_test_fixed.csv',
      csvText: inj.csvText,
      history: [],
    });

    // บันทึกข้อจำกัดของเกณฑ์อุตสาหกรรม: CSI ไม่ไวต่อ drift ระดับนี้
    expect(defaultRun.driftReport?.covariate.status).toBe('STABLE');
    expect(defaultRun.trigger?.action).toBe('CONTINUE');

    // Run sensitivity assertion under calibrated mode (which uses null distribution including KS/Wasserstein)
    const cal = calibrateThresholds(refProfile, baseModel, { sizes: [855], resamples: 200, seed: 42 });
    const calModel = {
      ...baseModel,
      driftConfig: { ...baseModel.driftConfig, thresholdMode: 'calibrated' },
      calibratedThresholds: cal,
    };
    const { run: calRun } = runMonitoring({
      model: calModel,
      fileName: 'custom_rule_test_cal.csv',
      csvText: inj.csvText,
      history: [],
    });
    expect(calRun.driftReport?.covariate.status).not.toBe('STABLE');

    const customModel = {
      ...structuredClone(calModel),
      triggerConfig: {
        rules: [
          {
            id: 'CUSTOM_COV_WARN',
            priority: 1,
            when: [{ type: 'sectionStatus', section: 'covariate', atLeast: 'WARNING' }],
            action: 'CONSIDER_RETRAIN',
            severity: 'critical',
            message: 'กฎพิเศษ: พบ Covariate Drift ตั้งแต่ระดับ WARNING ขึ้นไป ให้พิจารณา Retrain ทันที',
            recommendedSteps: ['สั่ง Retrain ทันทีตามนโยบายเข้มงวด'],
          },
          {
            id: 'CUSTOM_FALLBACK',
            priority: 2,
            when: [],
            action: 'CONTINUE',
            severity: 'info',
            message: 'ปกติ',
            recommendedSteps: ['ใช้งานต่อ'],
          },
        ],
      },
    };

    const customDecision = evaluateTrigger(calRun, customModel, []);
    recordRow('(7) custom rule override', customDecision);

    expect(calRun.trigger!.action).not.toBe('CONSIDER_RETRAIN');
    expect(customDecision.action).toBe('CONSIDER_RETRAIN');
    expect(customDecision.matchedRuleId).toBe('CUSTOM_COV_WARN');
  });

  it('(8) config ผิด (rule id ซ้ำ) → ใช้กฎเริ่มต้นและได้ warning', () => {
    const badModel = {
      ...structuredClone(baseModel),
      triggerConfig: {
        rules: [
          {
            id: 'DUP_ID',
            priority: 1,
            when: [{ type: 'validationBlocked' }],
            action: 'BLOCKED_INVALID_DATA',
            severity: 'critical',
            message: 'กฎ 1',
            recommendedSteps: ['ขั้น 1'],
          },
          {
            id: 'DUP_ID',
            priority: 2,
            when: [],
            action: 'CONTINUE',
            severity: 'info',
            message: 'กฎ 2',
            recommendedSteps: ['ขั้น 2'],
          },
        ],
      },
    };

    const resolved = resolveTriggerRules(badModel);
    expect(resolved.warnings.length).toBeGreaterThan(0);
    expect(resolved.warnings[0]).toContain('DUP_ID');
    expect(resolved.rules.map(r => r.id)).toEqual(['R1', 'R1b', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8b', 'R8', 'R9']);

    const inj = injectAnomaly(baseModel, { type: 'none', seed: 101 });
    const { run } = runMonitoring({
      model: badModel,
      fileName: 'dup_rule_test.csv',
      csvText: inj.csvText,
      history: [],
    });
    const decision = run.trigger!;
    recordRow('(8) invalid config (duplicate rule id)', decision);

    expect(decision.configWarnings).toBeDefined();
    expect(decision.configWarnings!.length).toBeGreaterThan(0);
    expect(['CONTINUE', 'MONITOR_CLOSELY']).toContain(decision.action);
  });

  it('(9) โมเดลปลอมตัวที่สอง (ไม่มี label): evaluateTrigger ทำงานได้ และกฎที่ต้องใช้ label ไม่ match', () => {
    const fakeRefId = 'fake_trigger_model_ref';
    const fakeRefRows: Record<string, string | number>[] = Array.from({ length: 200 }, (_, i) => ({
      acct_id: `A_${i + 1}`,
      age: 25 + (i % 35),
      salary: 20000 + (i * 400) % 50000,
      utilization: +(((i * 5) % 90) / 100).toFixed(2),
    }));

    registerReferenceDataset(
      {
        referenceId: fakeRefId,
        version: '1.0.0',
        modelId: 'fake_trigger_model',
        description: 'Second fake model without label column',
        source: 'unit-test',
        createdAt: '2026-01-01T00:00:00Z',
        rowCount: fakeRefRows.length,
        badCount: 0,
        badRate: 0,
        periodStart: '',
        periodEnd: '',
        columns: ['acct_id', 'age', 'salary', 'utilization'],
        sha256: 'fake_trigger_sha',
      },
      fakeRefRows,
    );

    const fakeRegistry: Record<string, FeatureDefinition> = {
      age: { columnName: 'age', displayName: 'Age', dataType: 'numeric', required: true, monitoringEnabled: true },
      salary: { columnName: 'salary', displayName: 'Salary', dataType: 'numeric', required: true, monitoringEnabled: true, anomalyTransform: 'log1p' },
      utilization: { columnName: 'utilization', displayName: 'Utilization', dataType: 'numeric', required: true, monitoringEnabled: true },
    };

    const fakeModel = {
      id: 'fake_trigger_model',
      name: 'Fake Trigger Model V2',
      configVersion: '1.0.0',
      referenceDatasetId: fakeRefId,
      idColumn: 'acct_id',
      dateColumn: null,
      labelColumn: 'is_bad',
      featureRegistry: fakeRegistry,
      scoring: { base_points: 0, factor: 1, offset: 0, features: ['age', 'salary', 'utilization'], scorecard: {} },
      thresholds: { psi_warning: 0.10, psi_critical: 0.25, gini_min: 0.10, auc_min: 0.55, ks_min: 0.10, csi_features: {} },
    };

    const { run } = runMonitoring({
      model: fakeModel,
      fileName: 'fake_model_clean.csv',
      rows: fakeRefRows,
      anomalyScreening: false,
      history: [],
    });
    const decision = run.trigger!;
    recordRow('(9) second fake model (no label)', decision);

    expect(run.driftReport?.label.status).toBe('NOT_AVAILABLE');
    expect(run.driftReport?.concept.status).toBe('NOT_AVAILABLE');
    expect(decision.action).toBe('CONTINUE');
    expect(decision.matchedRuleId).toBe('R9');
    expect(['R4', 'R5']).not.toContain(decision.matchedRuleId);

    console.log('\n[Step 9 Summary Table — Tests 1 to 9]');
    console.table(
      reportRows.map(r => ({
        test: r.test,
        action: r.action,
        matchedRuleId: r.matchedRuleId,
        severity: r.severity,
        reason: r.reason.slice(0, 110),
      })),
    );
  });

  it('(10) review API: รีวิวแล้ว status ต้องเปลี่ยนเป็น REVIEWED และรีวิวซ้ำต้องได้ error 409', async () => {
    const inj = injectAnomaly(baseModel, { type: 'mean_shift', severity: 'high', seed: 42 });
    const { run } = runMonitoring({
      model: baseModel,
      fileName: 'mean_shift_for_review.csv',
      csvText: inj.csvText,
      history: [],
    });
    expect(run.trigger?.action).toBe('INVESTIGATE_DRIFT');

    // 1. GET /api/triggers?modelId=ascore_v1&status=OPEN
    const getRes1 = await getTriggersRoute(
      new Request('http://localhost/api/triggers?modelId=ascore_v1&status=OPEN'),
    );
    expect(getRes1.status).toBe(200);
    const body1 = await getRes1.json();
    expect(body1.events.length).toBe(1);
    const eventId: string = body1.events[0].eventId;
    expect(body1.events[0].status).toBe('OPEN');

    // 2. POST /api/triggers/[eventId]/review
    const postRes1 = await reviewTriggerRoute(
      new Request(`http://localhost/api/triggers/${eventId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'ACCEPTED',
          note: 'ตรวจสอบแล้วเกิดจากแคมเปญลูกค้ากลุ่มใหม่',
          reviewer: 'risk_analyst_01',
        }),
      }),
      { params: Promise.resolve({ eventId }) },
    );
    expect(postRes1.status).toBe(200);
    const revBody1 = await postRes1.json();
    expect(revBody1.event.status).toBe('REVIEWED');
    expect(revBody1.event.review.decision).toBe('ACCEPTED');
    expect(revBody1.event.review.reviewer).toBe('risk_analyst_01');
    expect(typeof revBody1.event.review.reviewedAt).toBe('string');

    // 3. Duplicate review on the same eventId must return 409 Conflict
    const postRes2 = await reviewTriggerRoute(
      new Request(`http://localhost/api/triggers/${eventId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'DISMISSED',
          note: 'พยายามรีวิวซ้ำ',
          reviewer: 'risk_analyst_02',
        }),
      }),
      { params: Promise.resolve({ eventId }) },
    );
    expect(postRes2.status).toBe(409);
  });
});

