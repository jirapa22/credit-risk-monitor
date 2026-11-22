import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStore, setStore } from '../lib/storage/store';
import { createMemoryBlobStore, setBlobStore } from '../lib/storage/blob';
import { POST as referencesHandler } from '../app/api/registry/references/route';
import { POST as suggestHandler } from '../app/api/registry/suggest/route';
import { POST as createDraftHandler } from '../app/api/registry/models/[modelId]/versions/route';
import { POST as importModelTableHandler } from '../app/api/registry/model-table/import/route';
import { POST as validateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/validate/route';
import { POST as activateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/activate/route';
import { POST as ingestHandler } from '../app/api/ingest/route';
import { POST as monitorUploadHandler } from '../app/api/monitor-upload/route';
import { listRuns, listDeletionAuditLogs, getMonitoringRunDetail } from '../lib/storage/repositories';
import { buildRunReport } from '../lib/report/buildRunReport';
import type { FeatureDefinition, MonitoringRun } from '../lib/types';
import { DEFAULT_MAX_INGEST_PAYLOAD_BYTES } from '../lib/defaults';

describe('Automated Ingestion API (/api/ingest) Tests', () => {
  const root = join(__dirname, '..');
  const modelId = 'ingest_test_model';
  const version = '1.0.0';
  const referenceId = 'ref_ingest_test';
  const TEST_TOKEN = 'test-secret-token-777';

  beforeAll(async () => {
    setStore(createMemoryStore());
    setBlobStore(createMemoryBlobStore());

    const baseText = readFileSync(join(root, 'samples/cashloan_v2/baseline_cashloan_v2_2024.csv'), 'utf8');
    const mtText = readFileSync(join(root, 'samples/cashloan_v2/model_table_cashloan.csv'), 'utf8');

    await referencesHandler(new Request('http://localhost:3000/api/registry/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceId,
        csvText: baseText,
        modelId,
        version,
        description: 'Baseline for Ingest API tests',
        labelColumn: 'default_12m',
      }),
    }));

    const sugRes = await suggestHandler(new Request('http://localhost:3000/api/registry/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId, provider: 'heuristic' }),
    }));
    const sugData = (await sugRes.json()) as {
      columns: Array<{ column: string; role: string; type: string }>;
      featureSettings: Array<{
        feature: string;
        description?: string;
        dataType: 'numeric' | 'categorical' | 'date' | 'binary';
        minValue?: number;
        maxValue?: number;
        missingStrategy?: string;
        categories?: string[];
      }>;
    };

    const columnMapping: Record<string, { role: string; type: string }> = {};
    for (const c of sugData.columns) {
      columnMapping[c.column] = { role: c.role, type: c.type };
    }
    columnMapping['app_id'] = { role: 'id', type: 'text' };
    columnMapping['default_12m'] = { role: 'label', type: 'binary' };
    columnMapping['app_date'] = { role: 'date', type: 'date' };
    columnMapping['credit_score'] = { role: 'score', type: 'numeric' };

    const featureDefs: Record<string, {
      displayName: string;
      description?: string;
      dataType: 'numeric' | 'categorical' | 'date' | 'binary';
      minValue?: number;
      maxValue?: number;
      missingStrategy: string;
      usedInModel?: boolean;
      required?: boolean;
      binning?: unknown;
      categoryPools?: unknown;
      poolPoints?: unknown;
    }> = {};

    for (const fs of sugData.featureSettings ?? []) {
      featureDefs[fs.feature] = {
        displayName: fs.feature,
        description: fs.description,
        dataType: fs.dataType,
        minValue: fs.minValue,
        maxValue: fs.maxValue,
        missingStrategy: (fs.missingStrategy === 'fillMean' ? 'mean' : fs.missingStrategy === 'fillMedian' ? 'median' : fs.missingStrategy === 'fillMode' ? 'mode' : fs.missingStrategy === 'ignore' ? 'ignore' : 'reject'),
      };
    }

    const mtRes = await importModelTableHandler(new Request('http://localhost:3000/api/registry/model-table/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId, csvText: mtText }),
    }));
    const mtData = (await mtRes.json()) as {
      scoring: unknown;
      featureSettingsUpdates?: Record<string, { binning?: unknown; categoryPools?: unknown; poolPoints?: unknown }>;
    };

    for (const [col, update] of Object.entries(mtData.featureSettingsUpdates ?? {})) {
      if (featureDefs[col]) {
        featureDefs[col] = {
          ...featureDefs[col],
          usedInModel: true,
          required: true,
          missingStrategy: 'reject',
          binning: update.binning ?? featureDefs[col].binning,
          categoryPools: update.categoryPools ?? featureDefs[col].categoryPools,
          poolPoints: update.poolPoints ?? featureDefs[col].poolPoints,
        };
      }
    }

    const features = Object.entries(columnMapping)
      .filter(([_, m]) => m.role === 'feature')
      .map(([col]) => col);

    const registryPayload: Record<string, FeatureDefinition> = {};
    for (const f of features) {
      const def = featureDefs[f];
      if (!def) continue;
      registryPayload[f] = {
        columnName: f,
        displayName: def.displayName || f,
        dataType: def.dataType,
        required: def.missingStrategy === 'reject',
        monitoringEnabled: true,
        validation: {
          minValue: def.minValue,
          maxValue: def.maxValue,
          missingStrategy: 'reject',
        },
      };
    }

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
          featureRegistry: registryPayload,
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
        body: JSON.stringify({ actor: 'test' }),
      }),
      { params: Promise.resolve({ modelId, version }) },
    );
  });

  afterAll(() => {
    delete process.env.MONITOR_API_TOKEN;
    setStore(undefined);
    setBlobStore(undefined);
  });

  it('(1) returns 401 when MONITOR_API_TOKEN is not set in environment (never left open)', async () => {
    delete process.env.MONITOR_API_TOKEN;

    const res = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ modelId, csvText: 'dummy' }),
    }));

    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('Unauthorized');
  });

  it('(2) returns 401 when Authorization header is missing or invalid', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;

    // Missing header
    const resNoHeader = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: 'dummy' }),
    }));
    expect(resNoHeader.status).toBe(401);

    // Wrong token
    const resWrong = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token-xyz',
      },
      body: JSON.stringify({ modelId, csvText: 'dummy' }),
    }));
    expect(resWrong.status).toBe(401);
  });

  it('(3) returns 413 when payload exceeds DEFAULT_MAX_INGEST_PAYLOAD_BYTES limit', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;

    // Simulate via Content-Length header
    const resOverHeader = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Length': String(DEFAULT_MAX_INGEST_PAYLOAD_BYTES + 1024),
      },
      body: JSON.stringify({ modelId, csvText: 'dummy' }),
    }));
    expect(resOverHeader.status).toBe(413);
  });

  it('(4) returns 404 NO_ACTIVE_VERSION when requested model has no active version', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const draftModelId = 'draft_only_test_model';

    // Create a model version with status DRAFT (not active)
    await createDraftHandler(
      new Request(`http://localhost:3000/api/registry/models/${draftModelId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '0.1.0',
          referenceDatasetId: referenceId,
          columns: {
            idColumn: 'app_id',
            dateColumn: 'app_date',
            labelColumn: 'default_12m',
            scoreColumn: 'credit_score',
          },
          featureRegistry: {},
          mode: 'scorecard',
        }),
      }),
      { params: Promise.resolve({ modelId: draftModelId }) },
    );

    const resInactive = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ modelId: draftModelId, csvText: 'dummy' }),
    }));

    expect(resInactive.status).toBe(404);
    const data = (await resInactive.json()) as { code: string };
    expect(data.code).toBe('NO_ACTIVE_VERSION');
  });

  it('(5) processes m01 correctly: returns 200, STABLE, CONTINUE, R9, source api, zero customer rows', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');

    const res = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        modelId,
        fileName: 'm01_api_ingest.csv',
        csvText: m01Text,
      }),
    }));

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      runId: string;
      modelId: string;
      version: string;
      period: string;
      source: string;
      verdict: string;
      trigger: { action: string; matchedRuleId: string; severity: string; reasons: string[] };
      csi: { checkedCount: number; skippedCount: number };
      reportUrl: string;
      scoredCustomers?: unknown;
      customers?: unknown;
    };

    expect(data.runId).toBeDefined();
    expect(data.modelId).toBe(modelId);
    expect(data.period).toBe('2025-07');
    expect(data.source).toBe('api');
    expect(data.verdict).toBe('STABLE');
    expect(data.trigger.matchedRuleId).toBe('R9');
    expect(data.trigger.action).toBe('CONTINUE');
    expect(data.csi.checkedCount).toBeGreaterThan(0);
    expect(data.reportUrl).toContain(`/dashboard/report/${data.runId}?modelId=${modelId}`);

    // Verify PDPA compliance: zero customer rows in response payload
    expect(data.scoredCustomers).toBeUndefined();
    expect(data.customers).toBeUndefined();

    // Verify stored run is tagged with source: 'api'
    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    const apiRun = stored.find(r => r.runId === data.runId);
    expect(apiRun?.source).toBe('api');
    expect(apiRun?.period).toBe('2025-07');
  });

  it('(6) processes m05 correctly: returns 200, CRITICAL, RECALIBRATE, R5 (same outcome as manual upload)', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const m05Text = readFileSync(join(root, 'samples/cashloan_v2/m05_v2_2025-11_แคมเปญMobileApp.csv'), 'utf8');

    // 1. Manual upload result
    const manualRes = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: m05Text, fileName: 'm05_manual.csv' }),
    }));
    expect(manualRes.status).toBe(200);
    const manualData = (await manualRes.json()) as {
      run: { trigger: { action: string; matchedRuleId: string }; drift: { overallStatus: string } };
    };

    // Replace via Ingest API to compare
    const apiRes = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        modelId,
        fileName: 'm05_api.csv',
        csvText: m05Text,
        onDuplicate: 'replace',
      }),
    }));

    expect(apiRes.status).toBe(200);
    const apiData = (await apiRes.json()) as {
      verdict: string;
      trigger: { action: string; matchedRuleId: string };
      source: string;
      scoredCustomers?: unknown;
    };

    expect(apiData.verdict).toBe('CRITICAL');
    expect(apiData.trigger.matchedRuleId).toBe('R5');
    expect(apiData.trigger.action).toBe('RECALIBRATE');
    expect(apiData.source).toBe('api');
    expect(apiData.scoredCustomers).toBeUndefined();

    // Verify identical core results between manual upload and API
    expect(apiData.verdict).toBe(manualData.run.drift.overallStatus);
    expect(apiData.trigger.action).toBe(manualData.run.trigger.action);
    expect(apiData.trigger.matchedRuleId).toBe(manualData.run.trigger.matchedRuleId);
  });

  it('(7) returns 409 DUPLICATE_PERIOD on duplicate period ingestion, and allows replace', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');

    // Reject by default
    const dupRes = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        modelId,
        fileName: 'm01_api_dup.csv',
        csvText: m01Text,
      }),
    }));
    expect(dupRes.status).toBe(409);
    const dupData = (await dupRes.json()) as { code: string; period: string };
    expect(dupData.code).toBe('DUPLICATE_PERIOD');
    expect(dupData.period).toBe('2025-07');

    // Replace when onDuplicate=replace
    const replaceRes = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        modelId,
        fileName: 'm01_api_replaced.csv',
        csvText: m01Text,
        onDuplicate: 'replace',
      }),
    }));
    expect(replaceRes.status).toBe(200);

    const audits = await listDeletionAuditLogs();
    const repAudit = audits.find(a => a.action === 'RUN_REPLACED' && a.modelId === modelId);
    expect(repAudit).toBeDefined();
    expect(repAudit?.actor).toBe('api');
  });

  it('(8) API replace with bad file (validation failure) returns 422, keeps existing run intact, and does NOT record RUN_REPLACED audit', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const auditsBefore = await listDeletionAuditLogs();
    const replaceAuditsBefore = auditsBefore.filter(a => a.action === 'RUN_REPLACED' && a.modelId === modelId).length;

    // Bad CSV missing required scorecard feature columns
    const badCsv = 'app_id,app_date,default_12m\nid_001,2025-07-01,0\nid_002,2025-07-02,1';

    const res = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        modelId,
        fileName: 'bad_api_file.csv',
        csvText: badCsv,
        onDuplicate: 'replace',
      }),
    }));

    // Expect 422 INVALID_DATA
    expect(res.status).toBe(422);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_DATA');

    // Confirm existing run remains completely intact
    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(stored.some(r => r.fileName === 'm01_api_replaced.csv')).toBe(true);

    // Confirm NO new RUN_REPLACED audit log was recorded
    const auditsAfter = await listDeletionAuditLogs();
    const replaceAuditsAfter = auditsAfter.filter(a => a.action === 'RUN_REPLACED' && a.modelId === modelId).length;
    expect(replaceAuditsAfter).toBe(replaceAuditsBefore);
  });

  it('(9) multipart/form-data: processes m05 correctly with Thai filename: returns 200, CRITICAL, R5, PSI ~0.2103, source api, preserves Thai filename', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const m05Text = readFileSync(join(root, 'samples/cashloan_v2/m05_v2_2025-11_แคมเปญMobileApp.csv'), 'utf8');
    const thaiFileName = 'm05_v2_2025-11_แคมเปญMobileApp.csv';

    const fd = new FormData();
    const file = new File([m05Text], thaiFileName, { type: 'text/csv' });
    fd.append('file', file);
    fd.append('modelId', modelId);
    fd.append('onDuplicate', 'replace');

    const res = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: fd,
    }));

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      verdict: string;
      trigger: { action: string; matchedRuleId: string };
      source: string;
      psi: number;
      period: string;
    };

    expect(data.verdict).toBe('CRITICAL');
    expect(data.trigger.matchedRuleId).toBe('R5');
    expect(data.trigger.action).toBe('RECALIBRATE');
    expect(data.psi).toBeCloseTo(0.2103, 3);
    expect(data.source).toBe('api');
    expect(data.period).toBe('2025-11');

    // Confirm Thai filename is preserved in stored run
    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    const m05Run = stored.find(r => r.period === '2025-11');
    expect(m05Run).toBeDefined();
    expect(m05Run?.fileName).toBe(thaiFileName);

    // Verify report labelRelativeChange is +51.3% (not +5130.0%)
    const detailRes = await getMonitoringRunDetail(modelId, m05Run!.runId);
    const report = buildRunReport(detailRes.run!, detailRes.detail);
    expect(report.overallDrift.labelRelativeChange).toBe('+51.3%');
  });

  it('(10) multipart/form-data: duplicate submission returns 409 DUPLICATE_PERIOD', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const m05Text = readFileSync(join(root, 'samples/cashloan_v2/m05_v2_2025-11_แคมเปญMobileApp.csv'), 'utf8');

    const fd = new FormData();
    const file = new File([m05Text], 'm05_v2_2025-11_แคมเปญMobileApp.csv', { type: 'text/csv' });
    fd.append('file', file);

    const dupRes = await ingestHandler(new Request(`http://localhost:3000/api/ingest?modelId=${modelId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: fd,
    }));

    expect(dupRes.status).toBe(409);
    const dupData = (await dupRes.json()) as { code: string; period: string };
    expect(dupData.code).toBe('DUPLICATE_PERIOD');
    expect(dupData.period).toBe('2025-11');
  });

  it('(11) multipart/form-data: replace with corrupted file returns 422, keeps original run intact, and does not record RUN_REPLACED audit', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const auditsBefore = await listDeletionAuditLogs();
    const replaceAuditsBefore = auditsBefore.filter(a => a.action === 'RUN_REPLACED' && a.modelId === modelId).length;

    const badCsv = 'app_id,app_date,default_12m\nid_001,2025-11-01,0\nid_002,2025-11-02,1';
    const fd = new FormData();
    const file = new File([badCsv], 'bad_replacement.csv', { type: 'text/csv' });
    fd.append('file', file);
    fd.append('onDuplicate', 'replace');

    const res = await ingestHandler(new Request(`http://localhost:3000/api/ingest?modelId=${modelId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: fd,
    }));

    expect(res.status).toBe(422);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_DATA');

    // Confirm existing m05 run is still preserved
    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    const m05Run = stored.find(r => r.period === '2025-11');
    expect(m05Run).toBeDefined();
    expect(m05Run?.fileName).toBe('m05_v2_2025-11_แคมเปญMobileApp.csv');

    // Confirm NO RUN_REPLACED audit log added
    const auditsAfter = await listDeletionAuditLogs();
    const replaceAuditsAfter = auditsAfter.filter(a => a.action === 'RUN_REPLACED' && a.modelId === modelId).length;
    expect(replaceAuditsAfter).toBe(replaceAuditsBefore);
  });

  it('(12) multipart/form-data: missing or empty file returns 400 (MISSING_FILE / EMPTY_FILE) and does NOT persist any INVALID_DATA run in storage', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const runsBefore = (await listRuns<MonitoringRun>('monitoring', modelId)).length;

    // A) FormData without 'file' field
    const fdNoFile = new FormData();
    fdNoFile.append('modelId', modelId);
    const resNoFile = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: fdNoFile,
    }));
    expect(resNoFile.status).toBe(400);
    const noFileData = (await resNoFile.json()) as { code: string };
    expect(noFileData.code).toBe('MISSING_FILE');

    // B) FormData with empty file (0 bytes)
    const fdEmpty = new FormData();
    fdEmpty.append('file', new File([], 'empty.csv', { type: 'text/csv' }));
    fdEmpty.append('modelId', modelId);
    const resEmpty = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: fdEmpty,
    }));
    expect(resEmpty.status).toBe(400);
    const emptyData = (await resEmpty.json()) as { code: string };
    expect(emptyData.code).toBe('EMPTY_FILE');

    // Confirm no runs were created/persisted in storage
    const runsAfter = (await listRuns<MonitoringRun>('monitoring', modelId)).length;
    expect(runsAfter).toBe(runsBefore);
  });

  it('(13) validation failure on fresh period (no prior run) records INVALID_DATA run for UI inspection identically in both manual upload and ingest API', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const badCsv = 'app_id,app_date,default_12m\nid_001,2025-12-01,0\nid_002,2025-12-02,1';

    // Ingest API with bad data on new period 2025-12
    const fd = new FormData();
    fd.append('file', new File([badCsv], 'bad_data_2025-12.csv', { type: 'text/csv' }));
    fd.append('modelId', modelId);

    const res = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: fd,
    }));

    expect(res.status).toBe(422);
    const data = (await res.json()) as { code: string; runId: string };
    expect(data.code).toBe('INVALID_DATA');

    // Confirm that the failed run WAS recorded in storage for UI inspection (same as manual upload)
    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    const recorded = stored.find(r => r.runId === data.runId);
    expect(recorded).toBeDefined();
    expect(recorded?.validation.ok).toBe(false);
    expect(recorded?.drift).toBeNull();
  });

  it('(14) API ingest for m06: report labelRelativeChange matches real value +24.4%', async () => {
    process.env.MONITOR_API_TOKEN = TEST_TOKEN;
    const m06Text = readFileSync(join(root, 'samples/cashloan_v2/m06_v2_2025-12_เศรษฐกิจชะลอตัว.csv'), 'utf8');

    const fd = new FormData();
    fd.append('file', new File([m06Text], 'm06_api_2025-12.csv', { type: 'text/csv' }));
    fd.append('modelId', modelId);
    fd.append('onDuplicate', 'replace');

    const res = await ingestHandler(new Request('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: fd,
    }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { runId: string };

    const detailRes = await getMonitoringRunDetail(modelId, data.runId);
    const report = buildRunReport(detailRes.run!, detailRes.detail);
    expect(report.overallDrift.hasLabelDrift).toBe(true);
    expect(report.overallDrift.labelRelativeChange).toBe('+24.4%');
  });
});
