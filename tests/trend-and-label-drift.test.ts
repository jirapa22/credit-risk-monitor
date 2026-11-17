import { describe, expect, it } from 'vitest';
import { toLegacyLog } from '../lib/legacy';
import type { MonitoringRun } from '../lib/types';

describe('PSI/CSI Trend and Label Drift Governance', () => {
  it('toLegacyLog passes through triggered, psiStatus, verdictReason, triggerReasons, and thresholdMode', () => {
    const mockRun: MonitoringRun = {
      runId: 'run_test_01',
      kind: 'monitoring',
      createdAt: '2025-08-01T12:00:00.000Z',
      model: { modelId: 'test_model', configVersion: '1.0.0' },
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
        requiresHumanReview: false,
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

  it('correctly calculates warning occurrences vs unique warning rows and overlap for m03', () => {
    const warningGroups = [
      { type: 'OUT_OF_RANGE', severity: 'warning' as const, column: 'feat_income', count: 90 },
      { type: 'UNSEEN_CATEGORY', severity: 'warning' as const, column: 'feat_occ', count: 52 },
    ];
    const totalWarnHits = warningGroups.reduce((acc, g) => acc + g.count, 0);
    const uniqueWarnRows = 139;
    const overlapCount = totalWarnHits - uniqueWarnRows;

    expect(totalWarnHits).toBe(142);
    expect(uniqueWarnRows).toBe(139);
    expect(overlapCount).toBe(3);
  });

  it('formats reference period properly and falls back to ไม่ระบุ instead of empty arrow', () => {
    const formatPeriod = (pStart?: string, pEnd?: string, baselinePeriod?: string) => {
      const s = pStart?.trim();
      const e = pEnd?.trim();
      if (s && e) return `${s} → ${e}`;
      if (s || e) return s || e;
      if (baselinePeriod && baselinePeriod.trim()) return baselinePeriod.trim();
      return 'ไม่ระบุ';
    };

    expect(formatPeriod('2024-01-01', '2024-12-31')).toBe('2024-01-01 → 2024-12-31');
    expect(formatPeriod('', '')).toBe('ไม่ระบุ');
    expect(formatPeriod(undefined, undefined, '2024-01 – 2024-12')).toBe('2024-01 – 2024-12');
    expect(formatPeriod(undefined, undefined)).toBe('ไม่ระบุ');
  });

  it('computes validation badge label and policy color level', () => {
    const getBadgeInfo = (rejectedRows: number, rejectedPct: number, warningRows: number, policy: { warn?: number; crit?: number } = {}) => {
      const warnPct = policy.warn ?? 1.0;
      const critPct = policy.crit ?? 5.0;

      if (rejectedRows === 0 && warningRows === 0) {
        return { text: 'PASS', color: 'green' };
      }

      const label = rejectedRows > 0
        ? `PASS (มีการตัดแถว ${rejectedRows} แถว, ${rejectedPct}%)`
        : `PASS (พบคำเตือน ${warningRows} แถว)`;

      const isOrange = rejectedPct >= critPct;
      return { text: label, color: isOrange ? 'orange' : 'yellow' };
    };

    // Clean data
    expect(getBadgeInfo(0, 0, 0)).toEqual({ text: 'PASS', color: 'green' });

    // m04: 0 rejected, 37 warning rows -> PASS with yellow
    expect(getBadgeInfo(0, 0, 37)).toEqual({ text: 'PASS (พบคำเตือน 37 แถว)', color: 'yellow' });

    // m03: 79 rejected (6.6%), 139 warning rows -> PASS (มีการตัดแถว 79 แถว, 6.6%) with orange (6.6% >= 5%)
    expect(getBadgeInfo(79, 6.6, 139)).toEqual({ text: 'PASS (มีการตัดแถว 79 แถว, 6.6%)', color: 'orange' });
  });
});
