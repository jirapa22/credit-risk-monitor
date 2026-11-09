import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, setStore } from '../lib/storage/store';
import {
  computeRowsSha256,
  createMemoryBlobStore,
  loadReferenceDatasetBlob,
  saveReferenceDatasetBlob,
  setBlobStore,
} from '../lib/storage/blob';
import {
  getActiveBaseline,
  getDefaultModelId,
  getModel,
  listBaselineVersions,
  loadReferenceProfile,
} from '../lib/storage/repositories';
import { validateBaseline } from '../lib/baselineValidation';
import { detectMultivariateAnomaliesDetailed, clearMultivariateCache } from '../lib/anomaly/multivariate';
import { toCsv } from '../lib/injection';
import type { BaselineVersion, FeatureDefinition } from '../lib/types';

// Import Registry & Monitoring API route handlers directly
import { GET as getModelsRoute } from '../app/api/registry/models/route';
import { GET as getModelDetailRoute } from '../app/api/registry/models/[modelId]/route';
import { POST as uploadReferenceRoute } from '../app/api/registry/references/route';
import { POST as createVersionRoute } from '../app/api/registry/models/[modelId]/versions/route';
import { POST as validateVersionRoute } from '../app/api/registry/models/[modelId]/versions/[version]/validate/route';
import { POST as activateVersionRoute } from '../app/api/registry/models/[modelId]/versions/[version]/activate/route';
import { POST as archiveVersionRoute } from '../app/api/registry/models/[modelId]/versions/[version]/archive/route';
import { GET as exportVersionRoute } from '../app/api/registry/models/[modelId]/versions/[version]/export/route';
import { POST as setDefaultRoute } from '../app/api/registry/default/route';
import { POST as importBaselineRoute } from '../app/api/registry/import/route';
import { POST as monitorUploadRoute } from '../app/api/monitor-upload/route';

/** Build deterministic synthetic rows for the second fake model (age, salary, utilization, is_bad, no date, no scorecard). */
function buildFakeModelRows(count: number, offset = 0): Record<string, string | number>[] {
  return Array.from({ length: count }, (_, idx) => {
    const i = idx + offset;
    const age = 22 + (i % 43);
    // Skewed salary distribution so skewness > 2 if not log1p
    const baseSalary = 18000 + ((i * 7919) % 45000);
    const highEarnerBoost = i % 20 === 0 ? 250000 + (i % 5) * 80000 : 0;
    const salary = baseSalary + highEarnerBoost;
    const utilization = +(((i * 17 + 11) % 96) / 100).toFixed(3);
    // Higher utilization -> higher default probability (~16% overall bad rate, >= 30 bads in 250 rows)
    const is_bad = utilization > 0.72 || (utilization > 0.55 && i % 3 === 0) ? 1 : 0;
    return {
      cust_id: `CUST_${String(i + 1).padStart(4, '0')}`,
      age,
      salary,
      utilization,
      is_bad,
    };
  });
}

const FAKE_FEATURE_REGISTRY: Record<string, FeatureDefinition> = {
  age: {
    columnName: 'age',
    displayName: 'อายุผู้กู้ (ปี)',
    dataType: 'numeric',
    required: true,
    monitoringEnabled: true,
  },
  salary: {
    columnName: 'salary',
    displayName: 'รายได้ต่อเดือน',
    dataType: 'numeric',
    required: true,
    monitoringEnabled: true,
    anomalyTransform: 'log1p',
  },
  utilization: {
    columnName: 'utilization',
    displayName: 'อัตราการใช้วงเงิน',
    dataType: 'numeric',
    required: true,
    monitoringEnabled: true,
  },
};

