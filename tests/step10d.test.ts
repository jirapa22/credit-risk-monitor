/**
 * Step 10d — Tests for AI-Assisted Baseline Onboarding with Guardrails.
 *
 * All tests use injected mock clients / providers. NO real network calls to Anthropic.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../lib/csv';
import { buildDatasetProfile } from '../lib/suggest/heuristic';
import {
  AiSuggestionProvider,
  buildAiPayload,
  maskSensitiveSample,
} from '../lib/suggest/ai';
import { CombinedSuggestionProvider } from '../lib/suggest/combined';
import { verifyNumberGrounding } from '../lib/suggest/grounding';
import { extractScorecardWithAi } from '../lib/suggest/scorecardExtract';
import { generateSuggestions } from '../lib/suggest';
import { GET as getAiStatusRoute } from '../app/api/ai/status/route';
import { loadReferenceDatasetBlob } from '../lib/storage/blob';
import { calculateAScore } from '../lib/scoring';
import { getEffectiveConfig } from '../lib/storage/repositories';
import type { BaselineValidationReport } from '../lib/types';

const ROOT = join(__dirname, '..');
const BASELINE_EXT_PATH = join(ROOT, 'samples', 'baseline_ext_model.csv');
const ASCOREREPORT_PATH = join(ROOT, 'ascore_model_report.xlsx');

describe('Step 10d — AI-assisted Baseline Onboarding Guardrails', () => {
  let baselineRows: Record<string, unknown>[];
  let baselineHeaders: string[];

  beforeEach(() => {
    const csv = readFileSync(BASELINE_EXT_PATH, 'utf8');
    const parsed = parseCsv(csv);
    baselineRows = parsed.rows;
    baselineHeaders = parsed.headers;
  });

  // ── (1) AI Invalid Outputs -> Fallback to Heuristic per item ───────────────
  it('(1) falls back to heuristic for invalid column, role, type, or non-binary label', async () => {
    const profile = buildDatasetProfile('test_ref', baselineRows, baselineHeaders);

    // Mock client returning corrupted / hallucinatory suggestions
    const mockClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              name: 'provide_column_suggestions',
              input: {
                suggestions: [
                  {
                    column: 'cust_no',
                    role: 'id',
                    type: 'string',
                    confidence: 0.95,
                    reason: 'รหัสอ้างอิงลูกค้า',
                  },
                  // Nonexistent column
                  {
                    column: 'phantom_unseen_col',
                    role: 'feature',
                    type: 'numeric',
                    confidence: 0.9,
                    reason: 'คอลัมน์ผีที่ไม่มีในไฟล์',
                  },
                  // Invalid role
                  {
                    column: 'app_date',
                    role: 'invalid_super_role',
                    type: 'date',
                    confidence: 0.9,
                    reason: 'บทบาทที่ไม่มีในระบบ',
                  },
                  // Invalid type
                  {
                    column: 'วงเงินสินเชื่อ',
                    role: 'feature',
                    type: 'super_quantum_number',
                    confidence: 0.9,
                    reason: 'ชนิดข้อมูลผิด',
                  },
                  // Continuous numeric assigned as label (violates binary 0/1 rule)
                  {
                    column: 'รายได้ต่อเดือน',
                    role: 'label',
                    type: 'numeric',
                    confidence: 0.99,
                    reason: 'เดาผิดให้เงินเดือนเป็น label',
                  },
                ],
              },
            },
          ],
          usage: { input_tokens: 150, output_tokens: 80 },
        }),
      },
    };

    const aiProvider = new AiSuggestionProvider({ client: mockClient as any });
    const suggestions = await aiProvider.suggestColumns(profile);
    const sugMap = Object.fromEntries(suggestions.map(s => [s.column, s]));

    // Valid item accepted
    expect(sugMap.cust_no.role).toBe('id');
    expect(sugMap.cust_no.reason).toBe('รหัสอ้างอิงลูกค้า');

    // Invalid role fell back to heuristic date
    expect(sugMap.app_date.role).toBe('date');
    expect(sugMap.app_date.reason).toContain('[AI Fallback]');

    // Invalid type fell back to heuristic numeric
    expect(sugMap['วงเงินสินเชื่อ'].type).toBe('numeric');
    expect(sugMap['วงเงินสินเชื่อ'].reason).toContain('[AI Fallback]');

    // Non-binary label fell back to heuristic feature
    expect(sugMap['รายได้ต่อเดือน'].role).toBe('feature');
    expect(sugMap['รายได้ต่อเดือน'].reason).toContain('[AI Fallback]');
    expect(sugMap['รายได้ต่อเดือน'].reason).toContain('ไม่ผ่านเกณฑ์ตัวแปรเป้าหมาย');
  });

  // ── (2) buildAiPayload: Strict PDPA Compliance ─────────────────────────────
  it('(2) buildAiPayload sends no row-level data, at most 5 sample values, and masks sensitive IDs', () => {
    const profile = buildDatasetProfile('test_ref', baselineRows, baselineHeaders);
    const payload = buildAiPayload(profile);

    // 1. Must not contain raw rows
    expect((payload as any).rows).toBeUndefined();
    expect(payload.rowCount).toBe(300);
    expect(payload.columns.length).toBe(baselineHeaders.length);

    // 2. Sample values <= 5 per column
    for (const c of payload.columns) {
      expect(c.sampleValues.length).toBeLessThanOrEqual(5);
    }

    // 3. ID column sample values must be masked
    const idCol = payload.columns.find(c => c.column === 'cust_no');
    expect(idCol).toBeDefined();
    for (const sample of idCol!.sampleValues) {
      expect(String(sample)).toMatch(/^EXT\*{3}$/);
      expect(String(sample)).not.toMatch(/^EXT\d{4}$/); // raw full ID must not leak
    }

    // Direct masking unit test
    expect(maskSensitiveSample('0812345678', true)).toBe('081***');
    expect(maskSensitiveSample('somchai@testbank.com')).toBe('so***@***.com');
    expect(maskSensitiveSample('1100501234567', true)).toBe('110***');
  });

  // ── (3) Number Grounding: Hallucinated Numbers are Discarded ────────────────
  it('(3) number grounding verifies numbers against report and discards hallucinated numbers', () => {
    const mockReport: BaselineValidationReport = {
      ok: true,
      validatedAt: '2026-11-10T12:00:00.000Z',
      referenceId: 'ref_ascore_855',
      sha256: 'abc123sha',
      errors: [],
      warnings: [],
      computed: {
        rowCount: 855,
        hasLabels: true,
        labeledRowCount: 855,
        badCount: 80,
        badRate: 0.093567,
        performance: {
          auc: 0.7107,
          gini: 0.4213,
          ks: 0.3241,
          reliable: true,
          warnings: [],
        },
        autoGeneratedBins: {},
        featureSkewness: {},
        referenceFlaggedCount: 34,
        referenceFlaggedPct: 3.98,
        multivariateFitMs: 45.2,
      },
    };

    // Grounded text (all numbers exist in report)
    const validText =
      'โมเดลได้รับการตรวจสอบบนชุดข้อมูล 855 ราย พบลูกหนี้เสีย 80 ราย (9.36%) โดยมีค่า AUC เท่ากับ 0.71 และตรวจพบความผิดปกติ 34 รายการ';
    const validResult = verifyNumberGrounding(validText, mockReport);
    expect(validResult.grounded).toBe(true);
    expect(validResult.explanation).toBe(validText);
    expect(validResult.ungroundedNumbers).toHaveLength(0);

    // Hallucinated text (invented AUC 0.95 and 5000 rows)
    const hallucinatedText =
      'โมเดลมีความแม่นยำสูงมากด้วยค่า AUC ถึง 0.95 จากการประเมินกลุ่มตัวอย่าง 5000 รายการ';
    const badResult = verifyNumberGrounding(hallucinatedText, mockReport);
    expect(badResult.grounded).toBe(false);
    expect(badResult.explanation).toBe('AI อธิบายไม่ผ่านการตรวจ');
    expect(badResult.ungroundedNumbers).toContain(0.95);
    expect(badResult.ungroundedNumbers).toContain(5000);
  });

  // ── (4) Scorecard Extraction from Excel ─────────────────────────────────────
  it('(4) extracts scorecard from Excel with text bin labels: 100% match auto-accepts, wrong bin blocks auto-accept', async () => {
    expect(existsSync(ASCOREREPORT_PATH)).toBe(true);
    const xlsxBuffer = readFileSync(ASCOREREPORT_PATH);

    const effective = await getEffectiveConfig();
    const ascoreModel = effective.models.ascore_v1;
    const blob = await loadReferenceDatasetBlob(ascoreModel.referenceDatasetId);
    expect(blob).not.toBeNull();
    const expectedScores = blob!.rows.map(r => calculateAScore(ascoreModel.scoring, r as any));

    // (4a) Correct AI interpretation (matches ascore_model_report scorecard)
    const correctMockClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              name: 'submit_extracted_scorecard',
              input: {
                base_points: 554.2,
                rows: [
                  // monthly_income
                  { variable: 'monthly_income', upper_bound: 17800.0, points: -10.2, bin_label: '≤17,800' },
                  { variable: 'monthly_income', upper_bound: 22300.0, points: -2.1, bin_label: '17,801–22,300' },
                  { variable: 'monthly_income', upper_bound: 27520.0, points: -5.5, bin_label: '22,301–27,520' },
                  { variable: 'monthly_income', upper_bound: 36360.0, points: 13.4, bin_label: '27,521–36,360' },
                  { variable: 'monthly_income', upper_bound: null, points: 13.6, bin_label: '>36,360' },
                  // loan_amount
                  { variable: 'loan_amount', upper_bound: 46000.0, points: 13.3, bin_label: '≤46,000' },
                  { variable: 'loan_amount', upper_bound: 63000.0, points: 4.6, bin_label: '46,001–63,000' },
                  { variable: 'loan_amount', upper_bound: 81000.0, points: -4.5, bin_label: '63,001–81,000' },
                  { variable: 'loan_amount', upper_bound: 112000.0, points: 9.6, bin_label: '81,001–112,000' },
                  { variable: 'loan_amount', upper_bound: null, points: -13.6, bin_label: '>112,000' },
                  // dti_ratio
                  { variable: 'dti_ratio', upper_bound: 0.264, points: 22.4, bin_label: '≤0.264' },
                  { variable: 'dti_ratio', upper_bound: 0.36, points: 18.0, bin_label: '0.265–0.360' },
                  { variable: 'dti_ratio', upper_bound: 0.47, points: 17.8, bin_label: '0.361–0.470' },
                  { variable: 'dti_ratio', upper_bound: 0.606, points: -13.8, bin_label: '0.471–0.606' },
                  { variable: 'dti_ratio', upper_bound: null, points: -20.7, bin_label: '>0.606' },
                ],
              },
            },
          ],
        }),
      },
    };

    const resCorrect = await extractScorecardWithAi(xlsxBuffer, {
      referenceRows: blob!.rows,
      referenceScores: expectedScores,
      client: correctMockClient as any,
    });

    expect(resCorrect.ok).toBe(true);
    expect(resCorrect.extractedBy).toBe('ai');
    expect(resCorrect.scoreComparison).not.toBeNull();
    expect(resCorrect.scoreComparison!.matchWithinHalfPointPct).toBe(100.0);
    expect(resCorrect.scoreComparison!.maxAbsDiff).toBe(0.0);
    expect(resCorrect.autoAccepted).toBe(true);

    // (4b) Flawed AI interpretation (modified points on 1 bin by +20)
    const flawedMockClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              name: 'submit_extracted_scorecard',
              input: {
                base_points: 554.2,
                rows: [
                  // monthly_income: bin 1 flawed by +20 (9.8 instead of -10.2)
                  { variable: 'monthly_income', upper_bound: 17800.0, points: 9.8, bin_label: '≤17,800' },
                  { variable: 'monthly_income', upper_bound: 22300.0, points: -2.1, bin_label: '17,801–22,300' },
                  { variable: 'monthly_income', upper_bound: 27520.0, points: -5.5, bin_label: '22,301–27,520' },
                  { variable: 'monthly_income', upper_bound: 36360.0, points: 13.4, bin_label: '27,521–36,360' },
                  { variable: 'monthly_income', upper_bound: null, points: 13.6, bin_label: '>36,360' },
                  // loan_amount
                  { variable: 'loan_amount', upper_bound: 46000.0, points: 13.3, bin_label: '≤46,000' },
                  { variable: 'loan_amount', upper_bound: 63000.0, points: 4.6, bin_label: '46,001–63,000' },
                  { variable: 'loan_amount', upper_bound: 81000.0, points: -4.5, bin_label: '63,001–81,000' },
                  { variable: 'loan_amount', upper_bound: 112000.0, points: 9.6, bin_label: '81,001–112,000' },
                  { variable: 'loan_amount', upper_bound: null, points: -13.6, bin_label: '>112,000' },
                  // dti_ratio
                  { variable: 'dti_ratio', upper_bound: 0.264, points: 22.4, bin_label: '≤0.264' },
                  { variable: 'dti_ratio', upper_bound: 0.36, points: 18.0, bin_label: '0.265–0.360' },
                  { variable: 'dti_ratio', upper_bound: 0.47, points: 17.8, bin_label: '0.361–0.470' },
                  { variable: 'dti_ratio', upper_bound: 0.606, points: -13.8, bin_label: '0.471–0.606' },
                  { variable: 'dti_ratio', upper_bound: null, points: -20.7, bin_label: '>0.606' },
                ],
              },
            },
          ],
        }),
      },
    };

    const resFlawed = await extractScorecardWithAi(xlsxBuffer, {
      referenceRows: blob!.rows,
      referenceScores: expectedScores,
      client: flawedMockClient as any,
    });

    expect(resFlawed.ok).toBe(true);
    expect(resFlawed.scoreComparison!.matchWithinHalfPointPct).toBeLessThan(99.0);
    expect(resFlawed.autoAccepted).toBe(false);
    expect(resFlawed.warnings.some(w => w.includes('< 99%'))).toBe(true);
  });

  // ── (5) No ANTHROPIC_API_KEY -> available = false and uses heuristic ───────
  it('(5) when ANTHROPIC_API_KEY is not set, /api/ai/status reports unavailable and suggest uses heuristic smoothly', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;

      const statusRes = await getAiStatusRoute();
      const statusData = await statusRes.json();
      expect(statusData.available).toBe(false);
      expect(statusData.model).toBeDefined();
      expect(statusData.provider).toBe('claude');
      expect((statusData as any).apiKey).toBeUndefined(); // NEVER exposes key

      const result = await generateSuggestions({
        referenceId: 'ref_no_key_test',
        rows: baselineRows,
        columns: baselineHeaders,
        providerType: 'auto',
      });

      expect(result.provider).toBe('heuristic');
      expect(result.columns.length).toBe(baselineHeaders.length);
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  // ── (6) AI Timeout -> Fallback to Heuristic ─────────────────────────────────
  it('(6) seamlessly falls back to heuristic if AI request times out or rejects', async () => {
    const profile = buildDatasetProfile('test_ref', baselineRows, baselineHeaders);

    const timingOutClient = {
      messages: {
        create: async () => {
          throw new Error('Anthropic API request timed out (30000ms)');
        },
      },
    };

    const aiProvider = new AiSuggestionProvider({ client: timingOutClient as any });
    const suggestions = await aiProvider.suggestColumns(profile);

    // Fallback succeeded, producing valid heuristic column roles
    expect(suggestions.length).toBe(baselineHeaders.length);
    const sugMap = Object.fromEntries(suggestions.map(s => [s.column, s]));
    expect(sugMap.cust_no?.role).toBe('id');
    expect(sugMap.app_date?.role).toBe('date');
    expect(sugMap.flag_npl_90?.role).toBe('label');
  });

  // ── Combined Provider: Boosts Agreement & Preserves Proposals ──────────────
  it('combined provider boosts confidence on agreement and preserves both proposals on conflict', async () => {
    const profile = buildDatasetProfile('test_ref', baselineRows, baselineHeaders);

    const mockAiClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              name: 'provide_column_suggestions',
              input: {
                suggestions: [
                  // Agrees on cust_no (id)
                  { column: 'cust_no', role: 'id', type: 'string', confidence: 0.95, reason: 'AI agrees id' },
                  // Agrees on app_date (date)
                  { column: 'app_date', role: 'date', type: 'date', confidence: 0.95, reason: 'AI agrees date' },
                  // Disagrees on pd_score: AI proposes 'feature' while heuristic proposes 'score'
                  { column: 'pd_score', role: 'feature', type: 'numeric', confidence: 0.96, reason: 'AI argues feature' },
                ],
              },
            },
          ],
        }),
      },
    };

    const aiProvider = new AiSuggestionProvider({ client: mockAiClient as any });
    const combined = new CombinedSuggestionProvider(aiProvider);
    const suggestions = await combined.suggestColumns(profile);
    const sugMap = Object.fromEntries(suggestions.map(s => [s.column, s]));

    // Agreement boost
    expect(sugMap.cust_no.agreement).toBe('agree');
    expect(sugMap.cust_no.confidence).toBeGreaterThanOrEqual(0.98);

    // Disagreement preserves both proposals
    const scoreSug = sugMap.pd_score;
    expect(scoreSug.agreement).toBe('disagree');
    expect(scoreSug.aiProposal?.role).toBe('feature');
    expect(scoreSug.heuristicProposal?.role).toBe('score');
  });
});
