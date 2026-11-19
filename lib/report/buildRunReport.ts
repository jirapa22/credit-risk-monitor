import type {
  MonitoringRun,
  MonitoringRunDetail,
  BaselineVersion,
} from '../types';
import { computeBaselineConfigHash } from '../baselineValidation';
import { formatAppDateTime } from '../time';
import { toLegacyLog } from '../legacy';

export interface RunReportHeader {
  modelName: string;
  modelId: string;
  version: string;
  fileName: string;
  dataPeriod: string;
  isPeriodFallback: boolean;
  runDateTime: string;
  rowCount: number;
  validRowCount: number;
  rejectedRowCount: number;
  runId: string;
  configHash: string;
}

export interface RunReportExecutiveSummary {
  verdictStatus: string; // 'STABLE' | 'WARNING' | 'CRITICAL' | 'INVALID_DATA'
  verdictLabel: string;
  verdictColor: 'emerald' | 'amber' | 'rose' | 'slate';
  verdictReasonLine?: string; // Short evidence-based reason under verdict
  triggerAction: string;
  triggerActionLabel: string;
  matchedRuleId: string | null;
  severity: string;
  reasons: string[];
}

export interface RunReportDataQuality {
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  rejectedPct: number;
  issuesSummary: Array<{
    type: string;
    label: string;
    severity: 'error' | 'warning';
    count: number;
  }>;
  evaluatedFeaturesCount: number;
  totalMonitoredFeaturesCount: number;
  skippedFeatures: string[];
  coverageText: string;
}

export interface RunReportOverallDrift {
  scorePsi: number | null;
  scoreStatus: string;
  scoreStatusLabel: string;
  scoreWarningThreshold: number | string;
  scoreCriticalThreshold: number | string;
  hasLabelDrift: boolean;
  labelRefBadRate: string;
  labelActBadRate: string;
  labelRelativeChange: string;
  labelPValue: string;
  labelPThreshold: string;
  labelStatus: string;
  labelReason?: string;
  expectedBadRate?: string;
  labelPValueAdjusted?: string;
  scoreAdjustedNote?: string;
}

export interface RunReportFeatureCsiItem {
  key: string;
  displayName: string;
  csiValue: number | null;
  status: string;
  statusLabel: string;
  warnThreshold: number | string;
  critThreshold: number | string;
  exceeded: boolean;
  unseenInfo?: string;
}

export interface RunReportModelPerformance {
  hasLabels: boolean;
  auc: number | null;
  aucThreshold: number | string;
  aucPass: boolean | null;
  gini: number | null;
  giniThreshold: number | string;
  giniPass: boolean | null;
  ks: number | null;
  ksThreshold: number | string;
  ksPass: boolean | null;
  reliable?: boolean;
  message?: string;
}

export interface RunReportRecommendation {
  action: string;
  actionTitle: string;
  actionTone: 'emerald' | 'amber' | 'rose' | 'slate';
  recommendations: string[];
}

export interface RunReportViewModel {
  header: RunReportHeader;
  summary: RunReportExecutiveSummary;
  dataQuality: RunReportDataQuality;
  overallDrift: RunReportOverallDrift;
  featuresCsi: RunReportFeatureCsiItem[];
  performance: RunReportModelPerformance;
  recommendation: RunReportRecommendation;
  footerNotes: {
    disclaimer: string;
    generatedAt: string;
  };
}

const ISSUE_LABEL_THAI: Record<string, string> = {
  EMPTY_FILE: 'ไฟล์หรือข้อมูลไม่เพียงพอ',
  MISSING_COLUMN: 'ไม่พบคอลัมน์',
  DUPLICATE_COLUMN: 'คอลัมน์ซ้ำ',
  MISSING_VALUE: 'ค่าว่างในข้อมูล',
  INVALID_TYPE: 'ชนิดข้อมูลไม่ถูกต้อง',
  OUT_OF_RANGE: 'ค่านอกช่วงที่กำหนด',
  INVALID_DATE: 'วันที่ผิดรูปแบบ',
  INVALID_BINARY: 'ค่าต้องเป็น 0 หรือ 1',
  DUPLICATE_ID: 'รหัสลูกค้าซ้ำ',
  MALFORMED_ROW: 'แถวผิดรูปแบบ',
  UNSEEN_CATEGORY: 'หมวดหมู่ใหม่ที่ไม่เคยพบใน Reference',
};

