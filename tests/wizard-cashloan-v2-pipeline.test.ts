import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getStore, setStore, UpstashMockStore } from '../lib/storage/store';
import { createMemoryBlobStore, setBlobStore } from '../lib/storage/blob';
import { getEffectiveModel } from '../lib/storage/repositories';

// Route handlers under test
import { POST as referencesHandler } from '../app/api/registry/references/route';
import { POST as suggestHandler } from '../app/api/registry/suggest/route';
import { POST as scorecardImportHandler } from '../app/api/registry/scorecard/import/route';
import { POST as createVersionHandler } from '../app/api/registry/models/[modelId]/versions/route';
import { POST as validateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/validate/route';
import { POST as activateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/activate/route';
import { POST as monitorUploadHandler } from '../app/api/monitor-upload/route';
import type { FeatureDefinition } from '../lib/types';

describe('Wizard Cash Loan v2 Pipeline Integration Test (Mock Store)', () => {
  const root = process.cwd();
  let mockStore: UpstashMockStore;

  beforeEach(() => {
    mockStore = new UpstashMockStore();
    setStore(mockStore);
    setBlobStore(createMemoryBlobStore());
  });

  afterEach(() => {
    setStore(undefined);
    setBlobStore(undefined);
  });

  it('runs the full Wizard registration path and verifies m03 and m04 monitoring behavior', async () => {
    const baseText = readFileSync(join(root, 'samples/cashloan_v2/baseline_cashloan_v2_2024.csv'), 'utf8');
    const mtText = readFileSync(join(root, 'samples/cashloan_v2/model_table_cashloan.csv'), 'utf8');
    const m03Text = readFileSync(join(root, 'samples/cashloan_v2/m03_v2_2025-09_ระบบต้นทางมีปัญหา.csv'), 'utf8');
    const m04Text = readFileSync(join(root, 'samples/cashloan_v2/m04_v2_2025-10_ส่งข้อมูลซ้ำ.csv'), 'utf8');

    const modelId = 'cashloan_v2_test';
    const version = '1.0.0';
    const referenceId = 'ref_cashloan_v2_test';

    // ── 1. Upload baseline reference via /api/registry/references ──
    const refReq = new Request('http://localhost:3000/api/registry/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceId,
        csvText: baseText,
        modelId,
        version,
        description: 'Cash loan v2 baseline reference',
        labelColumn: 'default_12m',
      }),
    });
    const refRes = await referencesHandler(refReq);
    expect(refRes.status).toBe(201);
    const refData = await refRes.json();
    expect(refData.meta.rowCount).toBe(5000);

    // ── 2. Request suggestions via /api/registry/suggest ──
    const sugReq = new Request('http://localhost:3000/api/registry/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceId,
        provider: 'heuristic',
      }),
    });
    const sugRes = await suggestHandler(sugReq);
    expect(sugRes.status).toBe(200);
    const sugData = await sugRes.json();
    expect(sugData.columns).toBeDefined();

    // Map columns like Wizard Step 2
    const columnMapping: Record<string, { role: string; type: string }> = {};
    for (const c of sugData.columns) {
      columnMapping[c.column] = { role: c.role, type: c.type };
    }
    // Ensure standard roles
    columnMapping['app_id'] = { role: 'id', type: 'text' };
    columnMapping['default_12m'] = { role: 'label', type: 'binary' };
    columnMapping['app_date'] = { role: 'date', type: 'date' };
    columnMapping['credit_score'] = { role: 'score', type: 'numeric' };

    // Initialize feature settings from suggestions like Wizard Step 1
    const featureDefs: Record<string, any> = {};
    for (const fs of sugData.featureSettings ?? []) {
      featureDefs[fs.feature] = {
        displayName: fs.feature,
        description: fs.description,
        dataType: fs.dataType,
        minValue: fs.minValue ?? undefined,
        maxValue: fs.maxValue ?? undefined,
        missingStrategy: (fs.missingStrategy === 'fillMean' ? 'mean' : fs.missingStrategy === 'fillMedian' ? 'median' : fs.missingStrategy === 'fillMode' ? 'mode' : 'reject'),
        allowedCategories: fs.categories ?? [],
        rareCategoryThreshold: 0.01,
        anomalyTransform: fs.anomalyTransform,
        outOfBoundCount: fs.outOfBoundCount,
      };
    }

    // ── 3. Import Scorecard / Model Table via /api/registry/scorecard/import ──
    const scReq = new Request('http://localhost:3000/api/registry/scorecard/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csvText: mtText,
        referenceId,
        scoreColumn: 'credit_score',
      }),
    });
    const scRes = await scorecardImportHandler(scReq);
    expect(scRes.status).toBe(200);
    const scData = await scRes.json();
    expect(scData.ok).toBe(true);
    expect(scData.featureUpdates).toBeDefined();

    // Merge feature updates like Wizard Step 3 (fixed logic)
    const tableVars = new Set(scData.table?.features || Object.keys(scData.featureUpdates));
    for (const [col, def] of Object.entries(featureDefs)) {
      featureDefs[col] = {
        ...def,
        usedInModel: tableVars.has(col),
      };
    }
    for (const [col, update] of Object.entries(scData.featureUpdates as Record<string, any>)) {
      if (!featureDefs[col]) {
        featureDefs[col] = {
          displayName: col,
          dataType: update.dataType,
          required: true,
          monitoringEnabled: true,
          usedInModel: true,
          binning: update.binning,
          categoryPools: update.categoryPools,
          poolPoints: update.poolPoints,
          minValue: update.minValue,
          maxValue: update.maxValue,
          rangeSource: update.rangeSource ?? (update.minValue !== undefined ? 'auto' : undefined),
          baselineMin: update.baselineMin,
          baselineMax: update.baselineMax,
          missingStrategy: 'reject',
        };
      } else {
        featureDefs[col] = {
          ...featureDefs[col],
          dataType: update.dataType || featureDefs[col].dataType,
          usedInModel: true,
          required: true,
          missingStrategy: 'reject',
          binning: update.binning ?? featureDefs[col].binning,
          categoryPools: update.categoryPools ?? featureDefs[col].categoryPools,
          poolPoints: update.poolPoints ?? featureDefs[col].poolPoints,
          minValue: update.minValue ?? featureDefs[col].minValue,
          maxValue: update.maxValue ?? featureDefs[col].maxValue,
          rangeSource: update.rangeSource ?? (update.minValue !== undefined ? 'auto' : featureDefs[col].rangeSource),
          baselineMin: update.baselineMin ?? featureDefs[col].baselineMin,
          baselineMax: update.baselineMax ?? featureDefs[col].baselineMax,
        };
      }
    }

    // ── 4. Build feature registry payload like Wizard Step 5 ──
    const features = Object.entries(columnMapping)
      .filter(([_, m]) => m.role === 'feature')
      .map(([col]) => col);

    const registryPayload: Record<string, FeatureDefinition> = {};
    for (const f of features) {
      const def = featureDefs[f];
      if (!def) continue;
      const isModelVar = def.usedInModel === true;
      const missingStrat = isModelVar || def.missingStrategy === 'reject'
        ? 'reject'
        : def.missingStrategy === 'mean' ? 'fillMean' : def.missingStrategy === 'median' ? 'fillMedian' : def.missingStrategy === 'mode' ? 'fillMode' : 'reject';
      registryPayload[f] = {
        columnName: f,
        displayName: def.displayName || f,
        dataType: def.dataType,
        required: isModelVar || def.missingStrategy === 'reject',
        monitoringEnabled: true,
        validation: {
          minValue: def.minValue,
          maxValue: def.maxValue,
          rangeSource: def.rangeSource ?? (def.minValue !== undefined ? 'user' : undefined),
          baselineMin: def.baselineMin,
          baselineMax: def.baselineMax,
          missingStrategy: missingStrat,
        },
        ...(def.dataType === 'categorical' ? {
          allowedCategories: def.allowedCategories,
          rareCategoryThreshold: def.rareCategoryThreshold,
        } : {}),
        ...(def.anomalyTransform ? { anomalyTransform: def.anomalyTransform } : {}),
        ...(def.usedInModel !== undefined ? { usedInModel: def.usedInModel } : {}),
        ...(def.poolPoints ? { poolPoints: def.poolPoints } : {}),
        ...(def.binning ? { binning: def.binning } : {}),
        ...(def.categoryPools ? { categoryPools: def.categoryPools } : {}),
      };
    }

    // Print & assert the exact feature settings saved by Wizard
    const incConf = registryPayload['monthly_income'];
    const utilConf = registryPayload['credit_util_pct'];
    const occConf = registryPayload['occupation'];

    expect(incConf).toBeDefined();
    expect(incConf.dataType).toBe('numeric');
    expect(incConf.required).toBe(true);
    expect(incConf.validation?.minValue).toBe(4490);
    expect(incConf.validation?.maxValue).toBe(130610);
    expect(incConf.validation?.rangeSource).toBe('auto');
    expect(incConf.validation?.missingStrategy).toBe('reject');

    expect(utilConf).toBeDefined();
    expect(utilConf.dataType).toBe('numeric');
    expect(utilConf.required).toBe(true);
    expect(utilConf.validation?.minValue).toBe(0);
    expect(utilConf.validation?.maxValue).toBe(109.93);
    expect(utilConf.validation?.rangeSource).toBe('auto');
    expect(utilConf.validation?.missingStrategy).toBe('reject');

    expect(occConf).toBeDefined();
    expect(occConf.dataType).toBe('categorical');
    expect(occConf.required).toBe(true);
    expect(occConf.validation?.missingStrategy).toBe('reject');

    // ── 5. Create Draft Version via POST /api/registry/models/[modelId]/versions ──
    const createReq = new Request(`http://localhost:3000/api/registry/models/${modelId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version,
        name: 'Cash Loan v2 Test Model',
        referenceId,
        mode: 'scorecard',
        scoreDirection: 'higher_better',
        featureRegistry: registryPayload,
        columns: {
          idColumn: 'app_id',
          dateColumn: 'app_date',
          labelColumn: 'default_12m',
          scoreColumn: 'credit_score',
        },
        modelTable: scData.table,
        scoring: scData.scoring,
      }),
    });
    const createRes = await createVersionHandler(createReq, { params: Promise.resolve({ modelId }) });
    expect(createRes.status).toBe(201);

    // ── 6. Validate Version via POST /api/registry/models/[modelId]/versions/[version]/validate ──
    const valReq = new Request(`http://localhost:3000/api/registry/models/${modelId}/versions/${version}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    });
    const valRes = await validateVersionHandler(valReq, { params: Promise.resolve({ modelId, version }) });
    expect(valRes.status).toBe(200);
    const valData = await valRes.json();
    expect(valData.ok).toBe(true);
    expect(valData.validationReport.computed.performance?.auc).toBeCloseTo(0.753, 3);

    // ── 7. Activate Version via POST /api/registry/models/[modelId]/versions/[version]/activate ──
    const actReq = new Request(`http://localhost:3000/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    });
    const actRes = await activateVersionHandler(actReq, { params: Promise.resolve({ modelId, version }) });
    expect(actRes.status).toBe(200);

    const activeModel = await getEffectiveModel(modelId);
    expect(activeModel.status).toBe('active');

    // ── 8. Call /api/monitor-upload on m03 ──
    const m03Req = new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        csvText: m03Text,
        fileName: 'm03_v2_2025-09_ระบบต้นทางมีปัญหา.csv',
      }),
    });
    const m03Res = await monitorUploadHandler(m03Req);
    expect(m03Res.status).toBe(200);
    const m03Data = await m03Res.json();

    expect(m03Data.validation.totalRows).toBe(1200);
    expect(m03Data.validation.validRows).toBe(1121);
    expect(m03Data.validation.rejectedRows).toBe(79); // EXACTLY 79 rejected rows
    expect(m03Data.validation.warningRows).toBeGreaterThan(0);
    expect(m03Data.validation.groups.some((g: any) => g.type === 'MISSING_VALUE' && g.severity === 'error')).toBe(true);
    expect(m03Data.trigger.action).toBe('INVESTIGATE_DATA');
    expect(m03Data.trigger.matchedRuleId).toBe('R1b');

    // ── 9. Call /api/monitor-upload on m04 ──
    const m04Req = new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        csvText: m04Text,
        fileName: 'm04_v2_2025-10_ส่งข้อมูลซ้ำ.csv',
      }),
    });
    const m04Res = await monitorUploadHandler(m04Req);
    expect(m04Res.status).toBe(200);
    const m04Data = await m04Res.json();

    expect(m04Data.validation.totalRows).toBe(1236);
    expect(m04Data.validation.validRows).toBe(1236);
    expect(m04Data.validation.rejectedRows).toBe(0); // EXACTLY 0 rejected rows (income 138,900 is warning, not error)
    expect(m04Data.validation.warningRows).toBe(37); // 36 duplicates + 1 income warning
    expect(m04Data.trigger.action).toBe('INVESTIGATE_DATA');
    expect(m04Data.trigger.matchedRuleId).toBe('R1b');
  });
});
