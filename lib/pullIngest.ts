/**
 * Automated Pull Ingestion Logic & Repository (Step 14 / งาน C)
 *
 * Implements:
 * 1. Pull ingestion from Vercel Blob folder `incoming/{modelId}/`
 * 2. Deduplication via KV cache `pull:processed:{modelId}` (pathname:size:uploadedAt or pathname:etag)
 * 3. Execution through `executeMonitoringPipeline` with source `scheduled` | `run-now`
 * 4. Duplicate period protection (onDuplicate = 'reject', skips without modifying existing runs)
 * 5. Validation failure handling (recorded in pull history, remembered to prevent retry, no INVALID_DATA run saved)
 * 6. Batch limit (max 3 files per run, remainder queued for subsequent runs)
 * 7. Pull history repository (stores 50 most recent pull runs per model in KV)
 */
import { getStore } from './storage/store';
import { getDefaultModelId } from './storage/repositories';
import { executeMonitoringPipeline, DuplicatePeriodError } from './monitoringCore';
import {
  IncomingBlobAdapter,
  IncomingBlobItem,
  computeBlobFileKey,
  getIncomingBlobAdapter,
} from './storage/incomingBlobAdapter';
import {
  DEFAULT_MAX_PULL_FILES_PER_RUN,
  DEFAULT_MAX_PULL_HISTORY_ENTRIES,
} from './defaults';

export type PullIngestTrigger = 'scheduled' | 'manual-run-now';

export interface PullIngestOptions {
  trigger: PullIngestTrigger;
  operator?: string; // Required for 'manual-run-now'
  modelId?: string;
  adapter?: IncomingBlobAdapter;
  maxFiles?: number;
}

export interface PullIngestFileResult {
  fileName: string;
  status:
    | 'SUCCESS'
    | 'SKIPPED_PROCESSED'
    | 'SKIPPED_DUPLICATE_PERIOD'
    | 'FAILED_VALIDATION'
    | 'FAILED_ERROR';
  reason?: string;
  runId?: string;
  period?: string | null;
  verdict?: string;
}

export interface PullIngestHistoryEntry {
  id: string;
  timestamp: string;
  modelId: string;
  trigger: PullIngestTrigger;
  operator?: string;
  summary: {
    totalFound: number;
    processedSuccess: number;
    skippedAlreadyProcessed: number;
    skippedDuplicatePeriod: number;
    failedCount: number;
  };
  files: PullIngestFileResult[];
  runIds: string[];
  error?: string;
}

export interface PullIngestResult {
  ok: boolean;
  historyEntry: PullIngestHistoryEntry;
  error?: string;
}

// ─── KV Storage Helpers ──────────────────────────────────────────────────────

function historyKey(modelId: string): string {
  return `pull:history:${modelId}`;
}

function processedKey(modelId: string): string {
  return `pull:processed:${modelId}`;
}

/**
 * Loads the pull history for a model (newest first).
 */
export async function listPullHistory(
  modelId: string,
  limit = DEFAULT_MAX_PULL_HISTORY_ENTRIES,
): Promise<PullIngestHistoryEntry[]> {
  const store = getStore();
  const history = (await store.get<PullIngestHistoryEntry[]>(historyKey(modelId))) || [];
  return history.slice(0, limit);
}

/**
 * Prepends a new history entry, keeping up to 50 most recent items in KV.
 */
export async function recordPullHistory(
  modelId: string,
  entry: PullIngestHistoryEntry,
): Promise<void> {
  const store = getStore();
  const existing = (await store.get<PullIngestHistoryEntry[]>(historyKey(modelId))) || [];
  const updated = [entry, ...existing].slice(0, DEFAULT_MAX_PULL_HISTORY_ENTRIES);
  await store.set(historyKey(modelId), updated);
}

/**
 * Loads the set of already processed blob keys for a model.
 */
export async function getProcessedBlobKeys(modelId: string): Promise<Set<string>> {
  const store = getStore();
  const keys = (await store.get<string[]>(processedKey(modelId))) || [];
  return new Set(keys);
}

/**
 * Persists an updated set of processed blob keys for a model.
 */
export async function saveProcessedBlobKeys(
  modelId: string,
  keys: Set<string> | string[],
): Promise<void> {
  const store = getStore();
  const arr = Array.isArray(keys) ? keys : Array.from(keys);
  await store.set(processedKey(modelId), arr);
}

// ─── Core Pull Ingestion Execution ───────────────────────────────────────────

/**
 * Core function executing automated pull ingestion.
 */
