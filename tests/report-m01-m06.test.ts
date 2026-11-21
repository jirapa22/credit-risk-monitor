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
import { getEffectiveModel, getMonitoringRunDetail } from '../lib/storage/repositories';
import { buildRunReport } from '../lib/report/buildRunReport';
import type { FeatureDefinition } from '../lib/types';

describe('Per-run Drift Report for m01, m03, m05, m06 (Step 13 Acceptance)', () => {
  const root = join(__dirname, '..');
  const modelId = 'cashloan_v2_report_test';
  const version = '1.0.0';
  const referenceId = 'ref_cashloan_v2_report';

  beforeAll(async () => {
    setStore(createMemoryStore());
    setBlobStore(createMemoryBlobStore());

    // Setup cashloan_v2 model pipeline
    const baseText = readFileSync(join(root, 'samples/cashloan_v2/baseline_cashloan_v2_2024.csv'), 'utf8');
    const mtText = readFileSync(join(root, 'samples/cashloan_v2/model_table_cashloan.csv'), 'utf8');

    // 1. Upload reference
    await referencesHandler(new Request('http://localhost:3000/api/registry/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceId,
        csvText: baseText,
        modelId,
        version,
        description: 'Cash loan v2 baseline',
        labelColumn: 'default_12m',
      }),
    }));

    // 2. Suggestions
    const sugRes = await suggestHandler(new Request('http://localhost:3000/api/registry/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId, provider: 'heuristic' }),
    }));
    const sugData = await sugRes.json();

    const columnMapping: Record<string, { role: string; type: string }> = {};
    for (const c of sugData.columns) {
      columnMapping[c.column] = { role: c.role, type: c.type };
    }
    columnMapping['app_id'] = { role: 'id', type: 'text' };
    columnMapping['default_12m'] = { role: 'label', type: 'binary' };
    columnMapping['app_date'] = { role: 'date', type: 'date' };
    columnMapping['credit_score'] = { role: 'score', type: 'numeric' };

    const featureDefs: Record<string, any> = {};
    for (const fs of sugData.featureSettings ?? []) {
      featureDefs[fs.feature] = {
        displayName: fs.feature,
        description: fs.description,
        dataType: fs.dataType,
        minValue: fs.minValue ?? undefined,
        maxValue: fs.maxValue ?? undefined,
        rangeSource: (fs.minValue !== undefined || fs.maxValue !== undefined) ? 'auto' : undefined,
        missingStrategy: (fs.missingStrategy === 'fillMean' ? 'mean' : fs.missingStrategy === 'fillMedian' ? 'median' : fs.missingStrategy === 'fillMode' ? 'mode' : fs.missingStrategy === 'ignore' ? 'ignore' : 'reject'),
        allowedCategories: fs.categories ?? [],
        rareCategoryThreshold: 0.01,
        anomalyTransform: fs.anomalyTransform,
        outOfBoundCount: fs.outOfBoundCount,
      };
    }

    // 3. Import model table
    const mtRes = await importModelTableHandler(new Request('http://localhost:3000/api/registry/model-table/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId, csvText: mtText }),
    }));
    const mtData = await mtRes.json();

    for (const [col, update] of Object.entries(mtData.featureSettingsUpdates ?? {})) {
      if (featureDefs[col]) {
        featureDefs[col] = {
          ...featureDefs[col],
          usedInModel: true,
          required: true,
          missingStrategy: 'reject',
          binning: (update as any).binning ?? featureDefs[col].binning,
          categoryPools: (update as any).categoryPools ?? featureDefs[col].categoryPools,
          poolPoints: (update as any).poolPoints ?? featureDefs[col].poolPoints,
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

    // 4. Create Draft
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

    // 5. Validate & Activate
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

  it('generates accurate report for m01 (normal run -> CONTINUE, STABLE)', async () => {
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    const uploadRes = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: m01Text, fileName: 'm01_v2_2025-07_ปกติ.csv' }),
    }));
    expect(uploadRes.status).toBe(200);
    const data = await uploadRes.json();
    const runId = data.run.runId;

    const detailRes = await getMonitoringRunDetail(modelId, runId);
    expect(detailRes.run).toBeDefined();

    const report = buildRunReport(detailRes.run!, detailRes.detail);
    expect(report.header.fileName).toBe('m01_v2_2025-07_ปกติ.csv');
    expect(report.header.dataPeriod).toBe('2025-07');
    expect(report.summary.verdictStatus).toBe('STABLE');
    expect(report.summary.matchedRuleId).toBe('R9');
    expect(report.summary.triggerAction).toBe('CONTINUE');
    expect(report.summary.verdictReasonLine).toBe('การกระจายตัวของคะแนนและตัวแปรอยู่ในเกณฑ์ปกติ');
    expect(report.overallDrift.scorePsi).toBeLessThan(0.10);
    expect(report.overallDrift.scorePsi).toBeCloseTo(0.0139, 3);
    expect(report.performance.hasLabels).toBe(true);
    expect(report.performance.auc).toBeCloseTo(0.7459, 3);
    expect(report.footerNotes.disclaimer).not.toContain('Basel');
  });

  it('generates accurate report for m03 (corrupted data -> R1b INVESTIGATE_DATA, 79 rejected rows)', async () => {
    const m03Text = readFileSync(join(root, 'samples/cashloan_v2/m03_v2_2025-09_ระบบต้นทางมีปัญหา.csv'), 'utf8');
    const uploadRes = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: m03Text, fileName: 'm03_v2_2025-09_ระบบต้นทางมีปัญหา.csv' }),
    }));
    expect(uploadRes.status).toBe(200);
    const data = await uploadRes.json();
    const runId = data.run.runId;

    const detailRes = await getMonitoringRunDetail(modelId, runId);
    expect(detailRes.run).toBeDefined();

    const report = buildRunReport(detailRes.run!, detailRes.detail);
    expect(report.header.fileName).toBe('m03_v2_2025-09_ระบบต้นทางมีปัญหา.csv');
    expect(report.summary.verdictStatus).toBe('CRITICAL');
    expect(report.summary.triggerAction).toBe('INVESTIGATE_DATA');
    expect(report.summary.matchedRuleId).toBe('R1b');
    expect(report.summary.verdictReasonLine).toBe('เนื่องจาก CSI ของ occupation อยู่ระดับวิกฤต (occupation: หมวดใหม่ 52 แถว)');
    expect(report.dataQuality.rejectedRows).toBe(79);
    expect(report.dataQuality.totalRows).toBe(1200);
    expect(report.dataQuality.validRows).toBe(1121);
    expect(report.overallDrift.scorePsi).toBeCloseTo(0.0086, 3);
    expect(report.performance.hasLabels).toBe(true);
    expect(report.performance.auc).toBeCloseTo(0.7820, 3);
    expect(report.footerNotes.disclaimer).not.toContain('Basel');
  });

  it('generates accurate report for m05 (campaign shift -> R5 RECALIBRATE)', async () => {
    const m05Text = readFileSync(join(root, 'samples/cashloan_v2/m05_v2_2025-11_แคมเปญMobileApp.csv'), 'utf8');
    const uploadRes = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: m05Text, fileName: 'm05_v2_2025-11_แคมเปญMobileApp.csv' }),
    }));
    expect(uploadRes.status).toBe(200);
    const data = await uploadRes.json();
    const runId = data.run.runId;

    const detailRes = await getMonitoringRunDetail(modelId, runId);
    expect(detailRes.run).toBeDefined();

    const report = buildRunReport(detailRes.run!, detailRes.detail);
    expect(report.header.fileName).toBe('m05_v2_2025-11_แคมเปญMobileApp.csv');
    expect(report.summary.verdictStatus).toBe('CRITICAL');
    expect(report.summary.matchedRuleId).toBe('R5');
    expect(report.summary.triggerAction).toBe('RECALIBRATE');
    expect(report.summary.verdictReasonLine).toBe('เนื่องจาก CSI ของ channel, ncb_inquiries_6m อยู่ระดับวิกฤต');
    expect(report.overallDrift.scorePsi).toBeCloseTo(0.2103, 3);
    expect(report.overallDrift.hasLabelDrift).toBe(true);
    expect(report.overallDrift.labelActBadRate).not.toBe('N/A');
    expect(report.overallDrift.labelPValue).toBe('< 0.0001');
    expect(report.performance.hasLabels).toBe(true);
    expect(report.performance.auc).toBeCloseTo(0.737, 3);
    expect(report.performance.gini).toBeCloseTo(0.474, 3);
    expect(report.performance.ks).toBeCloseTo(0.351, 3);
    expect(report.footerNotes.disclaimer).not.toContain('Basel');
  });

  it('generates accurate report for m06 (slowdown -> R8 MONITOR_CLOSELY)', async () => {
    const m06Text = readFileSync(join(root, 'samples/cashloan_v2/m06_v2_2025-12_เศรษฐกิจชะลอตัว.csv'), 'utf8');
    const uploadRes = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, csvText: m06Text, fileName: 'm06_v2_2025-12_เศรษฐกิจชะลอตัว.csv' }),
    }));
    expect(uploadRes.status).toBe(200);
    const data = await uploadRes.json();
    const runId = data.run.runId;

    const detailRes = await getMonitoringRunDetail(modelId, runId);
    expect(detailRes.run).toBeDefined();

    const report = buildRunReport(detailRes.run!, detailRes.detail);
    expect(report.header.fileName).toBe('m06_v2_2025-12_เศรษฐกิจชะลอตัว.csv');
    expect(report.summary.verdictStatus).toBe('STABLE');
    expect(report.summary.matchedRuleId).toBe('R8');
    expect(report.summary.triggerAction).toBe('MONITOR_CLOSELY');
    expect(report.summary.verdictReasonLine).toBe('คะแนนและตัวแปรอยู่ในเกณฑ์ปกติ แต่พบการเปลี่ยนแปลงของ Bad Rate (ดูหัวข้อ Overall Drift)');
    expect(report.overallDrift.scorePsi).toBeCloseTo(0.0077, 3);
    expect(report.overallDrift.hasLabelDrift).toBe(true);
    expect(report.overallDrift.labelPValue).not.toBe('N/A');
    expect(report.performance.hasLabels).toBe(true);
    expect(report.performance.auc).toBeCloseTo(0.7602, 3);
    expect(report.footerNotes.disclaimer).not.toContain('Basel');
  });

  it('invariant: if evidence mentions AUC, report performance must have hasLabels=true and valid metrics', async () => {
    let m05MatchedAucText = '';
    for (const fn of [
      'm01_v2_2025-07_ปกติ.csv',
      'm03_v2_2025-09_ระบบต้นทางมีปัญหา.csv',
      'm05_v2_2025-11_แคมเปญMobileApp.csv',
      'm06_v2_2025-12_เศรษฐกิจชะลอตัว.csv',
    ]) {
      const csv = readFileSync(join(root, 'samples/cashloan_v2', fn), 'utf8');
      const uploadRes = await monitorUploadHandler(new Request('http://localhost:3000/api/monitor-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, csvText: csv, fileName: fn, onDuplicate: 'replace' }),
      }));
      const data = await uploadRes.json();
      const detailRes = await getMonitoringRunDetail(modelId, data.run.runId);
      const report = buildRunReport(detailRes.run!, detailRes.detail);

      const allEvidenceText = [
        ...(report.summary.reasons || []),
        detailRes.run?.driftReport?.concept?.reason || '',
      ].join(' ');

      const aucMatch = allEvidenceText.match(/AUC\s*=\s*[\d.]+/i);
      const mentionsAuc = Boolean(aucMatch);
      if (fn.includes('m05')) {
        expect(mentionsAuc).toBe(true);
        expect(aucMatch?.[0]).toBe('AUC=0.737');
        m05MatchedAucText = aucMatch?.[0] || '';
      }

      if (mentionsAuc) {
        expect(report.performance.hasLabels).toBe(true);
        expect(report.performance.auc).not.toBeNull();
        expect(report.performance.gini).not.toBeNull();
        expect(report.performance.ks).not.toBeNull();
      }
    }
    expect(m05MatchedAucText).toBe('AUC=0.737');
  });
});
