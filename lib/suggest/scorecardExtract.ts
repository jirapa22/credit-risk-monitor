/**
 * AI-Assisted Scorecard Extractor from Excel (Step 10d.C.3).
 *
 * Extracts scorecard parameters (variable, upper_bound, points, base_points)
 * from complex Excel workbooks with text intervals (e.g. "≤17,800", "17,801–22,300", ">36,360").
 * Scorecard definitions are model-level parameters, not customer data.
 *
 * Verification gate:
 *   - Must pass `validateScoringConfig`
 *   - Must match Reference scores >= 99% (diff <= 0.5 pt). If < 99%, auto-acceptance is blocked.
 */
import { Anthropic } from '@anthropic-ai/sdk';
import {
  parseXlsxAllSheets,
  importScorecardFromRows,
  type ScorecardImportResult,
  type XlsxWorksheet,
} from '../scorecardImport';
import { DEFAULT_AI_MODEL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES } from './ai';

export interface ScorecardExtractionOptions {
  referenceRows?: Record<string, unknown>[];
  referenceScores?: number[];
  apiKey?: string;
  model?: string;
  client?: Pick<Anthropic, 'messages'>;
}

export interface AiScorecardExtractionResult extends ScorecardImportResult {
  autoAccepted: boolean;
  extractedBy: 'ai' | 'heuristic';
  rawSheetSummaries: { name: string; rowCount: number }[];
}

