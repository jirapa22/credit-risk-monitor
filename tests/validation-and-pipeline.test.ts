import { beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../lib/csv';
import { validateDataset } from '../lib/validation';
import { runMonitoring } from '../lib/monitoring';
import { createMemoryStore, setStore } from '../lib/storage/store';
import { getEffectiveModel, listRuns, saveRun, saveThresholds } from '../lib/storage/repositories';
import modelConfig from '../app/model-config.json';
import type { FeatureDefinition, MonitoringRun } from '../lib/types';

const model = (modelConfig as any).models.ascore_v1;
const registry = model.featureRegistry as Record<string, FeatureDefinition>;
const opts = { scoringFeatures: model.scoring.features as string[], minRowsForDrift: 1 };

const HEADER = 'customer_id,application_date,monthly_income,loan_amount,dti_ratio,default_flag';
const v = (csv: string) => { const p = parseCsv(csv); return validateDataset(p.rows, p.headers, registry, { ...opts, malformedRows: p.malformedRows }); };

describe('CSV parser', () => {
  it('handles BOM, CRLF, quoted commas and escaped quotes', () => {
    const p = parseCsv('\uFEFFa,b,c\r\n"1,000","x ""y""",3\r\n\r\n');
    expect(p.headers).toEqual(['a', 'b', 'c']);
    expect(p.rows).toEqual([{ a: '1,000', b: 'x "y"', c: '3' }]);
    expect(p.malformedRows).toEqual([]);
  });
  it('reports rows with the wrong number of fields', () => {
    expect(parseCsv('a,b\n1,2,3\n4,5').malformedRows).toEqual([{ row: 1, expected: 2, actual: 3 }]);
  });
});

describe('data validation (separate from drift)', () => {
  it('blocks when a required column is missing, naming the column', () => {
    const { result } = v('customer_id,monthly_income,loan_amount\nA,20000,50000');
    expect(result.ok).toBe(false);
    expect(result.blockingErrors.map(e => e.column)).toContain('dti_ratio');
    expect(result.blockingErrors[0].message).toMatch(/ไม่พบคอลัมน์/);
  });

  it('rejects bad rows individually and keeps the good ones', () => {
    const { result, rows } = v([
      HEADER,
      'A,2025-01-05,20000,50000,0.30,0',     // ok
      'B,2025-01-05,abc,50000,0.30,0',       // INVALID_TYPE
      'C,2025-01-05,,50000,0.30,0',          // MISSING_VALUE
      'D,2025-01-05,20000,50000,25,0',       // OUT_OF_RANGE (dti max 10)
      'E,2025-01-05,20000,50000,0.30,7',     // INVALID_BINARY (warning — label not used for drift)
      'F,2025-13-40,"21,000",50000,0.30,1',  // INVALID_DATE warning, "21,000" accepted
      'A,2025-01-06,22000,52000,0.31,0',     // DUPLICATE_ID warning
      'G,2025-01-05,20000,50000',            // MALFORMED_ROW
    ].join('\n'));
    expect(result.totalRows).toBe(8);
    expect(rows.map(r => r.id)).toEqual(['A', 'E', 'F', 'A']);
    expect(result.validRows).toBe(4);
    const types = result.groups.map(g => `${g.type}:${g.severity}`);
    expect(types).toEqual(expect.arrayContaining([
      'INVALID_TYPE:error', 'MISSING_VALUE:error', 'OUT_OF_RANGE:error', 'MALFORMED_ROW:error',
      'INVALID_BINARY:warning', 'INVALID_DATE:warning', 'DUPLICATE_ID:warning',
    ]));
    expect(rows.find(r => r.id === 'F')!.values.monthly_income).toBe(21000);
    expect(rows.find(r => r.id === 'E')!.label).toBeNull();
    const oor = result.issues.find(i => i.type === 'OUT_OF_RANGE')!;
    expect(oor.row).toBe(4);
    expect(oor.message).toMatch(/นอกช่วง/);
  });

  it('blocks when too many rows are rejected', () => {
    const { result } = v([HEADER, 'A,,x,1,1,0', 'B,,y,1,1,0', 'C,,20000,50000,0.3,0'].join('\n'));
    expect(result.ok).toBe(false);
    expect(result.blockingErrors.some(e => /เกิน 50%/.test(e.message))).toBe(true);
  });

  it('empty file is blocked', () => {
    expect(v(HEADER).result.ok).toBe(false);
  });
});

describe('monitoring pipeline + storage', () => {
  beforeEach(() => setStore(createMemoryStore()));

  it('invalid file → run recorded with drift = null', async () => {
    const m = await getEffectiveModel();
    const { run } = runMonitoring({ model: m, fileName: 'bad.csv', csvText: 'x,y\n1,2' });
    expect(run.validation.ok).toBe(false);
    expect(run.drift).toBeNull();
  });

  it('valid file → PSI/CSI against the frozen reference, tagged with model version', async () => {
    const m = await getEffectiveModel();
    const rows = [HEADER];
    for (let i = 0; i < 300; i++) rows.push(`C${i},2025-02-01,${15000 + (i % 50) * 1500},${20000 + (i % 40) * 5000},${(0.05 + (i % 30) * 0.03).toFixed(3)},${i % 11 === 0 ? 1 : 0}`);
    const csv = rows.join('\n');
    const a = runMonitoring({ model: m, fileName: 'a.csv', csvText: csv });
    const b = runMonitoring({ model: m, fileName: 'a.csv', csvText: csv });
    expect(a.run.drift).not.toBeNull();
    expect(a.run.referenceId).toBe('ascore_v1_dev855');
    expect(a.run.model).toEqual({ modelId: 'ascore_v1', configVersion: m.configVersion });
    // same input → identical result (no random baseline)
    expect(a.run.drift!.psi.value).toBe(b.run.drift!.psi.value);
    expect(Object.keys(a.run.drift!.csi).sort()).toEqual(['dti_ratio', 'loan_amount', 'monthly_income']);
  });

  it('saving thresholds bumps configVersion and runs can be filtered by version', async () => {
    const m1 = await getEffectiveModel();
    const r1 = runMonitoring({ model: m1, fileName: 'x.csv', csvText: `${HEADER}\nA,2025-01-01,20000,50000,0.3,0` }).run;
    await saveRun(r1);
    await saveThresholds('ascore_v1', { ...m1.thresholds, psi_warning: 0.12 });
    const m2 = await getEffectiveModel();
    expect(m2.configVersion).not.toBe(m1.configVersion);
    expect(m2.thresholds.psi_warning).toBe(0.12);
    const r2 = runMonitoring({ model: m2, fileName: 'y.csv', csvText: `${HEADER}\nA,2025-01-01,20000,50000,0.3,0` }).run;
    await saveRun(r2);
    expect(await listRuns('monitoring', 'ascore_v1')).toHaveLength(2);
    const onlyV2 = await listRuns<MonitoringRun>('monitoring', 'ascore_v1', { configVersion: m2.configVersion });
    expect(onlyV2.map(r => r.fileName)).toEqual(['y.csv']);
  });
});
