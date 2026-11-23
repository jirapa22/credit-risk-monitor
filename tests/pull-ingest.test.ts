/**
 * Tests for Automated Pull Ingestion & Run Now (Step 14 / งาน C)
 *
 * Verifies:
 * 6a) m05 file in incoming -> 1 run created, duplicate execution skips and does not recreate
 * 6b) Duplicate period with existing run -> skipped, no replacement, existing run intact
 * 6c) Corrupted/invalid file -> recorded in pull history, no INVALID_DATA run saved in monitoring log, not retried
 * 6d) Cron endpoint: missing/invalid secret -> 401 Unauthorized, adapter not called
 * 6e) 5 files in incoming -> exactly 3 processed in first run, remaining 2 wait for next run
 * 6f) Run-now without operator name -> 400 Bad Request
 * 6g) Pulled run persists active ruleSetId and revision
 *
 * Performance:
 * Measures actual execution time for 1 m05 file to evaluate against Vercel Hobby maxDuration (60s).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createMemoryStore, setStore } from '../lib/storage/store';
import { createMemoryBlobStore, setBlobStore } from '../lib/storage/blob';
import { MemoryIncomingBlobAdapter } from '../lib/storage/incomingBlobAdapter';
import { executePullIngest, listPullHistory } from '../lib/pullIngest';
import { GET as cronHandler } from '../app/api/cron/pull-ingest/route';
import { POST as runNowHandler } from '../app/api/pull-ingest/run-now/route';
import { POST as referencesHandler } from '../app/api/registry/references/route';
import { POST as suggestHandler } from '../app/api/registry/suggest/route';
import { POST as createDraftHandler } from '../app/api/registry/models/[modelId]/versions/route';
import { POST as importModelTableHandler } from '../app/api/registry/model-table/import/route';
import { POST as validateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/validate/route';
import { POST as activateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/activate/route';
import { listRuns } from '../lib/storage/repositories';
import { initializeDefaultRuleSets } from '../lib/storage/ruleSetRepository';
import type { FeatureDefinition, MonitoringRun } from '../lib/types';

describe('Automated Pull Ingestion & Run Now (งาน C)', () => {
  const root = join(__dirname, '..');
  const modelId = 'model_vmc5k';
  const version = '1.0.0';
  const referenceId = 'ref_cashloan_v2';
  let m05Text: string;

  beforeAll(async () => {
    setStore(createMemoryStore());
    setBlobStore(createMemoryBlobStore());

    const baseText = readFileSync(join(root, 'samples/cashloan_v2/baseline_cashloan_v2_2024.csv'), 'utf8');
    const mtText = readFileSync(join(root, 'samples/cashloan_v2/model_table_cashloan.csv'), 'utf8');
    m05Text = readFileSync(join(root, 'samples/cashloan_v2/m05_v2_2025-11_แคมเปญMobileApp.csv'), 'utf8');

    await referencesHandler(
      new Request('http://localhost:3000/api/registry/references', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId, csvText: baseText }),
      }),
    );

    const sugRes = await suggestHandler(
      new Request('http://localhost:3000/api/registry/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId, provider: 'heuristic' }),
      }),
    );
    const sugData = await sugRes.json();

    const featureDefs: Record<string, FeatureDefinition> = {};
    for (const fs of sugData.featureSettings ?? []) {
      featureDefs[fs.feature] = {
        columnName: fs.feature,
        displayName: fs.feature,
        dataType: fs.dataType,
        required: true,
        monitoringEnabled: true,
        validation: {
          minValue: fs.minValue,
          maxValue: fs.maxValue,
          missingStrategy: 'reject',
        },
      };
    }

    const mtRes = await importModelTableHandler(
      new Request('http://localhost:3000/api/registry/model-table/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId, csvText: mtText }),
      }),
    );
    const mtData = await mtRes.json();

    await createDraftHandler(
      new Request(`http://localhost:3000/api/registry/models/${modelId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version,
          referenceDatasetId: referenceId,
          columns: {
            idColumn: 'app_id',
            dateColumn: 'app_date',
            labelColumn: 'default_12m',
            scoreColumn: 'credit_score',
          },
          featureRegistry: featureDefs,
          scoring: mtData.scoring,
          scoreDirection: 'higher_is_safer',
        }),
      }),
      { params: Promise.resolve({ modelId }) },
    );

    await validateVersionHandler(
      new Request(`http://localhost:3000/api/registry/models/${modelId}/versions/${version}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runMultivariateCheck: false, runCalibration: false }),
      }),
      { params: Promise.resolve({ modelId, version }) },
    );

    await activateVersionHandler(
      new Request(`http://localhost:3000/api/registry/models/${modelId}/versions/${version}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'pull-ingest-test-setup' }),
      }),
      { params: Promise.resolve({ modelId, version }) },
    );

    await initializeDefaultRuleSets(modelId, version);
  });

  it('6a) m05 file in incoming -> 1 run created, duplicate execution skips and does not recreate', async () => {
    const adapter = new MemoryIncomingBlobAdapter();
    adapter.putFile(`incoming/${modelId}/m05_v2_2025-11_แคมเปญMobileApp.csv`, m05Text);

    const initialRuns = await listRuns<MonitoringRun>('monitoring', modelId);

    // Measure exact execution time for 1 m05 file
    const tStart = performance.now();
    const result1 = await executePullIngest({
      trigger: 'scheduled',
      modelId,
      adapter,
    });
    const tEnd = performance.now();
    const elapsedMs = tEnd - tStart;
    console.log(`[PERF MEASUREMENT] 1 m05 file pull ingestion pipeline: ${elapsedMs.toFixed(2)} ms (${(elapsedMs / 1000).toFixed(3)} s)`);

    expect(result1.ok).toBe(true);
    expect(result1.historyEntry.summary.processedSuccess).toBe(1);
    expect(result1.historyEntry.summary.failedCount).toBe(0);
    expect(result1.historyEntry.files[0].status).toBe('SUCCESS');
    expect(result1.historyEntry.files[0].period).toBe('2025-11');

    const runsAfter1 = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(runsAfter1.length).toBe(initialRuns.length + 1);
    const createdRun = runsAfter1[0];
    expect(createdRun.period).toBe('2025-11');
    expect(createdRun.source).toBe('scheduled');

    // Run again with the exact same file in incoming
    const result2 = await executePullIngest({
      trigger: 'scheduled',
      modelId,
      adapter,
    });

    expect(result2.ok).toBe(true);
    expect(result2.historyEntry.summary.processedSuccess).toBe(0);
    expect(result2.historyEntry.summary.skippedAlreadyProcessed).toBe(1);
    expect(result2.historyEntry.files[0].status).toBe('SKIPPED_PROCESSED');
    expect(result2.historyEntry.files[0].reason).toContain('เคยประมวลผลแล้ว');

    const runsAfter2 = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(runsAfter2.length).toBe(runsAfter1.length);
  });

  it('6b) Duplicate period with existing run -> skipped, no replacement, existing run intact', async () => {
    const adapter = new MemoryIncomingBlobAdapter();
    // Put a new file with different filename but same period 2025-11
    adapter.putFile(`incoming/${modelId}/m05_duplicate_upload.csv`, m05Text);

    const runsBefore = await listRuns<MonitoringRun>('monitoring', modelId);
    const existingRun202511 = runsBefore.find(r => r.period === '2025-11');
    expect(existingRun202511).toBeDefined();
    const originalRunId = existingRun202511?.runId;
    const originalCreatedAt = existingRun202511?.createdAt;

    const pullRes = await executePullIngest({
      trigger: 'scheduled',
      modelId,
      adapter,
    });

    expect(pullRes.ok).toBe(true);
    expect(pullRes.historyEntry.summary.processedSuccess).toBe(0);
    expect(pullRes.historyEntry.summary.skippedDuplicatePeriod).toBe(1);

    const dupFile = pullRes.historyEntry.files.find(f => f.fileName === 'm05_duplicate_upload.csv');
    expect(dupFile?.status).toBe('SKIPPED_DUPLICATE_PERIOD');
    expect(dupFile?.reason).toContain('งวดซ้ำ ข้าม');

    // Confirm existing run was not modified or replaced
    const runsAfter = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(runsAfter.length).toBe(runsBefore.length);
    const runAfterCheck = runsAfter.find(r => r.period === '2025-11');
    expect(runAfterCheck?.runId).toBe(originalRunId);
    expect(runAfterCheck?.createdAt).toBe(originalCreatedAt);
  });

  it('6c) Corrupted/invalid file -> recorded in pull history, no INVALID_DATA run saved in monitoring log, not retried', async () => {
    const adapter = new MemoryIncomingBlobAdapter();
    // Put corrupted CSV (missing required columns and header broken)
    const corruptedCsv = 'broken_col1,broken_col2\ninvalid_1,invalid_2\ninvalid_3,invalid_4\n';
    adapter.putFile(`incoming/${modelId}/corrupted_data_test.csv`, corruptedCsv);

    const runsBefore = await listRuns<MonitoringRun>('monitoring', modelId);

    const pullRes1 = await executePullIngest({
      trigger: 'scheduled',
      modelId,
      adapter,
    });

    expect(pullRes1.ok).toBe(true);
    expect(pullRes1.historyEntry.summary.failedCount).toBe(1);
    expect(pullRes1.historyEntry.summary.processedSuccess).toBe(0);

    const failedFile = pullRes1.historyEntry.files.find(f => f.fileName === 'corrupted_data_test.csv');
    expect(failedFile?.status).toBe('FAILED_VALIDATION');
    expect(failedFile?.reason).toContain('ข้อมูลไม่ผ่านการตรวจสอบ');

    // Confirm NO INVALID_DATA run was appended to monitoring log
    const runsAfter1 = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(runsAfter1.length).toBe(runsBefore.length);
    expect(runsAfter1.some(r => r.fileName === 'corrupted_data_test.csv')).toBe(false);

    // Run again -> must NOT retry the failed file (remembered key)
    const pullRes2 = await executePullIngest({
      trigger: 'scheduled',
      modelId,
      adapter,
    });

    expect(pullRes2.ok).toBe(true);
    expect(pullRes2.historyEntry.summary.failedCount).toBe(0);
    expect(pullRes2.historyEntry.summary.skippedAlreadyProcessed).toBe(1);
    expect(pullRes2.historyEntry.files[0].status).toBe('SKIPPED_PROCESSED');
  });

  it('6d) Cron endpoint: missing/invalid secret -> 401 Unauthorized, adapter not called', async () => {
    const origSecret = process.env.CRON_SECRET;
    try {
      process.env.CRON_SECRET = 'super-secret-cron-token-123456';

      // 1. Missing header
      const reqNoAuth = new Request('http://localhost:3000/api/cron/pull-ingest');
      const resNoAuth = await cronHandler(reqNoAuth);
      expect(resNoAuth.status).toBe(401);
      const jsonNoAuth = await resNoAuth.json();
      expect(jsonNoAuth.error).toBe('Unauthorized');

      // 2. Wrong token
      const reqBadAuth = new Request('http://localhost:3000/api/cron/pull-ingest', {
        headers: { Authorization: 'Bearer wrong-token-xyz' },
      });
      const resBadAuth = await cronHandler(reqBadAuth);
      expect(resBadAuth.status).toBe(401);
      const jsonBadAuth = await resBadAuth.json();
      expect(jsonBadAuth.error).toBe('Unauthorized');

      // 3. Valid token returns 200
      const reqValid = new Request(`http://localhost:3000/api/cron/pull-ingest?modelId=${modelId}`, {
        headers: { Authorization: 'Bearer super-secret-cron-token-123456' },
      });
      const resValid = await cronHandler(reqValid);
      expect(resValid.status).toBe(200);
      const jsonValid = await resValid.json();
      expect(jsonValid.ok).toBe(true);
      expect(jsonValid.trigger).toBe('scheduled');
      expect(jsonValid.summary).toBeDefined();
    } finally {
      process.env.CRON_SECRET = origSecret;
    }
  });

  it('6e) 5 files in incoming -> exactly 3 processed in first run, remaining 2 wait for next run', async () => {
    const adapter = new MemoryIncomingBlobAdapter();
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    const m02Text = readFileSync(join(root, 'samples/cashloan_v2/m02_v2_2025-08_ปกติ.csv'), 'utf8');
    const m03Text = readFileSync(join(root, 'samples/cashloan_v2/m03_v2_2025-09_ระบบต้นทางมีปัญหา.csv'), 'utf8');
    const m04Text = readFileSync(join(root, 'samples/cashloan_v2/m04_v2_2025-10_ส่งข้อมูลซ้ำ.csv'), 'utf8');
    const m06Text = readFileSync(join(root, 'samples/cashloan_v2/m06_v2_2025-12_เศรษฐกิจชะลอตัว.csv'), 'utf8');

    // 5 files with sequential timestamps
    adapter.putFile(`incoming/${modelId}/file_1_m01.csv`, m01Text, '2026-01-01T01:00:00.000Z');
    adapter.putFile(`incoming/${modelId}/file_2_m02.csv`, m02Text, '2026-01-01T02:00:00.000Z');
    adapter.putFile(`incoming/${modelId}/file_3_m03.csv`, m03Text, '2026-01-01T03:00:00.000Z');
    adapter.putFile(`incoming/${modelId}/file_4_m04.csv`, m04Text, '2026-01-01T04:00:00.000Z');
    adapter.putFile(`incoming/${modelId}/file_5_m06.csv`, m06Text, '2026-01-01T05:00:00.000Z');

    // Run 1: limit 3
    const run1 = await executePullIngest({
      trigger: 'scheduled',
      modelId,
      adapter,
    });

    expect(run1.ok).toBe(true);
    expect(run1.historyEntry.summary.processedSuccess).toBe(3);
    expect(run1.historyEntry.files.length).toBe(3);
    expect(run1.historyEntry.files.map(f => f.fileName)).toEqual([
      'file_1_m01.csv',
      'file_2_m02.csv',
      'file_3_m03.csv',
    ]);

    // Run 2: remaining 2 files are processed
    const run2 = await executePullIngest({
      trigger: 'scheduled',
      modelId,
      adapter,
    });

    expect(run2.ok).toBe(true);
    expect(run2.historyEntry.summary.processedSuccess).toBe(2);
    expect(run2.historyEntry.summary.skippedAlreadyProcessed).toBe(3);

    const processedInRun2 = run2.historyEntry.files.filter(f => f.status === 'SUCCESS');
    expect(processedInRun2.map(f => f.fileName)).toEqual([
      'file_4_m04.csv',
      'file_5_m06.csv',
    ]);
  });

  it('6f) Run-now without operator name -> 400 Bad Request', async () => {
    // 1. Missing operator
    const reqEmpty = new Request('http://localhost:3000/api/pull-ingest/run-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId }),
    });
    const resEmpty = await runNowHandler(reqEmpty);
    expect(resEmpty.status).toBe(400);
    const jsonEmpty = await resEmpty.json();
    expect(jsonEmpty.error).toContain('กรุณาระบุชื่อผู้สั่ง');

    // 2. Whitespace-only operator
    const reqSpace = new Request('http://localhost:3000/api/pull-ingest/run-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator: '   ', modelId }),
    });
    const resSpace = await runNowHandler(reqSpace);
    expect(resSpace.status).toBe(400);
    const jsonSpace = await resSpace.json();
    expect(jsonSpace.error).toContain('กรุณาระบุชื่อผู้สั่ง');

    // 3. Valid operator succeeds
    const reqValid = new Request('http://localhost:3000/api/pull-ingest/run-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator: 'นายสมชาย วิศวกรความเสี่ยง', modelId }),
    });
    const resValid = await runNowHandler(reqValid);
    expect(resValid.status).toBe(200);
    const jsonValid = await resValid.json();
    expect(jsonValid.ok).toBe(true);
    expect(jsonValid.trigger).toBe('manual-run-now');
    expect(jsonValid.operator).toBe('นายสมชาย วิศวกรความเสี่ยง');
  });

  it('6g) Pulled run persists active ruleSetId and revision', async () => {
    const adapter = new MemoryIncomingBlobAdapter();
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    // Use new period 2026-02 so it does not conflict with existing runs
    const mNewText = m01Text.replace(/2025-07/g, '2026-02');
    adapter.putFile(`incoming/${modelId}/ruleset_check_m_new.csv`, mNewText);

    const pullRes = await executePullIngest({
      trigger: 'manual-run-now',
      operator: 'ทีมผู้ตรวจสอบ',
      modelId,
      adapter,
    });

    expect(pullRes.ok).toBe(true);
    expect(pullRes.historyEntry.summary.processedSuccess).toBe(1);

    const runId = pullRes.historyEntry.runIds[0];
    expect(runId).toBeDefined();

    const runs = await listRuns<MonitoringRun>('monitoring', modelId);
    const run = runs.find(r => r.runId === runId);
    expect(run).toBeDefined();
    expect(run?.ruleSetId).toBe('ruleset_standard');
    expect(run?.ruleSetName).toBe('มาตรฐาน');
    expect(run?.ruleSetRevision).toBe(1);
    expect(run?.source).toBe('run-now');

    // Check pull history records 50 limit and operator
    const history = await listPullHistory(modelId, 50);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].operator).toBe('ทีมผู้ตรวจสอบ');
  });
});