function formatSheetsForAiPrompt(sheets: XlsxWorksheet[]): string {
  const parts: string[] = [];
  for (const s of sheets) {
    parts.push(`=== Sheet: "${s.name}" (Rows: ${s.rowCount}) ===`);
    const previewRows = s.matrix.slice(0, 35);
    for (const r of previewRows) {
      parts.push(r.join(' | '));
    }
    if (s.matrix.length > 35) {
      parts.push(`... (${s.matrix.length - 35} more rows omitted)`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Extracts scorecard configuration from Excel buffer using Claude AI (with heuristic fallback).
 */
export async function extractScorecardWithAi(
  buffer: Uint8Array | Buffer,
  options: ScorecardExtractionOptions = {},
): Promise<AiScorecardExtractionResult> {
  const sheets = parseXlsxAllSheets(buffer);
  const rawSheetSummaries = sheets.map(s => ({ name: s.name, rowCount: s.rowCount }));

  if (sheets.length === 0) {
    return {
      ok: false,
      scoring: { base_points: 0, factor: 1, offset: 0, features: [], scorecard: {} },
      errors: ['ไม่พบแผ่นงานในไฟล์ Excel'],
      warnings: [],
      scoreComparison: null,
      autoAccepted: false,
      extractedBy: 'heuristic',
      rawSheetSummaries,
    };
  }

  let client = options.client;
  if (!client) {
    const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      client = new Anthropic({
        apiKey,
        timeout: DEFAULT_TIMEOUT_MS,
        maxRetries: DEFAULT_MAX_RETRIES,
      });
    }
  }

  // Fallback to heuristic if no AI client
  if (!client) {
    const heuristicRes = importScorecardFromRows(sheets[0]?.rows || [], {
      referenceRows: options.referenceRows,
      referenceScores: options.referenceScores,
    });
    const autoAccepted = Boolean(
      heuristicRes.ok &&
        heuristicRes.scoreComparison &&
        heuristicRes.scoreComparison.matchWithinHalfPointPct >= 99.0,
    );
    return {
      ...heuristicRes,
      autoAccepted,
      extractedBy: 'heuristic',
      rawSheetSummaries,
    };
  }

  const model = options.model || process.env.AI_MODEL || DEFAULT_AI_MODEL;
  const promptText = formatSheetsForAiPrompt(sheets);

  const systemPrompt = `You are a credit scoring model expert. Inspect the Excel sheets provided and extract the credit scorecard specification:
1. Identify the sheet that contains the Scorecard table and base points.
2. Extract the base_points value (constant points added to all cases).
3. For each variable, extract its bins in ascending order:
   - Interpret text bin labels into numerical upper_bounds (e.g. '<= 17800' or '(14999, 17800]' -> upper_bound 17800; '> 36360' -> upper_bound null for final bin).
   - Each variable MUST have exactly one final open-ended bin with upper_bound = null.
   - Points must be numeric.
Return JSON strictly according to submit_extracted_scorecard tool.`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Extract the credit scorecard from these Excel sheets:\n\n${promptText}`,
        },
      ],
      tools: [
        {
          name: 'submit_extracted_scorecard',
          description: 'Submits extracted scorecard base points and bin definitions.',
          input_schema: {
            type: 'object',
            properties: {
              base_points: { type: 'number' },
              rows: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    variable: { type: 'string' },
                    upper_bound: { type: ['number', 'null'] },
                    points: { type: 'number' },
                    bin_label: { type: 'string' },
                    woe: { type: ['number', 'null'] },
                    bad_rate: { type: ['number', 'null'] },
                    count: { type: ['number', 'null'] },
                  },
                  required: ['variable', 'points'],
                },
              },
            },
            required: ['base_points', 'rows'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_extracted_scorecard' },
    });

    const toolUse = response.content.find(c => c.type === 'tool_use');
    const input =
      toolUse && typeof toolUse === 'object' && 'input' in toolUse && toolUse.input
        ? (toolUse.input as {
            base_points?: number;
            rows?: {
              variable: string;
              upper_bound: number | null;
              points: number;
              bin_label?: string;
              woe?: number | null;
              bad_rate?: number | null;
              count?: number | null;
            }[];
          })
        : null;

    if (!input || !Array.isArray(input.rows)) {
      throw new Error('AI ส่งผลการดึงสกอร์การ์ดในรูปแบบที่ไม่ถูกต้อง');
    }

    // Convert AI extracted structure to rows for verification
    const convertedRows: Record<string, unknown>[] = [
      { variable: 'base_points', points: input.base_points ?? 0 },
    ];

    for (const r of input.rows) {
      convertedRows.push({
        variable: r.variable,
        upper_bound: r.upper_bound !== null && r.upper_bound !== undefined ? r.upper_bound : '',
        points: r.points,
        bin_label: r.bin_label || '',
        woe: r.woe !== null && r.woe !== undefined ? r.woe : '',
        bad_rate: r.bad_rate !== null && r.bad_rate !== undefined ? r.bad_rate : '',
        count: r.count !== null && r.count !== undefined ? r.count : '',
      });
    }

    const verified = importScorecardFromRows(convertedRows, {
      referenceRows: options.referenceRows,
      referenceScores: options.referenceScores,
    });

    const matchPct = verified.scoreComparison?.matchWithinHalfPointPct ?? 100;
    const autoAccepted = verified.ok && matchPct >= 99.0;

    if (!autoAccepted && verified.ok) {
      verified.warnings.push(
        `[AI Extraction] คะแนนที่คำนวณจากสกอร์การ์ดตรงกับ Reference เพียง ${matchPct.toFixed(2)}% (< 99%) — ไม่อนุมัติรับอัตโนมัติ ต้องให้ผู้เชี่ยวชาญตรวจสอบก่อนยืนยัน`,
      );
    }

    return {
      ...verified,
      autoAccepted,
      extractedBy: 'ai',
      rawSheetSummaries,
    };
  } catch {
    // On failure, fall back to heuristic
    const heuristicRes = importScorecardFromRows(sheets[0]?.rows || [], {
      referenceRows: options.referenceRows,
      referenceScores: options.referenceScores,
    });
    const autoAccepted = Boolean(
      heuristicRes.ok &&
        heuristicRes.scoreComparison &&
        heuristicRes.scoreComparison.matchWithinHalfPointPct >= 99.0,
    );
    return {
      ...heuristicRes,
      autoAccepted,
      extractedBy: 'heuristic',
      rawSheetSummaries,
    };
  }
}