describe('Step 10a: Baseline Registry Backend (Lifecycle, Blob Storage, Validation)', () => {
  beforeEach(() => {
    setStore(createMemoryStore());
    setBlobStore(createMemoryBlobStore());
    clearMultivariateCache();
  });

  it('(1) ตอนเริ่มระบบ (ยังไม่มีอะไรใน KV): getActiveBaseline() คืน ascore_v1 ที่อ่านจากไฟล์เดิม และ dry-run validateBaseline ผ่าน', async () => {
    const defaultId = await getDefaultModelId();
    expect(defaultId).toBe('ascore_v1');

    const active = await getActiveBaseline();
    expect(active.modelId).toBe('ascore_v1');
    expect(active.version).toBe('1.1.0');
    expect(active.status).toBe('ACTIVE');
    expect(active.mode).toBe('scorecard');
    expect(active.referenceDatasetId).toBe('ascore_v1_dev855');
    expect(Object.keys(active.featureRegistry)).toHaveLength(5);

    // Dry-run validateBaseline on built-in ascore_v1
    const builtInBlob = await loadReferenceDatasetBlob('ascore_v1_dev855');
    expect(builtInBlob).not.toBeNull();
    const dryRunReport = validateBaseline(active, builtInBlob!);
    console.log('\n[Step 10a Dry-Run BaselineValidationReport — ascore_v1]');
    console.log(JSON.stringify(dryRunReport, null, 2));

    expect(dryRunReport.ok).toBe(true);
    expect(dryRunReport.errors).toHaveLength(0);
    expect(dryRunReport.computed.rowCount).toBe(855);
    expect(dryRunReport.computed.badRate).toBeCloseTo(80 / 855, 4);
    expect(dryRunReport.computed.performance).not.toBeNull();
    expect(dryRunReport.computed.performance!.auc).toBeGreaterThan(0.55);
  });

  it('(2) ขั้นตอนเต็มของ "โมเดลปลอมตัวที่สอง": อัปโหลด Reference CSV → สร้าง DRAFT → validate → activate → ตั้งเป็น default → เรียก /api/monitor-upload โดยไม่ส่ง modelId', async () => {
    const stepLog: Record<string, unknown>[] = [];
    const modelId = 'second_fake_model';
    const refId = 'second_fake_ref_v1';
    const refRows = buildFakeModelRows(250, 0);
    const refCsv = toCsv(refRows, ['cust_id', 'age', 'salary', 'utilization', 'is_bad']);

    // ขั้นที่ 1: อัปโหลด Reference CSV ผ่าน POST /api/registry/references
    const refRes = await uploadReferenceRoute(
      new Request('http://localhost/api/registry/references', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          referenceId: refId,
          modelId,
          version: '1.0.0',
          labelColumn: 'is_bad',
          csvText: refCsv,
          description: 'Reference dataset สำหรับโมเดลปลอมตัวที่สอง (ไม่มีวันที่ ไม่มีคะแนน)',
        }),
      }),
    );
    expect(refRes.status).toBe(201);
    const refBody = await refRes.json();
    expect(refBody.meta.referenceId).toBe(refId);
    expect(refBody.meta.rowCount).toBe(250);
    expect(typeof refBody.sha256).toBe('string');
    expect(refBody.sha256.length).toBe(64);
    stepLog.push({
      step: '1. POST /api/registry/references',
      status: refRes.status,
      referenceId: refBody.meta.referenceId,
      rowCount: refBody.meta.rowCount,
      badCount: refBody.meta.badCount,
      badRate: refBody.meta.badRate,
      sha256: refBody.sha256.slice(0, 16) + '...',
      detectedColumns: refBody.columns.map((c: any) => `${c.column}:${c.inferredType}`).join(', '),
    });

    // ขั้นที่ 2: สร้าง DRAFT version 1.0.0 (โหมด score_column แต่ไม่มี scoreColumn, มีแค่ age/salary/utilization, labelColumn='is_bad', ไม่มีวันที่)
    const createRes = await createVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.0',
          name: 'Second Fake Model (No Scorecard / No Date)',
          description: 'โมเดลปลอมตัวที่สองสำหรับทดสอบความยืดหยุ่นของ Baseline Registry',
          mode: 'score_column',
          columns: {
            idColumn: 'cust_id',
            labelColumn: 'is_bad',
            // ไม่มี dateColumn และไม่มี scoreColumn
          },
          scoreDirection: 'higher_is_safer',
          featureRegistry: FAKE_FEATURE_REGISTRY,
          referenceDatasetId: refId,
          createdBy: 'unit_tester',
        }),
      }),
      { params: { modelId } },
    );
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.baseline.status).toBe('DRAFT');
    stepLog.push({
      step: '2. POST /api/registry/models/[id]/versions',
      status: createRes.status,
      version: createBody.baseline.version,
      baselineStatus: createBody.baseline.status,
      mode: createBody.baseline.mode,
    });

    // ขั้นที่ 3: Validate DRAFT → ต้องผ่าน (ok: true), สถานะเปลี่ยนเป็น VALIDATED, มี warning เรื่องไม่มี score/ใช้ quantile bins อัตโนมัติ
    const valRes = await validateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/validate`, {
        method: 'POST',
      }),
      { params: { modelId, version: '1.0.0' } },
    );
    expect(valRes.status).toBe(200);
    const valBody = await valRes.json();
    console.log('\n[Step 10a Fake Model BaselineValidationReport — second_fake_model@1.0.0]');
    console.log(JSON.stringify(valBody.validationReport, null, 2));

    expect(valBody.ok).toBe(true);
    expect(valBody.status).toBe('VALIDATED');
    expect(valBody.validationReport.errors).toHaveLength(0);
    const warningCodes = valBody.validationReport.warnings.map((w: any) => w.code);
    expect(warningCodes).toContain('NO_SCORE_COLUMN_CSI_ONLY');
    expect(warningCodes).toContain('AUTO_QUANTILE_BINS');
    expect(Object.keys(valBody.validationReport.computed.autoGeneratedBins)).toEqual([
      'age',
      'salary',
      'utilization',
    ]);
    stepLog.push({
      step: '3. POST /validate',
      status: valRes.status,
      ok: valBody.ok,
      baselineStatus: valBody.status,
      warnings: warningCodes.join(', '),
      autoBinsFeatures: Object.keys(valBody.validationReport.computed.autoGeneratedBins).join(', '),
    });

    // ขั้นที่ 4: Activate เวอร์ชัน 1.0.0 → สถานะเปลี่ยนเป็น ACTIVE
    const actRes = await activateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/activate`, {
        method: 'POST',
      }),
      { params: { modelId, version: '1.0.0' } },
    );
    expect(actRes.status).toBe(200);
    const actBody = await actRes.json();
    expect(actBody.baseline.status).toBe('ACTIVE');
    stepLog.push({
      step: '4. POST /activate',
      status: actRes.status,
      baselineStatus: actBody.baseline.status,
      archivedVersion: actBody.archivedVersion,
    });

    // ขั้นที่ 5: ตั้งเป็น Default Model ผ่าน POST /api/registry/default
    const defRes = await setDefaultRoute(
      new Request('http://localhost/api/registry/default', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId }),
      }),
    );
    expect(defRes.status).toBe(200);
    const defBody = await defRes.json();
    expect(defBody.defaultModelId).toBe(modelId);
    stepLog.push({
      step: '5. POST /api/registry/default',
      status: defRes.status,
      defaultModelId: defBody.defaultModelId,
    });

    // ขั้นที่ 6: เรียก POST /api/monitor-upload โดยไม่ส่ง modelId (ใช้ default model อัตโนมัติ)
    const uploadRows = buildFakeModelRows(200, 50);
    const uploadCsv = toCsv(uploadRows, ['cust_id', 'age', 'salary', 'utilization', 'is_bad']);
    const monRes = await monitorUploadRoute(
      new Request('http://localhost/api/monitor-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'second_fake_batch_01.csv',
          csvText: uploadCsv,
        }),
      }),
    );
    expect(monRes.status).toBe(200);
    const monBody = await monRes.json();
    expect(monBody.run.model.modelId).toBe(modelId);
    expect(monBody.run.model.configVersion).toBe('1.0.0');
    expect(monBody.run.referenceId).toBe(refId);
    expect(monBody.run.driftReport.covariate.metrics.score.status).toBe('NOT_AVAILABLE');
    expect(Object.keys(monBody.run.drift.csi)).toEqual(['age', 'salary', 'utilization']);
    expect(monBody.run.driftReport.covariate.status).toBe('STABLE');
    expect(monBody.run.driftReport.label.status).toBe('STABLE');
    expect(monBody.run.driftReport.concept.metrics.performance.status).toBe('NOT_AVAILABLE');
    expect(monBody.run.trigger.action).toBe('CONTINUE');
    stepLog.push({
      step: '6. POST /api/monitor-upload (no modelId)',
      status: monRes.status,
      runModelId: monBody.run.model.modelId,
      configVersion: monBody.run.model.configVersion,
      referenceId: monBody.run.referenceId,
      scoreDriftStatus: monBody.run.driftReport.covariate.metrics.score.status,
      csiFeatures: Object.keys(monBody.run.drift.csi).join(', '),
      triggerAction: monBody.run.trigger.action,
    });

    console.log('\n[Step 10a Test (2) Step-by-Step Execution Log]');
    console.table(stepLog);
  });

  it('(3) สร้าง v2.0.0 ของโมเดลเดียวกัน → validate → activate → v1.0.0 ต้องเปลี่ยนเป็น ARCHIVED อัตโนมัติ และมี statusHistory ครบ', async () => {
    const modelId = 'auto_loan_v1';
    const refId = 'auto_loan_ref_250';
    const rows = buildFakeModelRows(250, 0);
    await saveReferenceDatasetBlob({
      meta: {
        referenceId: refId,
        version: '1.0.0',
        modelId,
        description: 'Auto loan reference',
        source: 'unit-test',
        createdAt: new Date().toISOString(),
        rowCount: rows.length,
        badCount: 40,
        badRate: 40 / 250,
        periodStart: '',
        periodEnd: '',
        columns: ['cust_id', 'age', 'salary', 'utilization', 'is_bad'],
        sha256: computeRowsSha256(rows),
      },
      rows,
    });

    // สร้าง v1.0.0 -> validate -> activate
    await createVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.0',
          name: 'Auto Loan v1.0.0',
          mode: 'score_column',
          columns: { idColumn: 'cust_id', labelColumn: 'is_bad' },
          featureRegistry: FAKE_FEATURE_REGISTRY,
          referenceDatasetId: refId,
        }),
      }),
      { params: { modelId } },
    );
    await validateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/validate`, { method: 'POST' }),
      { params: { modelId, version: '1.0.0' } },
    );
    await activateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/activate`, { method: 'POST' }),
      { params: { modelId, version: '1.0.0' } },
    );

    // สร้าง v2.0.0 -> validate -> activate
    await createVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: '2.0.0',
          name: 'Auto Loan v2.0.0',
          mode: 'score_column',
          columns: { idColumn: 'cust_id', labelColumn: 'is_bad' },
          featureRegistry: FAKE_FEATURE_REGISTRY,
          referenceDatasetId: refId,
        }),
      }),
      { params: { modelId } },
    );
    await validateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/2.0.0/validate`, { method: 'POST' }),
      { params: { modelId, version: '2.0.0' } },
    );
    const actV2Res = await activateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/2.0.0/activate`, { method: 'POST' }),
      { params: { modelId, version: '2.0.0' } },
    );
    expect(actV2Res.status).toBe(200);
    const actV2Body = await actV2Res.json();
    expect(actV2Body.archivedVersion).toBe('1.0.0');

    const versions = await listBaselineVersions(modelId);
    const v1 = versions.find(v => v.version === '1.0.0')!;
    const v2 = versions.find(v => v.version === '2.0.0')!;
    expect(v1.status).toBe('ARCHIVED');
    expect(v2.status).toBe('ACTIVE');
    expect(versions.filter(v => v.status === 'ACTIVE')).toHaveLength(1);

    // ตรวจ statusHistory ของ v1.0.0 ต้องมี DRAFT -> VALIDATED -> ACTIVE -> ARCHIVED
    expect(v1.statusHistory.map(h => h.to)).toEqual(['DRAFT', 'VALIDATED', 'ACTIVE', 'ARCHIVED']);
    expect(v2.statusHistory.map(h => h.to)).toEqual(['DRAFT', 'VALIDATED', 'ACTIVE']);

    const modelMeta = await getModel(modelId);
    expect(modelMeta?.activeVersion?.version).toBe('2.0.0');
  });

  it('(4) พยายาม activate เวอร์ชันที่ยังเป็น DRAFT → ต้องได้ error 400', async () => {
    const modelId = 'draft_only_model';
    const refId = 'draft_ref';
    const rows = buildFakeModelRows(220, 0);
    await saveReferenceDatasetBlob({
      meta: {
        referenceId: refId,
        version: '1.0.0',
        modelId,
        description: 'Draft test ref',
        source: 'unit-test',
        createdAt: new Date().toISOString(),
        rowCount: rows.length,
        badCount: 35,
        badRate: 35 / 220,
        periodStart: '',
        periodEnd: '',
        columns: ['cust_id', 'age', 'salary', 'utilization', 'is_bad'],
        sha256: computeRowsSha256(rows),
      },
      rows,
    });

    await createVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.0',
          name: 'Unvalidated Draft',
          mode: 'score_column',
          columns: { idColumn: 'cust_id', labelColumn: 'is_bad' },
          featureRegistry: FAKE_FEATURE_REGISTRY,
          referenceDatasetId: refId,
        }),
      }),
      { params: { modelId } },
    );

    const actRes = await activateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/activate`, {
        method: 'POST',
      }),
      { params: { modelId, version: '1.0.0' } },
    );
    expect(actRes.status).toBe(400);
    const actBody = await actRes.json();
    expect(actBody.error).toContain('VALIDATED');
  });

  it('(5) Reference ที่มี < 200 แถว หรือขาดคอลัมน์ใน featureRegistry → validate ต้อง ok: false และคงสถานะ DRAFT', async () => {
    const modelId = 'invalid_ref_model';
    const smallRefId = 'too_few_rows_ref';
    // 120 แถว (< 200) และขาดคอลัมน์ utilization
    const smallRows = buildFakeModelRows(120, 0).map(({ utilization: _u, ...rest }) => rest);
    await saveReferenceDatasetBlob({
      meta: {
        referenceId: smallRefId,
        version: '1.0.0',
        modelId,
        description: 'Small & incomplete reference',
        source: 'unit-test',
        createdAt: new Date().toISOString(),
        rowCount: smallRows.length,
        badCount: 20,
        badRate: 20 / 120,
        periodStart: '',
        periodEnd: '',
        columns: ['cust_id', 'age', 'salary', 'is_bad'],
        sha256: computeRowsSha256(smallRows),
      },
      rows: smallRows,
    });

    await createVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.0',
          name: 'Invalid Baseline Model',
          mode: 'score_column',
          columns: { idColumn: 'cust_id', labelColumn: 'is_bad' },
          featureRegistry: FAKE_FEATURE_REGISTRY,
          referenceDatasetId: smallRefId,
        }),
      }),
      { params: { modelId } },
    );

    const valRes = await validateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/validate`, {
        method: 'POST',
      }),
      { params: { modelId, version: '1.0.0' } },
    );
    expect(valRes.status).toBe(200);
    const valBody = await valRes.json();
    expect(valBody.ok).toBe(false);
    expect(valBody.status).toBe('DRAFT');
    const errorCodes = valBody.validationReport.errors.map((e: any) => e.code);
    expect(errorCodes).toContain('INSUFFICIENT_ROWS');
    expect(errorCodes).toContain('MISSING_FEATURE_COLUMN');
  });

  it('(6) พยายามแก้หรือ archive built-in ascore_v1 หรือเขียนทับ Reference ascore_v1_dev855 → ต้องได้ error 403', async () => {
    // 1. พยายามสร้างเวอร์ชันใหม่ทับหรือเพิ่มใน ascore_v1
    const createBuiltInRes = await createVersionRoute(
      new Request('http://localhost/api/registry/models/ascore_v1/versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.1',
          name: 'Attempted modification',
          featureRegistry: FAKE_FEATURE_REGISTRY,
          referenceDatasetId: 'ascore_v1_dev855',
        }),
      }),
      { params: { modelId: 'ascore_v1' } },
    );
    expect(createBuiltInRes.status).toBe(403);

    // 2. พยายาม archive ascore_v1@1.0.0
    const archiveBuiltInRes = await archiveVersionRoute(
      new Request('http://localhost/api/registry/models/ascore_v1/versions/1.0.0/archive', {
        method: 'POST',
      }),
      { params: { modelId: 'ascore_v1', version: '1.0.0' } },
    );
    expect(archiveBuiltInRes.status).toBe(403);

    // 3. พยายามเขียนทับ Reference ascore_v1_dev855
    const overwriteRefRes = await uploadReferenceRoute(
      new Request('http://localhost/api/registry/references', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          referenceId: 'ascore_v1_dev855',
          csvText: 'customer_id,age\n1,30',
        }),
      }),
    );
    expect(overwriteRefRes.status).toBe(403);
  });

  it('(7) export Baseline เป็น JSON → ลบ store → import กลับมา → validate → ใช้งานได้เหมือนเดิมและ sha256 ตรงกัน', async () => {
    const modelId = 'portable_model';
    const refId = 'portable_ref_v1';
    const rows = buildFakeModelRows(230, 10);
    const csvText = toCsv(rows, ['cust_id', 'age', 'salary', 'utilization', 'is_bad']);

    const upRes = await uploadReferenceRoute(
      new Request('http://localhost/api/registry/references', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          referenceId: refId,
          modelId,
          version: '1.0.0',
          labelColumn: 'is_bad',
          csvText,
        }),
      }),
    );
    const upBody = await upRes.json();
    const originalSha = upBody.sha256;

    await createVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.0',
          name: 'Portable Model v1',
          mode: 'score_column',
          columns: { idColumn: 'cust_id', labelColumn: 'is_bad' },
          featureRegistry: FAKE_FEATURE_REGISTRY,
          referenceDatasetId: refId,
        }),
      }),
      { params: { modelId } },
    );

    // Export bundle
    const expRes = await exportVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/export`),
      { params: { modelId, version: '1.0.0' } },
    );
    expect(expRes.status).toBe(200);
    const exportedBundle = await expRes.json();
    expect(exportedBundle.reference.meta.sha256).toBe(originalSha);

    // ล้างทั้ง KV store และ Blob store
    setStore(createMemoryStore());
    setBlobStore(createMemoryBlobStore());
    expect(await getModel(modelId)).toBeNull();

    // Import กลับมา
    const impRes = await importBaselineRoute(
      new Request('http://localhost/api/registry/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exportedBundle),
      }),
    );
    expect(impRes.status).toBe(201);
    const impBody = await impRes.json();
    expect(impBody.baseline.status).toBe('DRAFT');
    expect(impBody.baseline.modelId).toBe(modelId);

    // ตรวจว่า sha256 ของ Reference ที่ import กลับมาตรงกับของเดิม
    const rehydratedBlob = await loadReferenceDatasetBlob(refId);
    expect(rehydratedBlob).not.toBeNull();
    expect(rehydratedBlob!.meta.sha256).toBe(originalSha);

    // Validate & Activate แล้วใช้งานได้เหมือนเดิม
    const valRes = await validateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/validate`, {
        method: 'POST',
      }),
      { params: { modelId, version: '1.0.0' } },
    );
    const valBody = await valRes.json();
    expect(valBody.ok).toBe(true);
    expect(valBody.status).toBe('VALIDATED');

    const actRes = await activateVersionRoute(
      new Request(`http://localhost/api/registry/models/${modelId}/versions/1.0.0/activate`, {
        method: 'POST',
      }),
      { params: { modelId, version: '1.0.0' } },
    );
    expect(actRes.status).toBe(200);

    // ตรวจ GET /api/registry/models และ GET /api/registry/models/[modelId]
    const listRes = await getModelsRoute();
    const listBody = await listRes.json();
    expect(listBody.models.some((m: any) => m.modelId === modelId)).toBe(true);

    const detailRes = await getModelDetailRoute(
      new Request(`http://localhost/api/registry/models/${modelId}`),
      { params: { modelId } },
    );
    const detailBody = await detailRes.json();
    expect(detailBody.activeBaseline.version).toBe('1.0.0');
  });

  it('(8) เปลี่ยน Reference → sha256 เปลี่ยน → cache ของ IF/LOF ไม่ใช้ตัวเดิม (ตรวจว่า fit ใหม่)', async () => {
    const refId = 'mutable_ref_for_cache_test';
    const baseline: BaselineVersion = {
      modelId: 'cache_test_model',
      version: '1.0.0',
      name: 'Cache Test Model',
      description: 'Tests IF/LOF cache invalidation when Reference sha256 changes',
      status: 'ACTIVE',
      mode: 'score_column',
      columns: { idColumn: 'cust_id', labelColumn: 'is_bad' },
      scoreDirection: 'higher_is_safer',
      featureRegistry: FAKE_FEATURE_REGISTRY,
      thresholds: { psi_warning: 0.1, psi_critical: 0.25, gini_min: 0.1, auc_min: 0.55, ks_min: 0.1, csi_features: {} },
      referenceDatasetId: refId,
      createdAt: new Date().toISOString(),
      createdBy: 'test',
      statusHistory: [],
    };

    const rowsA = buildFakeModelRows(210, 0);
    const savedA = await saveReferenceDatasetBlob({
      meta: {
        referenceId: refId,
        version: '1.0.0',
        modelId: baseline.modelId,
        description: 'Dataset A',
        source: 'unit-test',
        createdAt: new Date().toISOString(),
        rowCount: rowsA.length,
        badCount: 34,
        badRate: 34 / 210,
        periodStart: '',
        periodEnd: '',
        columns: ['cust_id', 'age', 'salary', 'utilization', 'is_bad'],
        sha256: '',
      },
      rows: rowsA,
    });
    const profileA = await loadReferenceProfile(refId, baseline);
    expect(profileA.meta.sha256).toBe(savedA.meta.sha256);

    // ครั้งที่ 1 บน Dataset A: ต้อง fit ใหม่ (cached === false)
    const run1 = detectMultivariateAnomaliesDetailed(profileA, [], FAKE_FEATURE_REGISTRY);
    expect(run1.timing.cached).toBe(false);

    // ครั้งที่ 2 บน Dataset A เดิม: ต้องได้จาก cache (cached === true)
    const run2 = detectMultivariateAnomaliesDetailed(profileA, [], FAKE_FEATURE_REGISTRY);
    expect(run2.timing.cached).toBe(true);

    // เปลี่ยนข้อมูลใน Reference เดิม (rowsB) -> sha256 เปลี่ยน
    const rowsB = buildFakeModelRows(210, 500);
    const savedB = await saveReferenceDatasetBlob({
      meta: {
        ...savedA.meta,
        description: 'Dataset B (updated rows)',
      },
      rows: rowsB,
    });
    expect(savedB.meta.sha256).not.toBe(savedA.meta.sha256);

    const profileB = await loadReferenceProfile(refId, baseline);
    expect(profileB.meta.sha256).toBe(savedB.meta.sha256);

    // ครั้งที่ 3 บน Dataset B (referenceId เดิมแต่ sha256 เปลี่ยน): ต้อง fit ใหม่ (cached === false)!
    const run3 = detectMultivariateAnomaliesDetailed(profileB, [], FAKE_FEATURE_REGISTRY);
    expect(run3.timing.cached).toBe(false);
  });
});
