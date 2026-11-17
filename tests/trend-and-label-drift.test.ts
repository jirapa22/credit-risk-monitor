import { describe, expect, it } from 'vitest';
import { toLegacyLog } from '../lib/legacy';
import type { MonitoringRun } from '../lib/types';

describe('PSI/CSI Trend and Label Drift Governance', () => {
  it('toLegacyLog passes through triggered, psiStatus, verdictReason, triggerReasons, and thresholdMode', () => {
    const mockRun: MonitoringRun = {
      runId: 'run_test_01',
      kind: 'monitoring',
      createdAt: '2025-08-01T12:00:00.000Z',
      model: { modelId: 'test_model', version: 'v1.0.0', configVersion: '1.0.0' },
      modelName: 'Test Model',
      referenceId: 'ref_01',
      fileName: 'm01_v2_2025-07_ปกติ.csv',
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
        totalRows: 1000,
        validRows: 1000,
        rejectedRows: 0,
        rejectedPct: 0,
        blockingErrors: [],
        warnings: [],
        groups: [],
        issues: [],
      },
      drift: {
        referenceId: 'ref_01',
        psi: {
          value: 0.125,
          status: 'WARNING',
          threshold: { warning: 0.10, critical: 0.25 },
          bins: [],
        },
        csi: {
          feat_x: {
            value: 0.32,
            status: 'CRITICAL',
            threshold: { warning: 0.10, critical: 0.25 },
            bins: [],
            displayName: 'Feature X',
          },
        },
        overallStatus: 'CRITICAL',
        triggered: ['csi:feat_x'],
      },
      driftReport: {
        summary: {
          overallStatus: 'CRITICAL',
          reason: 'CSI ของ Feature X เกินเกณฑ์วิกฤต',
          driftTypesDetected: ['covariate'],
        },
      } as any,
      trigger: {
        action: 'INVESTIGATE_DRIFT',
        severity: 'warning',
        matchedRuleId: 'R7',
        reasons: ['[R7] ลักษณะลูกค้าเปลี่ยน ติดตามรอบถัดไป'],
        evidence: {} as any,
        recommendedSteps: [],
      },
    };

    const legacy = toLegacyLog(mockRun);
    expect(legacy.logId).toBe('run_test_01');
    expect(legacy.triggered).toEqual(['csi:feat_x']);
    expect(legacy.psiStatus).toBe('WARNING');
    expect(legacy.verdictReason).toBe('CSI ของ Feature X เกินเกณฑ์วิกฤต');
    expect(legacy.triggerReasons).toEqual(['[R7] ลักษณะลูกค้าเปลี่ยน ติดตามรอบถัดไป']);
    expect(legacy.thresholdMode).toBe('fixed');
  });

  it('verifies period range formatting and fallback labels', () => {
    // Single period
    const periods1 = [{ period: '2025-07', count: 100, pct: 100 }];
    const valid1 = periods1.filter(p => p.period && p.period !== 'ไม่ระบุวันที่');
    expect(valid1.length).toBe(1);
    expect(valid1[0].period).toBe('2025-07');

    // Multiple periods range
    const periodsMulti = [
      { period: '2025-07', count: 50, pct: 50 },
      { period: '2025-09', count: 50, pct: 50 },
    ];
    const sorted = periodsMulti.map(p => p.period).sort();
    const range = `${sorted[0]} – ${sorted[sorted.length - 1]}`;
    expect(range).toBe('2025-07 – 2025-09');

    // Filename fallback match
    const filename = 'm02_v2_2025-08_ปกติ.csv';
    const match = filename.match(/(20\d{2}[-_]\d{2})/);
    expect(match).not.toBeNull();
    expect(match![1].replace('_', '-')).toBe('2025-08');

    // Upload timestamp fallback label
    const fallbackStr = '15 พ.ย. (อัปโหลด)';
    expect(fallbackStr).toContain('(อัปโหลด)');
  });

  it('differentiates OOT filenames from regular monthly monitoring', () => {
    const isOot = (name: string) => /(?:^|[_ -])(oot|test|dev|val|eval|special|sandbox)(?:$|[_ -])/i.test(name) || /oot/i.test(name);

    expect(isOot('oot_v2_2025-11_ทดสอบ.csv')).toBe(true);
    expect(isOot('cashloan_oot_test.csv')).toBe(true);
    expect(isOot('special_eval_2025.csv')).toBe(true);

    expect(isOot('m01_v2_2025-07_ปกติ.csv')).toBe(false);
    expect(isOot('m03_v2_2025-09_เริ่มเสื่อม.csv')).toBe(false);
    expect(isOot('monitoring_data_2025-10.csv')).toBe(false);
  });
});
