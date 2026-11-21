/**
 * Maps the new MonitoringRun record onto the log shape the dashboard already
 * renders, plus the version/reference fields needed to keep logs apart.
 */
import type { MonitoringRun } from './types';

export function toLegacyLog(run: MonitoringRun) {
  return {
    logId: run.runId,
    modelId: run.model.modelId,
    modelName: run.modelName,
    configVersion: run.model.configVersion,
    referenceId: run.referenceId,
    uploadedAt: run.createdAt,
    fileName: run.fileName,
    rowCount: run.validation.totalRows,
    processedRows: run.validation.validRows,
    skippedRows: run.validation.rejectedRows,
    validationOk: run.validation.ok,
    results: run.drift
      ? {
          psi: run.drift.psi.value,
          csi: Object.fromEntries(Object.entries(run.drift.csi).map(([k, v]) => [k, v.value])),
          csiStatus: Object.fromEntries(Object.entries(run.drift.csi).map(([k, v]) => [k, v.status])),
          csiDetail: Object.fromEntries(Object.entries(run.drift.csi).map(([k, v]) => {
            const covFeat = run.driftReport?.covariate?.metrics?.features?.[k];
            const pValue = covFeat?.chiSquare?.pValue ?? covFeat?.ks?.pValue ?? null;
            const unseenIssues = (run.validation?.issues || []).filter(i => i.type === 'UNSEEN_CATEGORY' && i.column === k);
            const unseenRowCount = unseenIssues.length;
            const unseenDistinctCategories = new Set(unseenIssues.map(i => String(i.value))).size;
            return [k, {
              value: v.value,
              status: v.status,
              pValue,
              unseenRowCount,
              unseenDistinctCategories,
            }];
          })),
          status: run.drift.overallStatus,
        }
      : null,
    labelDrift: run.driftReport?.label ? {
      status: run.driftReport.label.status,
      reason: run.driftReport.label.reason,
      pValue: run.driftReport.label.metrics?.pValue,
      pThreshold: run.driftReport.label.metrics?.threshold?.pValueThreshold,
      refBadRate: run.driftReport.label.metrics?.referenceBadRate,
      actBadRate: run.driftReport.label.metrics?.actualBadRate,
    } : null,
    uploadSummary: run.uploadSummary,
    period: run.period ?? null,
    source: run.source ?? null,
    verdict: run.drift ? run.drift.overallStatus : 'INVALID_DATA',
    // ── Anomaly screening (new; absent/null for older runs) ──
    flaggedRows: run.anomaly?.flaggedRowCount ?? null,
    flaggedPct: run.anomaly?.flaggedPct ?? null,
    excludedCount: run.excludedRows?.length ?? 0,
    verdictExcludingFlagged: run.driftExcludingFlagged?.overallStatus ?? null,
    // ── Full Drift Report (Step 8) ──
    driftReportStatus: run.driftReport?.summary.overallStatus ?? null,
    driftTypesDetected: run.driftReport?.summary.driftTypesDetected ?? [],
    // ── Trigger Decision (Step 9) ──
    triggerAction: run.trigger?.action ?? null,
    triggerSeverity: run.trigger?.severity ?? null,
    hasDetail: Boolean(run.detail || run.detailBlobUrl),
    triggered: run.drift?.triggered ?? [],
    psiStatus: run.drift?.psi?.status ?? null,
    verdictReason: run.driftReport?.summary?.reason ?? null,
    triggerReasons: run.trigger?.reasons ?? [],
    thresholdMode: (run.detail?.thresholdMode ?? (run.model as any)?.thresholdMode ?? (run.thresholdsSnapshot as any)?.mode ?? 'fixed'),
  };
}
