/**
 * Step 10c — Tests for Baseline Registry UI + Onboarding Wizard + Heuristic Suggestions + Scorecard Import/Export.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../lib/csv';
import { buildDatasetProfile, heuristicProvider } from '../lib/suggest/heuristic';
import { detectScoreDirection } from '../lib/suggest/scoreDirection';
import { generateSuggestions } from '../lib/suggest';
import {
  exportScorecardToCsv,
  importScorecardFromCsv,
  importScorecardFromBuffer,
} from '../lib/scorecardImport';
import {
  saveReferenceDatasetBlob,
  loadReferenceDatasetBlob,
} from '../lib/storage/blob';
import { calculateAScore } from '../lib/scoring';
import {
  createDraftBaselineVersion,
  validateBaselineVersion,
  activateBaselineVersion,
  getEffectiveConfig,
  getModel,
} from '../lib/storage/repositories';
import { runMonitoring } from '../lib/monitoring';

const ROOT = join(__dirname, '..');
const BASELINE_EXT_PATH = join(ROOT, 'samples', 'baseline_ext_model.csv');
const MONITOR_CLEAN_PATH = join(ROOT, 'samples', 'monitor_ext_clean.csv');
const MONITOR_DRIFT_PATH = join(ROOT, 'samples', 'monitor_ext_drift.csv');
const MONITOR_DIRTY_PATH = join(ROOT, 'samples', 'monitor_ext_dirty.csv');

function createMinimalXlsxBuffer(sheetXml: string, ssXml: string): Buffer {
  const files = [
    { name: 'xl/sharedStrings.xml', data: Buffer.from(ssXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ];
  const parts: Buffer[] = [];
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local header signature
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(comp.length, 18);
    header.writeUInt32LE(f.data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, nameBuf, comp);
  }
  return Buffer.concat(parts);
}

describe('Step 10c — Baseline Registry & Suggestions & Scorecard Import/Export', () => {
  let baselineCsvText: string;
  let parsedBaseline: ReturnType<typeof parseCsv>;

  beforeAll(() => {
    expect(existsSync(BASELINE_EXT_PATH)).toBe(true);
    expect(existsSync(MONITOR_CLEAN_PATH)).toBe(true);
    expect(existsSync(MONITOR_DRIFT_PATH)).toBe(true);
    expect(existsSync(MONITOR_DIRTY_PATH)).toBe(true);

    baselineCsvText = readFileSync(BASELINE_EXT_PATH, 'utf8');
    parsedBaseline = parseCsv(baselineCsvText);
  });

  describe('1. Heuristic Suggestions on baseline_ext_model.csv', () => {
    it('infers all column roles correctly with high confidence', async () => {
      const profile = buildDatasetProfile('ref_step10c_test', parsedBaseline.rows, parsedBaseline.headers);
      const suggestions = await heuristicProvider.suggestColumns(profile);
      const sugMap = Object.fromEntries(suggestions.map(s => [s.column, s]));

      // Roles check
      expect(sugMap.cust_no?.role).toBe('id');
      expect(sugMap.app_date?.role).toBe('date');
      expect(sugMap.pd_score?.role).toBe('score');
      expect(sugMap.flag_npl_90?.role).toBe('label');

      // Features check
      expect(sugMap['รายได้ต่อเดือน']?.role).toBe('feature');
      expect(sugMap['วงเงินสินเชื่อ']?.role).toBe('feature');
      expect(sugMap['สัดส่วนภาระหนี้']?.role).toBe('feature');
      expect(sugMap['กลุ่มอาชีพ']?.role).toBe('feature');

      // Categorical type detection
      expect(sugMap['กลุ่มอาชีพ']?.type).toBe('categorical');
    });

    it('detects score direction higher_is_riskier with AUC > 0.6', () => {
      const detected = detectScoreDirection(parsedBaseline.rows, 'pd_score', 'flag_npl_90');
      expect(detected).not.toBeNull();
      expect(detected!.direction).toBe('higher_is_riskier');
      expect(detected!.auc).toBeGreaterThan(0.60);
    });

    it('proposes clean rounded numbers for feature min/max', async () => {
      const profile = buildDatasetProfile('ref_step10c_test', parsedBaseline.rows, parsedBaseline.headers);
      const cols = await heuristicProvider.suggestColumns(profile);
      const settings = await heuristicProvider.suggestFeatureSettings(profile, cols);
      const setMap = Object.fromEntries(settings.map(s => [s.feature, s]));

      const incomeSetting = setMap['รายได้ต่อเดือน'];
      expect(incomeSetting).toBeDefined();
      expect(incomeSetting.minValue).toBeDefined();
      expect(incomeSetting.maxValue).toBeDefined();
      // Should be nice integers (e.g. 10000, 200000), not fractional noise like 10243.12
      expect(Number.isInteger(incomeSetting.minValue!)).toBe(true);
      expect(Number.isInteger(incomeSetting.maxValue!)).toBe(true);
      expect(incomeSetting.minValue! % 100).toBe(0);

      const dtiSetting = setMap['สัดส่วนภาระหนี้'];
      expect(dtiSetting).toBeDefined();
      // DTI min/max should be clean 2-decimal rounded numbers (e.g. 0.1, 0.8)
      expect(Number.isInteger(Math.round(dtiSetting.minValue! * 100))).toBe(true);
      expect(Number.isInteger(Math.round(dtiSetting.maxValue! * 100))).toBe(true);
    });
  });

  describe('2. Scorecard Export and Import', () => {
    it('exports ascore_v1 scorecard to CSV in the standard format and imports back with >= 99% match', async () => {
      const effective = await getEffectiveConfig();
      const ascoreModel = effective.models.ascore_v1;
      expect(ascoreModel?.scoring?.scorecard).toBeDefined();

      // Export
      const csvOutput = exportScorecardToCsv(ascoreModel.scoring);
      expect(csvOutput).toContain('variable,upper_bound,points,bin_label,woe,bad_rate,count');
      expect(csvOutput).toContain('base_points,');

      // Reference dataset for scoring comparison
      const blob = await loadReferenceDatasetBlob(ascoreModel.referenceDatasetId);
      expect(blob).not.toBeNull();
      const expectedScores = blob!.rows.map(r => calculateAScore(ascoreModel.scoring, r as any));

      // Import back
      const importResult = importScorecardFromCsv(csvOutput, {
        referenceRows: blob!.rows,
        referenceScores: expectedScores,
      });

      expect(importResult.ok).toBe(true);
      expect(importResult.errors).toHaveLength(0);
      expect(importResult.scoring.features.length).toBeGreaterThan(0);
      expect(importResult.scoreComparison).not.toBeNull();
      expect(importResult.scoreComparison!.matchWithinHalfPointPct).toBeGreaterThanOrEqual(99.0);
    });

    it('imports minimal .xlsx scorecard buffer correctly using built-in zlib without external xlsx package', () => {
      const ssXml = `<sst><si><t>variable</t></si><si><t>upper_bound</t></si><si><t>points</t></si><si><t>bin_label</t></si><si><t>base_points</t></si><si><t>feature_x</t></si><si><t>&lt; 50</t></si><si><t>&gt;= 50</t></si></sst>`;
      const sheetXml = `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
        <row r="2"><c r="A2" t="s"><v>4</v></c><c r="C2"><v>500</v></c></row>
        <row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3"><v>50</v></c><c r="C3"><v>25</v></c><c r="D3" t="s"><v>6</v></c></row>
        <row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4"></c><c r="C4"><v>-15</v></c><c r="D4" t="s"><v>7</v></c></row>
      </sheetData></worksheet>`;

      const xlsxBuffer = createMinimalXlsxBuffer(sheetXml, ssXml);
      const res = importScorecardFromBuffer(xlsxBuffer, 'test_card.xlsx');

      expect(res.ok).toBe(true);
      expect(res.scoring.base_points).toBe(500);
      expect(res.scoring.features).toEqual(['feature_x']);
      expect(res.scoring.scorecard.feature_x.points).toEqual([25, -15]);
      expect(res.scoring.scorecard.feature_x.bins).toEqual([50]);
    });
  });

  describe('3. Onboarding via Wizard Flow Simulation', () => {
    const testModelId = 'test_ext_onboard_v1';
    const testRefId = `ref_${testModelId}_test`;

    it('uploads reference, generates suggestions, saves draft, validates, and activates model', async () => {
      // Step 1: Save reference dataset
      await saveReferenceDatasetBlob({
        meta: {
          referenceId: testRefId,
          modelId: testModelId,
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          source: 'test',
          description: 'Step 10c test baseline',
          rowCount: parsedBaseline.rows.length,
          columns: parsedBaseline.headers,
          numericColumns: ['รายได้ต่อเดือน', 'วงเงินสินเชื่อ', 'สัดส่วนภาระหนี้', 'pd_score'],
          categoricalColumns: ['กลุ่มอาชีพ'],
          labelColumn: 'flag_npl_90',
          idColumn: 'cust_no',
          dateColumn: 'app_date',
        },
        rows: parsedBaseline.rows,
      });

      // Step 2 & 3: Suggestions
      const suggestions = await generateSuggestions({
        referenceId: testRefId,
        rows: parsedBaseline.rows,
        columns: parsedBaseline.headers,
      });
      expect(suggestions.columns.length).toBeGreaterThan(0);
      expect(suggestions.scoreDirection.direction).toBe('higher_is_riskier');

      // Step 4: Create draft
      const draft = await createDraftBaselineVersion(testModelId, {
        version: '1.0.0',
        name: 'โมเดลสินเชื่อบุคคลภายนอก (Step 10c Test)',
        description: 'Onboarded via Step 10c wizard flow',
        mode: 'score_column',
        scoreDirection: 'higher_is_riskier',
        referenceId: testRefId,
        columns: {
          idColumn: 'cust_no',
          dateColumn: 'app_date',
          labelColumn: 'flag_npl_90',
          scoreColumn: 'pd_score',
        },
        featureRegistry: {
          'รายได้ต่อเดือน': {
            name: 'รายได้ต่อเดือน',
            displayName: 'รายได้ต่อเดือน (บาท)',
            dataType: 'numeric',
            minValue: 5000,
            maxValue: 500000,
            missingStrategy: 'reject',
          },
          'วงเงินสินเชื่อ': {
            name: 'วงเงินสินเชื่อ',
            displayName: 'วงเงินสินเชื่อ',
            dataType: 'numeric',
            minValue: 10000,
            maxValue: 1000000,
            missingStrategy: 'reject',
          },
          'สัดส่วนภาระหนี้': {
            name: 'สัดส่วนภาระหนี้',
            displayName: 'สัดส่วนภาระหนี้ (DTI)',
            dataType: 'numeric',
            minValue: 0,
            maxValue: 1.5,
            missingStrategy: 'reject',
          },
          'กลุ่มอาชีพ': {
            name: 'กลุ่มอาชีพ',
            displayName: 'กลุ่มอาชีพ',
            dataType: 'categorical',
            missingStrategy: 'reject',
            allowedCategories: ['พนักงานบริษัท', 'ข้าราชการ', 'ค้าขาย', 'อาชีพอิสระ'],
            rareCategoryThreshold: 0.01,
          },
        },
      });

      expect(draft.status).toBe('DRAFT');

      // Step 5: Validate
      const { ok, version: validatedVer, report } = await validateBaselineVersion(testModelId, '1.0.0');
      expect(ok).toBe(true);
      expect(report.ok).toBe(true);
      expect(validatedVer.status).toBe('VALIDATED');
      expect(report.computed.rowCount).toBe(300);
      expect(report.computed.performance).not.toBeNull();
      expect(report.computed.performance!.auc).toBeGreaterThan(0.60);

      // Step 5: Activate
      const activatedVer = await activateBaselineVersion(testModelId, '1.0.0');
      expect(activatedVer.status).toBe('ACTIVE');

      const modelEntry = await getModel(testModelId);
      expect(modelEntry).not.toBeNull();
      expect(modelEntry!.activeVersion?.version).toBe('1.0.0');
    });
  });

  describe('4. Monitoring Runs with the New Model', () => {
    const testModelId = 'test_ext_onboard_v1';

    it('clean monitoring file produces PSI < 0.10 (STABLE)', async () => {
      const cleanCsv = readFileSync(MONITOR_CLEAN_PATH, 'utf8');
      const effective = await getEffectiveConfig(testModelId);
      const model = effective.models[testModelId];
      expect(model).toBeDefined();

      const { run } = runMonitoring({
        model,
        fileName: 'monitor_ext_clean.csv',
        csvText: cleanCsv,
      });

      expect(run.validation.ok).toBe(true);
      expect(run.drift).not.toBeNull();
      expect(run.drift!.psi.status).toBe('STABLE');
      expect(run.drift!.psi.value).toBeLessThan(0.10);
    });

    it('drifted monitoring file alerts WARNING or CRITICAL on PSI or CSI', async () => {
      const driftCsv = readFileSync(MONITOR_DRIFT_PATH, 'utf8');
      const effective = await getEffectiveConfig(testModelId);
      const model = effective.models[testModelId];

      const { run } = runMonitoring({
        model,
        fileName: 'monitor_ext_drift.csv',
        csvText: driftCsv,
      });

      expect(run.validation.ok).toBe(true);
      expect(run.drift).not.toBeNull();
      const isDriftAlerted =
        run.drift!.overallStatus === 'WARNING' ||
        run.drift!.overallStatus === 'CRITICAL' ||
        Object.values(run.drift!.csi).some(c => c.status === 'WARNING' || c.status === 'CRITICAL');
      expect(isDriftAlerted).toBe(true);
    });

    it('dirty monitoring file detects negative income, missing values, and unseen categories', async () => {
      const dirtyCsv = readFileSync(MONITOR_DIRTY_PATH, 'utf8');
      const effective = await getEffectiveConfig(testModelId);
      const model = effective.models[testModelId];

      const { run } = runMonitoring({
        model,
        fileName: 'monitor_ext_dirty.csv',
        csvText: dirtyCsv,
      });

      // Validation must catch errors (at least negative income and missing values)
      expect(run.validation.rejectedRows).toBeGreaterThanOrEqual(10);
      expect(run.validation.issues.some(iss => iss.type === 'OUT_OF_RANGE' || iss.message.includes('อยู่นอกช่วง'))).toBe(true);

      // Anomaly screening should flag unseen categories (astronaut / time_traveler) or outliers
      if (run.anomaly) {
        expect(run.anomaly.flaggedRowCount).toBeGreaterThan(0);
        expect(run.anomaly.byMethod.unseen_category ?? 0).toBeGreaterThan(0);
      }
    });
  });
});