const TRIGGER_ACTION_THAI: Record<string, string> = {
  CONTINUE: 'ดำเนินการต่อได้ตามปกติ (Continue Operation)',
  MONITOR_CLOSELY: 'ติดตามผลอย่างใกล้ชิด (Monitor Closely)',
  RECALIBRATE: 'พิจารณาปรับจูนคะแนนหรือจุดตัด (Recalibrate / Adjust Cut-off)',
  CONSIDER_RETRAIN: 'เตรียมวางแผนพัฒนาแบบจำลองใหม่ (Consider Retrain)',
  INVESTIGATE_DATA: 'ตรวจสอบคุณภาพข้อมูลจากระบบต้นทาง (Investigate Data Quality)',
  BLOCKED_INVALID_DATA: 'ระงับการใช้ผลเนื่องจากข้อมูลไม่ผ่านเกณฑ์ (Blocked - Invalid Data)',
};

function extractPeriod(run: MonitoringRun): { periodLabel: string; isFallback: boolean } {
  const uploadSummary = run.uploadSummary as any;
  const rawPeriods = uploadSummary?.periods || [];
  const validPeriods = rawPeriods
    .map((p: any) => p.period)
    .filter((p: any) => p && p !== 'ไม่ระบุวันที่' && p !== 'UNKNOWN' && p !== 'UNKNOWN_PERIOD');

  if (validPeriods.length === 1) {
    return { periodLabel: validPeriods[0], isFallback: false };
  }
  if (validPeriods.length > 1) {
    const sorted = [...validPeriods].sort();
    return { periodLabel: `${sorted[0]} – ${sorted[sorted.length - 1]}`, isFallback: false };
  }
  const match = (run.fileName || '').match(/(20\d{2}[-_]\d{2})/);
  if (match) {
    return { periodLabel: match[1].replace('_', '-'), isFallback: true };
  }
  return { periodLabel: 'ไม่ระบุงวดข้อมูล', isFallback: true };
}

function resolveConfigHash(run: MonitoringRun, baseline?: BaselineVersion | null): string {
  if (baseline?.validationReport?.configHash) {
    return baseline.validationReport.configHash;
  }
  if (baseline) {
    try {
      return computeBaselineConfigHash(baseline);
    } catch {
      // ignore
    }
  }
  return 'ไม่ได้บันทึก';
}

function formatPValue(p: number | string | null | undefined): string {
  if (p === null || p === undefined || p === 'N/A' || p === '—') return 'N/A';
  const num = typeof p === 'number' ? p : parseFloat(String(p));
  if (isNaN(num)) return String(p);
  if (num < 0.0001 || +num.toFixed(4) === 0) {
    return '< 0.0001';
  }
  return num.toFixed(4);
}

