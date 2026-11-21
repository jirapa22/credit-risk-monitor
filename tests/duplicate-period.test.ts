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
import { POST as monitorUploadHandler } from '../app/api/monitor-upload/route';
import { listRuns, listDeletionAuditLogs } from '../lib/storage/repositories';
import type { FeatureDefinition, MonitoringRun } from '../lib/types';

describe('Duplicate Period Protection Tests', () => {
  const root = join(__dirname, '..');
  const modelId = 'dup_period_test_model';
  const version = '1.0.0';
  const referenceId = 'ref_dup_period_test';

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
        description: 'Baseline for duplicate period tests',
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
        anomalyTransform?: string;
        outOfBoundCount?: number;
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
    setStore(undefined);
    setBlobStore(undefined);
  });

  it('(1) initial upload of period 2025-07 succeeds (200) and stores period & source', async () => {
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    const res = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: m01Text, fileName: 'm01_run1.csv' }),
    }));

    expect(res.status).toBe(200);
    const data = (await res.json()) as { run: MonitoringRun };
    expect(data.run.period).toBe('2025-07');
    expect(data.run.source).toBe('manual');

    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(stored.length).toBe(1);
    expect(stored[0].period).toBe('2025-07');
    expect(stored[0].source).toBe('manual');
  });

  it('(2) duplicate upload of period 2025-07 without replace returns 409 DUPLICATE_PERIOD and is not saved', async () => {
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    const res = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: m01Text, fileName: 'm01_duplicate.csv' }),
    }));

    expect(res.status).toBe(409);
    const data = (await res.json()) as {
      code: string;
      period: string;
      existingRunId: string;
      existingRun: { runId: string; fileName: string; period: string };
    };
    expect(data.code).toBe('DUPLICATE_PERIOD');
    expect(data.period).toBe('2025-07');
    expect(data.existingRunId).toBeDefined();
    expect(data.existingRun.fileName).toBe('m01_run1.csv');

    // Confirm that the new run was NOT persisted
    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(stored.length).toBe(1);
    expect(stored[0].fileName).toBe('m01_run1.csv');
  });

  it('(3) duplicate upload with onDuplicate=replace replaces the existing run and records RUN_REPLACED audit', async () => {
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    const res = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        csvText: m01Text,
        fileName: 'm01_replaced.csv',
        onDuplicate: 'replace',
      }),
    }));

    expect(res.status).toBe(200);
    const data = (await res.json()) as { run: MonitoringRun };
    expect(data.run.fileName).toBe('m01_replaced.csv');
    expect(data.run.period).toBe('2025-07');

    // Confirm replaced in storage
    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(stored.length).toBe(1);
    expect(stored[0].fileName).toBe('m01_replaced.csv');

    // Confirm audit log recorded RUN_REPLACED
    const audits = await listDeletionAuditLogs();
    const replaceAudit = audits.find(a => a.action === 'RUN_REPLACED' && a.modelId === modelId);
    expect(replaceAudit).toBeDefined();
    expect(replaceAudit?.fileName).toBe('m01_run1.csv');
  });

  it('(4) non-duplicate upload (period 2025-09) succeeds without conflict', async () => {
    const m03Text = readFileSync(join(root, 'samples/cashloan_v2/m03_v2_2025-09_ระบบต้นทางมีปัญหา.csv'), 'utf8');
    const res = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: m03Text, fileName: 'm03_v2_2025-09.csv' }),
    }));

    expect(res.status).toBe(200);
    const data = (await res.json()) as { run: MonitoringRun };
    expect(data.run.period).toBe('2025-09');

    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(stored.length).toBe(2);
  });

  it('(5) upload with unknown period (no date in data, no period given) succeeds with warning "ไม่ทราบงวด"', async () => {
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    const lines = m01Text.trim().split('\n');
    const headerCols = lines[0].split(',');
    const dateIdx = headerCols.indexOf('app_date');
    expect(dateIdx).toBeGreaterThanOrEqual(0);

    const strippedLines = lines.map(line => {
      const parts = line.split(',');
      parts.splice(dateIdx, 1);
      return parts.join(',');
    });
    const strippedCsv = strippedLines.join('\n');

    const res = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: strippedCsv, fileName: 'no_date.csv' }),
    }));

    expect(res.status).toBe(200);
    const data = (await res.json()) as { run: MonitoringRun };
    expect(data.run.period).toBeUndefined();

    const stored = await listRuns<MonitoringRun>('monitoring', modelId);
    expect(stored.length).toBe(3);
  });
});
