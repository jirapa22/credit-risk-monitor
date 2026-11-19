import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpstashMockStore, setStore } from '../lib/storage/store';
import { createMemoryBlobStore, setBlobStore } from '../lib/storage/blob';
import { POST as referencesHandler } from '../app/api/registry/references/route';
import { POST as scorecardImportHandler } from '../app/api/registry/scorecard/import/route';
import { POST as createVersionHandler } from '../app/api/registry/models/[modelId]/versions/route';
import { POST as validateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/validate/route';
import { POST as activateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/activate/route';
import { POST as monitorUploadHandler } from '../app/api/monitor-upload/route';

describe('Validation 3-Tier Column Requirements Test (Item 3)', () => {
  const modelId = 'tier_test_model';
  const version = '1.0.0';
  const referenceId = 'tier_test_ref';

  beforeEach(async () => {
    setStore(new UpstashMockStore());
    setBlobStore(createMemoryBlobStore());

    // 1. Reference dataset with 3 features:
    // feat_req_card (in scorecard), feat_req_reg (required in registry), feat_opt (optional in registry)
    const refRows = [
      'app_ref_id,app_ref_date,feat_req_card,feat_req_reg,feat_opt,orig_score,bad_flag',
      ...Array.from({ length: 250 }, (_, i) => {
        const id = `ID_${i + 1}`;
        const dt = `2024-0${(i % 9) + 1}-15`;
        const c1 = 20 + (i % 30);
        const c2 = 1000 + i * 10;
        const c3 = 10 + (i % 50);
        const score = 500 + (i % 100);
        const bad = i % 10 === 0 ? 1 : 0;
        return `${id},${dt},${c1},${c2},${c3},${score},${bad}`;
      }),
    ].join('\n');

    await referencesHandler(new Request('http://localhost/api/registry/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceId,
        csvText: refRows,
        modelId,
        version: '1.0.0',
        description: 'Tier Test Reference',
        columns: {
          idColumn: 'app_ref_id',
          dateColumn: 'app_ref_date',
          labelColumn: 'bad_flag',
          scoreColumn: 'orig_score',
        },
      }),
    }));

    // 2. Scorecard using feat_req_card
    const modelTableText = [
      'variable,upper_bound,points,bin_label,woe,bad_rate,count',
      'base_points,,500,,,,',
      'feat_req_card,30,20,<=30,-0.2,0.05,75',
      'feat_req_card,,40,>30,0.3,0.15,75',
    ].join('\n');

    const scRes = await scorecardImportHandler(new Request('http://localhost/api/registry/scorecard/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvText: modelTableText, modelId, referenceId }),
    }));
    const scData = await scRes.json();

    // 3. Create Draft Baseline Version with 3 features:
    // - feat_req_card (scorecard variable -> implicitly required)
    // - feat_req_reg (def.required === true -> explicitly required)
    // - feat_opt (def.required === false -> optional / used if present)
    const createRes = await createVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Tier Test Model',
        description: 'Test model for 3-tier columns',
        mode: 'scorecard',
        scoreDirection: 'higher_is_safer',
        referenceDatasetId: referenceId,
        columns: {
          idColumn: 'app_ref_id',
          dateColumn: 'app_ref_date',
          labelColumn: 'bad_flag',
          scoreColumn: 'orig_score',
        },
        featureRegistry: {
          feat_req_card: { columnName: 'feat_req_card', displayName: 'Required Card Feat', dataType: 'numeric', required: true, monitoringEnabled: true },
          feat_req_reg: { columnName: 'feat_req_reg', displayName: 'Required Reg Feat', dataType: 'numeric', required: true, monitoringEnabled: true },
          feat_opt: { columnName: 'feat_opt', displayName: 'Optional Feat', dataType: 'numeric', required: false, monitoringEnabled: true },
        },
        scoring: scData.scoring,
        modelTable: scData.modelTable,
      }),
    }), { params: Promise.resolve({ modelId }) });
    expect(createRes.status).toBe(201);

    // 4. Validate & Activate
    const valRes = await validateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'admin' }),
    }), { params: Promise.resolve({ modelId, version }) });
    const valData = await valRes.json();
    expect(valRes.status).toBe(200);
    expect(valData.ok).toBe(true);

    const actRes = await activateVersionHandler(new Request(`http://localhost/api/registry/models/${modelId}/versions/${version}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'admin' }),
    }), { params: Promise.resolve({ modelId, version }) });
    expect(actRes.status).toBe(200);
  });

  afterEach(() => {
    setStore(undefined);
    setBlobStore(undefined);
  });

  it('rejects file when a required scorecard feature is missing (HTTP 422 with MISSING_COLUMN error)', async () => {
    // Missing feat_req_card
    const badCsv = [
      'app_ref_id,app_ref_date,feat_req_reg,feat_opt,bad_flag',
      ...Array.from({ length: 120 }, (_, i) => `ID_${i + 1},2025-01-15,1500,25,0`),
    ].join('\n');

    const res = await monitorUploadHandler(new Request('http://localhost/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvText: badCsv, fileName: 'missing_req.csv', modelId }),
    }));

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.validation.ok).toBe(false);
    expect(data.validation.blockingErrors.length).toBeGreaterThan(0);
    const missingColErr = data.validation.blockingErrors.find((e: any) => e.type === 'MISSING_COLUMN');
    expect(missingColErr).toBeDefined();
    expect(missingColErr.column).toBe('feat_req_card');
    expect(missingColErr.severity).toBe('error');
  });

  it('accepts file when an optional feature is missing (HTTP 200 with MISSING_COLUMN warning, excluded from activeCols)', async () => {
    // Missing optional feat_opt, but has feat_req_card and feat_req_reg
    const goodCsv = [
      'app_ref_id,app_ref_date,feat_req_card,feat_req_reg,bad_flag',
      ...Array.from({ length: 120 }, (_, i) => `ID_${i + 1},2025-01-15,25,1500,0`),
    ].join('\n');

    const res = await monitorUploadHandler(new Request('http://localhost/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvText: goodCsv, fileName: 'missing_opt.csv', modelId }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.validation.ok).toBe(true);

    // Confirms warning exists for the missing optional column
    const missingColWarn = data.validation.warnings.find((w: any) => w.type === 'MISSING_COLUMN');
    expect(missingColWarn).toBeDefined();
    expect(missingColWarn.column).toBe('feat_opt');
    expect(missingColWarn.severity).toBe('warning');

    // Confirms CSI is computed for present features (feat_req_card, feat_req_reg), but not feat_opt
    expect(data.drift).toBeDefined();
    expect(data.drift.csi.feat_req_card).toBeDefined();
    expect(data.drift.csi.feat_req_reg).toBeDefined();
    expect(data.drift.csi.feat_opt).toBeUndefined();
  });
});