function deriveVerdictReasonLine(
  run: MonitoringRun,
  verdictStatus: string,
): string | undefined {
  if (verdictStatus === 'STABLE') {
    return 'การกระจายตัวของคะแนนและตัวแปรทั้งหมดอยู่ในเกณฑ์ปกติ';
  }
  if (verdictStatus === 'INVALID_DATA') {
    return 'ข้อมูลไม่ผ่านเกณฑ์การตรวจสอบขั้นต้น ระบบจึงระงับการประมวลผล';
  }

  // Find critical / warning CSIs from run.drift.csi
  const critFeatures: string[] = [];
  const warnFeatures: string[] = [];
  if (run.drift?.csi) {
    for (const [key, csi] of Object.entries(run.drift.csi)) {
      if (csi.status === 'CRITICAL') critFeatures.push(key);
      else if (csi.status === 'WARNING') warnFeatures.push(key);
    }
  }

  const psiStatus = run.drift?.psi?.status;
  const isPsiCrit = psiStatus === 'CRITICAL';
  const isPsiWarn = psiStatus === 'WARNING';
  const rejectedRows = run.validation?.rejectedRows ?? 0;

  if (verdictStatus === 'CRITICAL') {
    if (isPsiCrit) {
      return `เนื่องจาก PSI รวม (${run.drift?.psi?.value?.toFixed(4)}) อยู่ระดับวิกฤต`;
    }
    // PSI is not critical (e.g. m05 where PSI is warning, or m03 where PSI is stable)
    if (critFeatures.length > 0) {
      if (rejectedRows > 0) {
        return `เนื่องจาก CSI ของ ${critFeatures.join(', ')} อยู่ระดับวิกฤต (ตัวแปรที่ได้รับผลกระทบจากปัญหาข้อมูลที่ถูกตัดออก ${rejectedRows.toLocaleString()} แถว)`;
      }
      return `เนื่องจาก CSI ของ ${critFeatures.join(', ')} อยู่ระดับวิกฤต`;
    }
    return 'เนื่องจากพบความเปลี่ยนแปลงของตัวแปรเกินเกณฑ์วิกฤต';
  }

  if (verdictStatus === 'WARNING') {
    if (isPsiWarn) {
      return `เนื่องจาก PSI รวม (${run.drift?.psi?.value?.toFixed(4)}) อยู่ระดับเฝ้าระวัง`;
    }
    if (warnFeatures.length > 0) {
      return `เนื่องจาก CSI ของ ${warnFeatures.join(', ')} อยู่ระดับเฝ้าระวัง`;
    }
    if (run.driftReport?.label?.status === 'WARNING' || run.driftReport?.label?.status === 'CRITICAL') {
      return 'เนื่องจากอัตราหนี้เสีย (Bad Rate) เปลี่ยนแปลงอย่างมีนัยสำคัญ';
    }
    return 'เนื่องจากพบสัญญาณเฝ้าระวังจากการกระจายตัวของข้อมูล';
  }

  return undefined;
}

/**
 * Pure function to build the comprehensive view-model for a per-run drift report.
 */
