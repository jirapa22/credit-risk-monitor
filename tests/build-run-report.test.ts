import { describe, expect, it } from 'vitest';
import { buildRunReport } from '../lib/report/buildRunReport';
import type { MonitoringRun, BaselineVersion } from '../lib/types';
import {
  DEFAULT_PSI_WARNING,
  DEFAULT_PSI_CRITICAL,
  DEFAULT_AUC_MIN,
  DEFAULT_GINI_MIN,
  DEFAULT_KS_MIN,
} from '../lib/defaults';

describe('buildRunReport pure view-model builder (Step 13)', () => {
  it('1. builds accurate report for a normal run (clean drift, PSI, CSI, labels, trigger)', () => {
    const normalRun: MonitoringRun = {
      runId: 'run_normal_001',
      kind: 'monitoring',
      createdAt: '2025-07-15T10:30:00.000Z',
      model: {
        modelId: 'test_model',
        configVersion: '1.0.0',
      },
      modelName: 'Personal Loan Model v1',
      referenceId: 'ref_dev_01',
      fileName: 'm01_clean_2025-07.csv',
      thresholdsSnapshot: {
        psi_warning: 0.10,
        psi_critical: 0.25,
        auc_min: 0.60,
        gini_min: 0.20,
        ks_min: 0.15,
        csi_features: {
          feature_x: { threshold: 0.12, bins: [] },
          feature_y: { threshold: 0.10, bins: [] },
        },
      },
      validation: {
        ok: true,
        totalRows: 1000,
        validRows: 980,
        rejectedRows: 20,
        rejectedPct: 2.0,
        warningRows: 15,
        issues: [
          { type: 'OUT_OF_RANGE', severity: 'warning', column: 'feature_x', message: 'test warning' },
        ],
        blockingErrors: [],
        warnings: [],
        groups: [],
      },
      drift: {
        referenceId: 'ref_dev_01',
        psi: { value: 0.0452, status: 'STABLE', threshold: { warning: 0.10, critical: 0.25 }, bins: [] },
        csi: {
          feature_x: { value: 0.0321, status: 'STABLE', threshold: { warning: 0.12, critical: 0.25 }, bins: [], displayName: 'Feature X' },
          feature_y: { value: 0.0894, status: 'STABLE', threshold: { warning: 0.10, critical: 0.25 }, bins: [], displayName: 'Feature Y' },
        },
        overallStatus: 'STABLE',
        triggered: [],
      },
      driftReport: {
        model: { modelId: 'test_model', configVersion: '1.0.0' },
        referenceId: 'ref_dev_01',
        covariate: {
          status: 'STABLE',
          reason: 'Stable',
          metrics: {
            features: {
              feature_x: { key: 'feature_x', displayName: 'Feature X', kind: 'feature', status: 'STABLE', reason: 'ok', psiOrCsi: null, distributionProfile: null, ks: { d: 0.02, pValue: 0.45, status: 'STABLE', threshold: { warning: 0.1, critical: 0.2 } }, wasserstein: null },
              feature_y: { key: 'feature_y', displayName: 'Feature Y', kind: 'feature', status: 'STABLE', reason: 'ok', psiOrCsi: null, distributionProfile: null, ks: { d: 0.03, pValue: 0.25, status: 'STABLE', threshold: { warning: 0.1, critical: 0.2 } }, wasserstein: null },
            },
            score: null as any,
          },
        },
        missing: { status: 'STABLE', reason: 'none', metrics: { features: {}, threshold: { warningDelta: 0.02, criticalDelta: 0.05 } } },
        label: {
          status: 'STABLE',
          reason: 'No drift in bad rate',
          metrics: {
            referenceBadRate: 0.0935,
            actualBadRate: 0.0940,
            relativeChange: 0.0053,
            pValue: 0.8921,
            threshold: { pValueThreshold: 0.05 },
          } as any,
        },
        concept: {
          status: 'STABLE',
          reason: 'Good performance',
          metrics: {
            features: {},
            performance: {
              status: 'STABLE',
              reason: 'ประสิทธิภาพโมเดลคงที่ (AUC=0.724, Gini=0.448, KS=0.351)',
              reliable: true,
              reliabilityWarnings: [],
              actual: {
                n: 980,
                bads: 92,
                auc: 0.7241,
                gini: 0.4482,
                ks: 0.3512,
              },
              reference: {
                n: 1000,
                bads: 93,
                auc: 0.7300,
                gini: 0.4600,
                ks: 0.3600,
              },
            } as any,
            minBadsPerBin: 5,
          },
        },
        summary: {
          status: 'STABLE',
          reason: 'Stable',
          overallStatus: 'STABLE',
          driftTypesDetected: [],
          notAvailable: [],
          metrics: {
            overallStatus: 'STABLE',
            driftTypesDetected: [],
            notAvailable: [],
          },
        },
      },
      trigger: {
        action: 'CONTINUE',
        severity: 'info',
        matchedRuleId: 'R0',
        reasons: ['การกระจายตัวของคะแนนและตัวแปรหลักยังคงสอดคล้องกับ Reference'],
        evidence: {},
        recommendedSteps: [],
        requiresHumanReview: false,
      },
      uploadSummary: {
        periods: [{ period: '2025-07', count: 1000, pct: 100 }],
      },
    };

    const vm = buildRunReport(normalRun);

    // 1. Header
    expect(vm.header.modelName).toBe('Personal Loan Model v1');
    expect(vm.header.version).toBe('1.0.0');
    expect(vm.header.dataPeriod).toBe('2025-07');
    expect(vm.header.rowCount).toBe(1000);
    expect(vm.header.validRowCount).toBe(980);
    expect(vm.header.rejectedRowCount).toBe(20);

    // 2. Summary
    expect(vm.summary.verdictStatus).toBe('STABLE');
    expect(vm.summary.triggerAction).toBe('CONTINUE');
    expect(vm.summary.verdictColor).toBe('emerald');

    // 3. Data quality
    expect(vm.dataQuality.rejectedPct).toBe(2.0);
    expect(vm.dataQuality.evaluatedFeaturesCount).toBe(2);
    expect(vm.dataQuality.skippedFeatures).toEqual([]);
    expect(vm.dataQuality.coverageText).toContain('ตรวจครบทุกตัวแปร');

    // 4. Overall drift
    expect(vm.overallDrift.scorePsi).toBe(0.0452);
    expect(vm.overallDrift.scoreStatus).toBe('STABLE');
    expect(vm.overallDrift.hasLabelDrift).toBe(true);
    expect(vm.overallDrift.labelRefBadRate).toBe('9.35%');
    expect(vm.overallDrift.labelActBadRate).toBe('9.40%');
    expect(vm.overallDrift.labelPValue).toBe('0.8921');

    // 5. CSI table
    expect(vm.featuresCsi.length).toBe(2);
    expect(vm.featuresCsi[0].key).toBe('feature_y'); // sorted descending (0.0894 > 0.0321)
    expect(vm.featuresCsi[0].csiValue).toBe(0.0894);
    expect(vm.featuresCsi[1].key).toBe('feature_x');
    expect(vm.featuresCsi[1].csiValue).toBe(0.0321);

    // 6. Performance
    expect(vm.performance.hasLabels).toBe(true);
    expect(vm.performance.auc).toBe(0.7241);
    expect(vm.performance.aucPass).toBe(true);

    // 7. Recommendations
    expect(vm.recommendation.action).toBe('CONTINUE');

    // 8. Footer
    expect(vm.footerNotes.disclaimer).not.toContain('Basel');
    expect(vm.footerNotes.disclaimer).toContain('PSI 0.10');
  });

  it('2. builds accurate report for a blocked run (invalid data / validation error)', () => {
    const blockedRun: MonitoringRun = {
      runId: 'run_blocked_002',
      kind: 'monitoring',
      createdAt: '2025-08-10T08:00:00.000Z',
      model: { modelId: 'test_model', configVersion: '1.0.0' },
      modelName: 'Personal Loan Model v1',
      referenceId: 'ref_dev_01',
      fileName: 'm03_bad_schema.csv',
      thresholdsSnapshot: {
        psi_warning: DEFAULT_PSI_WARNING,
        psi_critical: DEFAULT_PSI_CRITICAL,
        gini_min: DEFAULT_GINI_MIN,
        auc_min: DEFAULT_AUC_MIN,
        ks_min: DEFAULT_KS_MIN,
        csi_features: { feat_a: { threshold: 0.10, bins: [] }, feat_b: { threshold: 0.10, bins: [] } },
      },
      validation: {
        ok: false,
        totalRows: 500,
        validRows: 0,
        rejectedRows: 500,
        rejectedPct: 100,
        warningRows: 0,
        issues: [],
        blockingErrors: [
          { type: 'MISSING_COLUMN', severity: 'error', column: 'feat_a', message: 'Missing feat_a' },
        ],
        warnings: [],
        groups: [],
      },
      drift: null, // blocked
      driftReport: null,
      trigger: {
        action: 'BLOCKED_INVALID_DATA',
        severity: 'critical',
        matchedRuleId: 'R1a',
        reasons: ['[R1a] ข้อมูลไม่ผ่านการตรวจสอบคอลัมน์จำเป็น: ไม่พบคอลัมน์ feat_a'],
        evidence: {},
        recommendedSteps: [],
        requiresHumanReview: true,
      },
    };

    const vm = buildRunReport(blockedRun);

    expect(vm.summary.verdictStatus).toBe('INVALID_DATA');
    expect(vm.summary.triggerAction).toBe('BLOCKED_INVALID_DATA');
    expect(vm.summary.verdictColor).toBe('rose');
    expect(vm.dataQuality.rejectedRows).toBe(500);
    expect(vm.dataQuality.rejectedPct).toBe(100);
    expect(vm.dataQuality.coverageText).toContain('ยังไม่ได้คำนวณ CSI');
    expect(vm.overallDrift.scorePsi).toBeNull();
    expect(vm.overallDrift.scoreStatus).toBe('ไม่ได้บันทึก');
    expect(vm.featuresCsi.length).toBe(0);
    expect(vm.performance.hasLabels).toBe(false);
    expect(vm.performance.message).toContain('ข้ามการประเมินประสิทธิภาพ');
  });

  it('3. builds report for a run without labels (unsupervised/production run)', () => {
    const noLabelRun: MonitoringRun = {
      runId: 'run_unlabeled_003',
      kind: 'monitoring',
      createdAt: '2025-09-01T12:00:00.000Z',
      model: { modelId: 'test_model', configVersion: '1.0.0' },
      modelName: 'Test Model',
      referenceId: 'ref_01',
      fileName: 'prod_batch_2025-09.csv',
      thresholdsSnapshot: {
        psi_warning: 0.10,
        psi_critical: 0.25,
        gini_min: 0.10,
        auc_min: 0.55,
        ks_min: 0.10,
        csi_features: {},
      },
      validation: {
        ok: true,
        totalRows: 2000,
        validRows: 2000,
        rejectedRows: 0,
        rejectedPct: 0,
        warningRows: 0,
        issues: [],
        blockingErrors: [],
        warnings: [],
        groups: [],
      },
      drift: {
        referenceId: 'ref_01',
        psi: { value: 0.1250, status: 'WARNING', threshold: { warning: 0.10, critical: 0.25 }, bins: [] },
        csi: {
          feature_num: { value: 0.1420, status: 'WARNING', threshold: { warning: 0.10, critical: 0.25 }, bins: [], displayName: 'Feature Num' },
        },
        overallStatus: 'WARNING',
        triggered: ['psi'],
      },
      driftReport: {
        model: { modelId: 'test_model', configVersion: '1.0.0' },
        referenceId: 'ref_01',
        covariate: {
          status: 'WARNING',
          reason: 'Score and feature shift',
          metrics: {
            features: {
              feature_num: { key: 'feature_num', displayName: 'Feature Num', kind: 'feature', status: 'WARNING', reason: 'Moderate shift', psiOrCsi: null, distributionProfile: null, ks: null, wasserstein: null },
            },
            score: null as any,
          },
        },
        missing: { status: 'STABLE', reason: 'none', metrics: { features: {}, threshold: { warningDelta: 0.02, criticalDelta: 0.05 } } },
        label: { status: 'NOT_AVAILABLE', reason: 'No labels', metrics: null },
        concept: null as any,
        summary: {
          status: 'WARNING',
          reason: 'Moderate drift',
          overallStatus: 'WARNING',
          driftTypesDetected: ['covariate'],
          notAvailable: [],
          metrics: {
            overallStatus: 'WARNING',
            driftTypesDetected: ['covariate'],
            notAvailable: [],
          },
        },
      },
      trigger: {
        action: 'MONITOR_CLOSELY',
        severity: 'warning',
        matchedRuleId: 'R8',
        reasons: ['[R8] พบสัญญาณเตือนระดับเฝ้าระวัง'],
        evidence: {},
        recommendedSteps: [],
        requiresHumanReview: false,
      },
    };

    const vm = buildRunReport(noLabelRun);

    expect(vm.summary.verdictStatus).toBe('WARNING');
    expect(vm.summary.verdictColor).toBe('amber');
    expect(vm.summary.triggerAction).toBe('MONITOR_CLOSELY');
    expect(vm.overallDrift.hasLabelDrift).toBe(false);
    expect(vm.overallDrift.labelRefBadRate).toBe('N/A');
    expect(vm.overallDrift.labelActBadRate).toBe('N/A');
    expect(vm.performance.hasLabels).toBe(false);
    expect(vm.performance.auc).toBeNull();
    expect(vm.performance.message).toContain('ข้ามการประเมินประสิทธิภาพ');
  });

  it('4. builds report gracefully for an old run without thresholdsSnapshot or labelEvidence', () => {
    const oldRun: any = {
      runId: 'run_legacy_999',
      kind: 'monitoring',
      createdAt: '2024-01-01T00:00:00.000Z',
      model: { modelId: 'legacy_model' },
      modelName: 'Legacy Model',
      referenceId: 'ref_old',
      fileName: 'legacy_data.csv',
      // thresholdsSnapshot is completely missing!
      validation: {
        ok: true,
        totalRows: 300,
        cleanRowCount: 300,
        rejectedRows: 0,
      },
      drift: {
        psi: { value: 0.02 },
        csi: {},
        overallStatus: 'STABLE',
      },
      // driftReport and trigger are completely missing!
    };

    const vm = buildRunReport(oldRun);

    // Falls back gracefully to 'ค่าเริ่มต้น (รอบนี้ไม่ได้บันทึกเกณฑ์)' or 'ไม่ได้บันทึก'
    expect(vm.header.configHash).toBe('ไม่ได้บันทึก');
    expect(vm.overallDrift.scoreWarningThreshold).toBe('ค่าเริ่มต้น (รอบนี้ไม่ได้บันทึกเกณฑ์)');
    expect(vm.overallDrift.scoreCriticalThreshold).toBe('ค่าเริ่มต้น (รอบนี้ไม่ได้บันทึกเกณฑ์)');
    expect(vm.performance.aucThreshold).toBe('ไม่ได้บันทึก');
    expect(vm.performance.giniThreshold).toBe('ไม่ได้บันทึก');
    expect(vm.performance.ksThreshold).toBe('ไม่ได้บันทึก');
    expect(vm.overallDrift.hasLabelDrift).toBe(false);
    expect(vm.performance.hasLabels).toBe(false);
    expect(vm.footerNotes.disclaimer).not.toContain('Basel');
  });

  it('5. computes configHash when baseline is provided', () => {
    const mockBaseline: any = {
      version: '1.0.0',
      modelId: 'test_model',
      name: 'Test',
      status: 'ACTIVE',
      validationReport: {
        configHash: 'hash_abc_123',
      },
    };

    const run: any = {
      runId: 'run_hash_test',
      kind: 'monitoring',
      createdAt: '2025-05-01T00:00:00.000Z',
      model: { modelId: 'test_model', version: '1.0.0' },
      validation: { totalRows: 100, validRows: 100, rejectedRows: 0 },
      drift: null,
    };

    const vm = buildRunReport(run, null, mockBaseline);
    expect(vm.header.configHash).toBe('hash_abc_123');
  });
});
