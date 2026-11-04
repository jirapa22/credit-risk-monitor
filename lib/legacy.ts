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
          status: run.drift.overallStatus,
        }
      : null,
    uploadSummary: run.uploadSummary,
    verdict: run.drift ? run.drift.overallStatus : 'INVALID_DATA',
  };
}