export function buildRunReport(
  run: MonitoringRun,
  detail?: MonitoringRunDetail | null,
  baseline?: BaselineVersion | null,
): RunReportViewModel {
  const modelId = run.model?.modelId || (run.model as any)?.id || 'unknown_model';
  const modelName = run.modelName || (run.model as any)?.name || modelId;
  const version = run.model?.configVersion || (run.model as any)?.version || '1.0.0';
  const { periodLabel, isFallback } = extractPeriod(run);
  const configHash = resolveConfigHash(run, baseline);

  const totalRows = run.validation?.totalRows ?? detail?.validation?.totalRows ?? 0;
  const validRows = run.validation?.validRows ?? (run.validation as any)?.cleanRowCount ?? detail?.processedRows ?? 0;
  const rejectedRows = run.validation?.rejectedRows ?? detail?.skippedRows ?? 0;
  const rejectedPct = totalRows > 0 ? +((rejectedRows / totalRows) * 100).toFixed(1) : 0;

  // 1. Header
  const header: RunReportHeader = {
    modelName,
    modelId,
    version,
    fileName: run.fileName || 'ไฟล์ไม่ระบุชื่อ',
    dataPeriod: periodLabel,
    isPeriodFallback: isFallback,
    runDateTime: formatAppDateTime(run.createdAt, { showSeconds: true }),
    rowCount: totalRows,
    validRowCount: validRows,
    rejectedRowCount: rejectedRows,
    runId: run.runId,
    configHash,
  };

  // 2. Executive Summary
  const legacy = toLegacyLog(run);
  const verdictStatus = legacy.verdict; // 'STABLE' | 'WARNING' | 'CRITICAL' | 'INVALID_DATA' (reads from exact same source as dashboard badge)
  const isBlocked = verdictStatus === 'INVALID_DATA';
  let verdictLabel = 'ปกติ (Stable)';
  let verdictColor: 'emerald' | 'amber' | 'rose' | 'slate' = 'emerald';
  if (verdictStatus === 'INVALID_DATA') {
    verdictLabel = 'ข้อมูลไม่ผ่านเกณฑ์การตรวจสอบ (Invalid Data)';
    verdictColor = 'rose';
  } else if (verdictStatus === 'CRITICAL') {
    verdictLabel = 'วิกฤต (Critical Drift)';
    verdictColor = 'rose';
  } else if (verdictStatus === 'WARNING') {
    verdictLabel = 'เฝ้าระวัง (Moderate Drift)';
    verdictColor = 'amber';
  }

  const triggerAction = run.trigger?.action || (isBlocked ? 'BLOCKED_INVALID_DATA' : 'CONTINUE');
  const triggerActionLabel = TRIGGER_ACTION_THAI[triggerAction] || triggerAction;
  const matchedRuleId = run.trigger?.matchedRuleId || null;
  const severity = run.trigger?.severity || (verdictStatus === 'CRITICAL' ? 'critical' : verdictStatus === 'WARNING' ? 'warning' : 'info');

  let reasons: string[] = [];
  if (run.trigger?.reasons && run.trigger.reasons.length > 0) {
    reasons = run.trigger.reasons.slice(0, 3);
  } else if (isBlocked) {
    reasons = ['ไฟล์ข้อมูลไม่ผ่านเกณฑ์การตรวจสอบขั้นต้น (พบข้อผิดพลาดร้ายแรง) ระบบจึงระงับการคำนวณ PSI/CSI สำหรับรอบนี้'];
  } else if (verdictStatus === 'CRITICAL') {
    reasons = ['พบความเปลี่ยนแปลงของคะแนนหรือตัวแปรเกินเกณฑ์วิกฤต ควรตรวจสอบสาเหตุและพิจารณาปรับปรุงแบบจำลอง'];
  } else if (verdictStatus === 'WARNING') {
    reasons = ['พบสัญญาณเฝ้าระวังจากการกระจายตัวของตัวแปรหรืออัตราหนี้เสีย ควรติดตามผลในรอบถัดไปอย่างใกล้ชิด'];
  } else {
    reasons = ['การกระจายตัวของคะแนนและตัวแปรหลักยังคงสอดคล้องกับ Reference ข้อมูลอยู่ในเกณฑ์ปกติ'];
  }

  const verdictReasonLine = deriveVerdictReasonLine(run, verdictStatus);

  const summary: RunReportExecutiveSummary = {
    verdictStatus,
    verdictLabel,
    verdictColor,
    verdictReasonLine,
    triggerAction,
    triggerActionLabel,
    matchedRuleId,
    severity,
    reasons,
  };

  // 3. Data Quality
  const issuesMap = new Map<string, { type: string; label: string; severity: 'error' | 'warning'; count: number }>();
  if (Array.isArray(run.validation?.groups) && run.validation.groups.length > 0) {
    for (const g of run.validation.groups) {
      const type = g.type;
      const label = ISSUE_LABEL_THAI[type] || type;
      issuesMap.set(type, {
        type,
        label,
        severity: g.severity,
        count: (issuesMap.get(type)?.count || 0) + (g.count || 0),
      });
    }
  } else if (Array.isArray(run.validation?.issues)) {
    for (const issue of run.validation.issues) {
      const type = issue.type;
      const label = ISSUE_LABEL_THAI[type] || type;
      const cur = issuesMap.get(type) || { type, label, severity: issue.severity, count: 0 };
      cur.count += 1;
      if (issue.severity === 'error') cur.severity = 'error';
      issuesMap.set(type, cur);
    }
  }

  if (Array.isArray(run.validation?.blockingErrors)) {
    for (const err of run.validation.blockingErrors) {
      if (!issuesMap.has(err.type)) {
        issuesMap.set(err.type, {
          type: err.type,
          label: ISSUE_LABEL_THAI[err.type] || err.type,
          severity: 'error',
          count: 1,
        });
      }
    }
  }

  // Feature coverage calculation
  const evaluatedFeatures = run.drift?.csi ? Object.keys(run.drift.csi) : [];
  const evaluatedCount = evaluatedFeatures.length;

  // Determine monitored feature keys from thresholdsSnapshot or baseline
  const snapshotFeatures = run.thresholdsSnapshot?.csi_features
    ? Object.keys(run.thresholdsSnapshot.csi_features)
    : [];
  const baselineMonitored = baseline?.featureRegistry
    ? Object.entries(baseline.featureRegistry)
        .filter(([_, def]) => def.monitoringEnabled !== false)
        .map(([k, def]) => def.columnName || k)
    : [];
  
  const allMonitoredKeysSet = new Set([...snapshotFeatures, ...baselineMonitored]);
  // If no configured features, default to evaluated count
  const totalMonitored = allMonitoredKeysSet.size > 0 ? allMonitoredKeysSet.size : evaluatedCount;
  const skippedFeatures = Array.from(allMonitoredKeysSet).filter(k => !evaluatedFeatures.includes(k));

  let coverageText = 'ตรวจครบทุกตัวแปรที่ติดตาม';
  if (isBlocked) {
    coverageText = 'ยังไม่ได้คำนวณ CSI (ข้อมูลไม่ผ่านการตรวจสอบ)';
  } else if (totalMonitored > evaluatedCount && skippedFeatures.length > 0) {
    coverageText = `ตรวจ CSI ${evaluatedCount} จาก ${totalMonitored} ตัวแปร (ข้าม: ${skippedFeatures.join(', ')})`;
  } else if (evaluatedCount > 0) {
    coverageText = `ตรวจครบทุกตัวแปรที่ติดตาม (${evaluatedCount} จาก ${evaluatedCount} ตัวแปร)`;
  }

  const dataQuality: RunReportDataQuality = {
    totalRows,
    validRows,
    rejectedRows,
    rejectedPct,
    issuesSummary: Array.from(issuesMap.values()),
    evaluatedFeaturesCount: evaluatedCount,
    totalMonitoredFeaturesCount: Math.max(totalMonitored, evaluatedCount),
    skippedFeatures,
    coverageText,
  };

  // 4. Overall Drift
  const psiWarn: number | string =
    typeof run.thresholdsSnapshot?.psi_warning === 'number'
      ? run.thresholdsSnapshot.psi_warning
      : 'ค่าเริ่มต้น (รอบนี้ไม่ได้บันทึกเกณฑ์)';
  const psiCrit: number | string =
    typeof run.thresholdsSnapshot?.psi_critical === 'number'
      ? run.thresholdsSnapshot.psi_critical
      : 'ค่าเริ่มต้น (รอบนี้ไม่ได้บันทึกเกณฑ์)';
  const psiVal = run.drift?.psi?.value !== undefined && run.drift?.psi?.value !== null ? +run.drift.psi.value.toFixed(4) : null;
  const psiStatus = run.drift?.psi?.status ?? (isBlocked ? 'ไม่ได้บันทึก' : 'NOT_AVAILABLE');
  const psiStatusLabel =
    psiStatus === 'CRITICAL' ? 'วิกฤต (Critical)' :
    psiStatus === 'WARNING' ? 'เฝ้าระวัง (Warning)' :
    psiStatus === 'STABLE' ? 'ปกติ (Stable)' : 'ไม่มีข้อมูลคะแนน';

  // Label drift signals
  const labelEv = run.trigger?.evidence?.driftReport?.labelEvidence;
  const labelMetrics = run.driftReport?.label?.metrics;
  const hasLabelData = Boolean(labelEv || labelMetrics);

  const refBad = labelEv?.refBadRate !== undefined
    ? `${labelEv.refBadRate.toFixed(2)}%`
    : labelMetrics?.referenceBadRate !== undefined
      ? `${(labelMetrics.referenceBadRate * 100).toFixed(2)}%`
      : 'N/A';

  const actBad = labelEv?.actBadRate !== undefined
    ? `${labelEv.actBadRate.toFixed(2)}%`
    : labelMetrics?.actualBadRate !== undefined
      ? `${(labelMetrics.actualBadRate * 100).toFixed(2)}%`
      : 'N/A';

  const relChgRaw = labelEv?.relativeChange ?? labelMetrics?.relativeChange;
  const relChg = relChgRaw !== undefined && relChgRaw !== null
    ? `${relChgRaw >= 0 ? '+' : ''}${(relChgRaw * 100).toFixed(1)}%`
    : 'N/A';

  const pValRaw = labelEv?.pValue ?? labelMetrics?.pValue;
  const pVal = pValRaw !== undefined && pValRaw !== null
    ? formatPValue(pValRaw)
    : 'N/A';

  const pThrRaw = labelEv?.pThreshold ?? labelMetrics?.threshold?.pValueThreshold;
  const pThr = pThrRaw !== undefined && pThrRaw !== null
    ? String(pThrRaw)
    : 'ไม่ได้บันทึก';

  const labelStatus = labelEv?.status ?? run.driftReport?.label?.status ?? (hasLabelData ? 'STABLE' : 'N/A');
  const labelReason = labelEv?.reason ?? run.driftReport?.label?.reason ?? undefined;

  // Score-adjusted expected bad rate & p-value (Item 5)
  const adj = (run.driftReport?.label?.metrics as any)?.scoreAdjusted;
  const expBadRate =
    adj && typeof adj.expectedBadRate === 'number'
      ? `${(adj.expectedBadRate * 100).toFixed(2)}%`
      : 'N/A';
  const adjPVal =
    adj && typeof adj.pValue === 'number'
      ? formatPValue(adj.pValue)
      : 'N/A';

  const overallDrift: RunReportOverallDrift = {
    scorePsi: psiVal,
    scoreStatus: psiStatus,
    scoreStatusLabel: psiStatusLabel,
    scoreWarningThreshold: psiWarn,
    scoreCriticalThreshold: psiCrit,
    hasLabelDrift: hasLabelData,
    labelRefBadRate: refBad,
    labelActBadRate: actBad,
    labelRelativeChange: relChg,
    labelPValue: pVal,
    labelPThreshold: pThr,
    labelStatus,
    labelReason,
    expectedBadRate: expBadRate,
    labelPValueAdjusted: adjPVal,
    scoreAdjustedNote: 'ใช้อธิบายเหตุผล ไม่ใช่ตัวตัดสิน Trigger',
  };

  // 5. Features CSI
  const featuresCsi: RunReportFeatureCsiItem[] = [];
  if (run.drift?.csi) {
    for (const [key, csiItem] of Object.entries(run.drift.csi)) {
      const covFeat = run.driftReport?.covariate?.metrics?.features?.[key];
      const displayName = covFeat?.displayName || key;
      const csiValue = typeof csiItem.value === 'number' ? +csiItem.value.toFixed(4) : null;
      const status = csiItem.status || 'STABLE';
      const statusLabel =
        status === 'CRITICAL' ? 'วิกฤต' :
        status === 'WARNING' ? 'เฝ้าระวัง' : 'ปกติ';

      const warnThreshold: number | string =
        typeof run.thresholdsSnapshot?.csi_features?.[key]?.threshold === 'number'
          ? run.thresholdsSnapshot.csi_features[key].threshold
          : (typeof run.thresholdsSnapshot?.psi_warning === 'number'
              ? run.thresholdsSnapshot.psi_warning
              : 'ไม่ได้บันทึก');
      const critThreshold: number | string =
        typeof run.thresholdsSnapshot?.psi_critical === 'number'
          ? run.thresholdsSnapshot.psi_critical
          : 'ไม่ได้บันทึก';
      const exceeded =
        status === 'CRITICAL' ||
        status === 'WARNING' ||
        (typeof warnThreshold === 'number' && csiValue !== null && csiValue >= warnThreshold);

      // Check unseen categories
      const unseenIssues = (run.validation?.issues || []).filter(i => i.type === 'UNSEEN_CATEGORY' && i.column === key);
      let unseenInfo: string | undefined;
      if (unseenIssues.length > 0) {
        const uniqueCats = new Set(unseenIssues.map(i => String(i.value))).size;
        unseenInfo = `พบ ${unseenIssues.length} แถว (${uniqueCats} หมวดใหม่)`;
      }

      featuresCsi.push({
        key,
        displayName,
        csiValue,
        status,
        statusLabel,
        warnThreshold,
        critThreshold,
        exceeded,
        unseenInfo,
      });
    }
  }
  // Sort descending by CSI value
  featuresCsi.sort((a, b) => (b.csiValue ?? -1) - (a.csiValue ?? -1));

  // 6. Model Performance
  const perf = run.driftReport?.concept?.metrics?.performance ?? (run.driftReport?.concept as any)?.performance;
  const actualPerf = (perf as any)?.actual ?? perf;
  const aucVal = typeof actualPerf?.auc === 'number' ? actualPerf.auc : null;
  const giniVal = typeof actualPerf?.gini === 'number' ? actualPerf.gini : null;
  const ksVal = typeof actualPerf?.ks === 'number' ? actualPerf.ks : null;

  const aucMin: number | string =
    typeof run.thresholdsSnapshot?.auc_min === 'number' ? run.thresholdsSnapshot.auc_min : 'ไม่ได้บันทึก';
  const giniMin: number | string =
    typeof run.thresholdsSnapshot?.gini_min === 'number' ? run.thresholdsSnapshot.gini_min : 'ไม่ได้บันทึก';
  const ksMin: number | string =
    typeof run.thresholdsSnapshot?.ks_min === 'number' ? run.thresholdsSnapshot.ks_min : 'ไม่ได้บันทึก';

  let performance: RunReportModelPerformance;
  if (aucVal !== null) {
    performance = {
      hasLabels: true,
      auc: +aucVal.toFixed(4),
      aucThreshold: aucMin,
      aucPass: typeof aucMin === 'number' ? aucVal >= aucMin : null,
      gini: giniVal !== null ? +giniVal.toFixed(4) : null,
      giniThreshold: giniMin,
      giniPass: typeof giniMin === 'number' && giniVal !== null ? giniVal >= giniMin : null,
      ks: ksVal !== null ? +ksVal.toFixed(4) : null,
      ksThreshold: ksMin,
      ksPass: typeof ksMin === 'number' && ksVal !== null ? ksVal >= ksMin : null,
      reliable: perf?.reliable ?? (actualPerf as any)?.reliable,
    };
  } else {
    performance = {
      hasLabels: false,
      auc: null,
      aucThreshold: aucMin,
      aucPass: null,
      gini: null,
      giniThreshold: giniMin,
      giniPass: null,
      ks: null,
      ksThreshold: ksMin,
      ksPass: null,
      message: 'รอบนี้ไม่มีข้อมูลเฉลยผลจริง (Label/Default Flag) จึงข้ามการประเมินประสิทธิภาพแบบจำลอง',
    };
  }

  // 7. Recommendations
  let actionTone: 'emerald' | 'amber' | 'rose' | 'slate' = 'emerald';
  if (triggerAction === 'BLOCKED_INVALID_DATA' || triggerAction === 'CONSIDER_RETRAIN') {
    actionTone = 'rose';
  } else if (triggerAction === 'INVESTIGATE_DATA' || triggerAction === 'RECALIBRATE' || triggerAction === 'MONITOR_CLOSELY') {
    actionTone = 'amber';
  }

  const recommendation: RunReportRecommendation = {
    action: triggerAction,
    actionTitle: triggerActionLabel,
    actionTone,
    recommendations: reasons,
  };

  // 8. Footer Notes
  const footerNotes = {
    disclaimer:
      'หมายเหตุ: เกณฑ์ความเสถียรของคะแนน (PSI 0.10 สำหรับระดับเฝ้าระวัง และ 0.25 สำหรับระดับวิกฤต) เป็นค่าเริ่มต้นเชิงปฏิบัติที่ผู้พัฒนาตั้งไว้ (กฎหัวแม่มือ / Rule of Thumb ไม่ใช่ข้อบังคับของหน่วยงานกำกับดูแล) โดยผู้รับผิดชอบแบบจำลองสามารถปรับเปลี่ยนเกณฑ์ให้เหมาะสมตามความเสี่ยงของแต่ละผลิตภัณฑ์สินเชื่อได้ รายงานฉบับนี้สรุปเฉพาะภาพรวมความเสถียรและคุณภาพข้อมูล โดยไม่มีการจัดเก็บหรือแสดงผลข้อมูลลูกค้ารายบุคคล (เป็นไปตามหลัก PDPA)',
    generatedAt: formatAppDateTime(new Date().toISOString(), { showSeconds: true }),
  };

  return {
    header,
    summary,
    dataQuality,
    overallDrift,
    featuresCsi,
    performance,
    recommendation,
    footerNotes,
  };
}