export async function executePullIngest(options: PullIngestOptions): Promise<PullIngestResult> {
  const modelId = options.modelId || (await getDefaultModelId());
  const trigger = options.trigger;
  const operator = options.operator?.trim();

  if (trigger === 'manual-run-now' && (!operator || operator === '')) {
    throw new Error('กรุณาระบุชื่อผู้สั่ง (ห้ามเว้นว่าง)');
  }

  const adapter = options.adapter || getIncomingBlobAdapter();
  const prefix = `incoming/${modelId}/`;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_PULL_FILES_PER_RUN;

  const processedSet = await getProcessedBlobKeys(modelId);
  const filesResults: PullIngestFileResult[] = [];
  const runIds: string[] = [];
  let processedSuccessCount = 0;
  let skippedAlreadyProcessedCount = 0;
  let skippedDuplicatePeriodCount = 0;
  let failedCount = 0;

  let allBlobs: IncomingBlobItem[] = [];
  try {
    allBlobs = await adapter.list(prefix);
  } catch (err: any) {
    const errorMsg = `ไม่สามารถเชื่อมต่อ Blob Storage: ${err?.message || String(err)}`;
    const failEntry: PullIngestHistoryEntry = {
      id: `pull_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      modelId,
      trigger,
      operator: operator || (trigger === 'scheduled' ? 'ระบบอัตโนมัติ (Vercel Cron)' : undefined),
      summary: {
        totalFound: 0,
        processedSuccess: 0,
        skippedAlreadyProcessed: 0,
        skippedDuplicatePeriod: 0,
        failedCount: 1,
      },
      files: [],
      runIds: [],
      error: errorMsg,
    };
    await recordPullHistory(modelId, failEntry);
    return { ok: false, historyEntry: failEntry, error: errorMsg };
  }

  // Filter CSV files only
  const csvBlobs = allBlobs.filter(b => b.pathname.toLowerCase().endsWith('.csv'));

  const toProcess: IncomingBlobItem[] = [];
  const alreadyProcessed: IncomingBlobItem[] = [];

  for (const blob of csvBlobs) {
    const key = computeBlobFileKey(blob);
    if (processedSet.has(key)) {
      alreadyProcessed.push(blob);
    } else {
      toProcess.push(blob);
    }
  }

  // Limit batch to maxFiles (default 3)
  const batch = toProcess.slice(0, maxFiles);

  for (const item of batch) {
    const fileKey = computeBlobFileKey(item);
    const fileName = item.pathname.split('/').pop() || item.pathname;

    let csvText: string;
    try {
      csvText = await adapter.get(item);
    } catch (err: any) {
      filesResults.push({
        fileName,
        status: 'FAILED_ERROR',
        reason: `ไม่สามารถดาวน์โหลดไฟล์จาก Blob: ${err?.message || String(err)}`,
      });
      failedCount++;
      continue;
    }

    try {
      const result = await executeMonitoringPipeline({
        modelId,
        fileName,
        csvText,
        source: trigger === 'scheduled' ? 'scheduled' : 'run-now',
        onDuplicate: 'reject',
        persistFailedRun: false,
      });

      if (!result.run.drift) {
        // Validation failed
        const issuesSummary = result.run.validation.issues?.length
          ? result.run.validation.issues.map(i => `${i.column}: ${i.message}`).join(', ')
          : `${result.run.validation.rejectedRows} แถวถูกตัดทิ้ง`;

        filesResults.push({
          fileName,
          status: 'FAILED_VALIDATION',
          period: result.period,
          reason: `ข้อมูลไม่ผ่านการตรวจสอบ: ${issuesSummary}`,
        });
        failedCount++;
        processedSet.add(fileKey);
        continue;
      }

      // Succeeded
      const periodLabel = result.period ? `งวด ${result.period}` : 'ไม่ระบุงวด';
      filesResults.push({
        fileName,
        status: 'SUCCESS',
        runId: result.run.runId,
        period: result.period,
        verdict: result.run.drift.overallStatus,
        reason: `ประมวลผลสำเร็จ (${periodLabel}, ${result.run.drift.overallStatus})`,
      });
      runIds.push(result.run.runId);
      processedSuccessCount++;
      processedSet.add(fileKey);
    } catch (err: any) {
      if (err instanceof DuplicatePeriodError) {
        filesResults.push({
          fileName,
          status: 'SKIPPED_DUPLICATE_PERIOD',
          period: err.period,
          reason: `งวดซ้ำ ข้าม (${err.period})`,
        });
        skippedDuplicatePeriodCount++;
        processedSet.add(fileKey);
      } else {
        filesResults.push({
          fileName,
          status: 'FAILED_ERROR',
          reason: `เกิดข้อผิดพลาดในการประมวลผลไฟล์: ${err?.message || String(err)}`,
        });
        failedCount++;
      }
    }
  }

  // Record already processed items
  for (const item of alreadyProcessed) {
    const fileName = item.pathname.split('/').pop() || item.pathname;
    filesResults.push({
      fileName,
      status: 'SKIPPED_PROCESSED',
      reason: 'เคยประมวลผลแล้ว (ข้าม)',
    });
    skippedAlreadyProcessedCount++;
  }

  // Persist updated processed keys in KV
  await saveProcessedBlobKeys(modelId, processedSet);

  const historyEntry: PullIngestHistoryEntry = {
    id: `pull_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    modelId,
    trigger,
    operator: operator || (trigger === 'scheduled' ? 'ระบบอัตโนมัติ (Vercel Cron)' : undefined),
    summary: {
      totalFound: csvBlobs.length,
      processedSuccess: processedSuccessCount,
      skippedAlreadyProcessed: skippedAlreadyProcessedCount,
      skippedDuplicatePeriod: skippedDuplicatePeriodCount,
      failedCount,
    },
    files: filesResults,
    runIds,
  };

  await recordPullHistory(modelId, historyEntry);

  return {
    ok: true,
    historyEntry,
  };
}
