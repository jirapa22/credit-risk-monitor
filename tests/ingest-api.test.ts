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
import { listRuns, listDeletionAuditLogs } from '../lib/storage/repositories';
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
  });
});
