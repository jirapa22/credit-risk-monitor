/**
 * Claude AI Suggestion Provider (Step 10d.A).
 *
 * Implements `SuggestionProvider` using the official Anthropic SDK (@anthropic-ai/sdk).
 * Guarantees strict PDPA compliance: NEVER sends customer rows to AI.
 * Code-verifies all AI suggestions with automatic fallback to heuristics.
 */
import { Anthropic } from '@anthropic-ai/sdk';
import { heuristicProvider } from './heuristic';
import type {
  AiColumnProfileSummary,
  AiDatasetPayload,
  AiUsageStats,
  ColumnMappingEntry,
  ColumnRole,
  ColumnSuggestion,
  DatasetProfile,
  FeatureSettingSuggestion,
  SuggestFeatureOptions,
  SuggestionProvider,
} from './types';
import type { BaselineValidationReport, FeatureDataType } from '../types';
import type { XlsxWorksheet } from '../scorecardImport';

export const DEFAULT_AI_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 1;

const SENSITIVE_NAME_RE =
  /(?:^|[_\s-]|\b)(id|no|cust|acct|account|phone|tel|email|card|citizen|pid|nid|ssn|name)(?:$|[_\s-]|\b)|รหัส|เลข|บัตร|เบอร์|โทร|อีเมล|ชื่อ/i;

/**
 * Rounds a number to a specified number of significant figures (defaults to 2).
 * e.g. 23950 -> 24000, 0.0164 -> 0.016, 0.53 -> 0.53
 */
export function roundToSigFigs(val: number, sigFigs = 2): number {
  if (!Number.isFinite(val) || val === 0) return 0;
  return Number(val.toPrecision(sigFigs));
}

/**
 * Formats any date string or Date instance strictly to YYYY-MM (drops day of month).
 */
export function formatDateToYearMonth(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  if (!s) return '';

  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}`;
  }

  const dmyMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}`;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  return s;
}

/**
 * Masks identifier/PII strings and rounds numbers/dates for PDPA compliance.
 * e.g. "EXT0012" -> "EXT***", "0812345678" -> "081***", "2024-01-15" -> "2024-01", 23950 -> 24000
 */
export function maskSensitiveSample(
  val: unknown,
  isSensitiveColumn = false,
  inferredType?: FeatureDataType,
): string | number {
  if (val === null || val === undefined) return '';

  if (typeof val === 'number') {
    return roundToSigFigs(val, 2);
  }

  const s = String(val ?? '').trim();
  if (!s) return '';

  // If numeric column or numeric string
  if (inferredType === 'numeric' || inferredType === 'binary') {
    const n = Number(s);
    if (Number.isFinite(n)) {
      return roundToSigFigs(n, 2);
    }
  }

  // If date column or date-like value -> only YYYY-MM
  if (
    inferredType === 'date' ||
    /^\d{4}[-/]\d{1,2}/.test(s) ||
    /^\d{1,2}[-/]\d{1,2}[-/]\d{4}/.test(s)
  ) {
    const ym = formatDateToYearMonth(s);
    if (ym) return ym;
  }

  if (s.includes('@')) {
    const [user, domain] = s.split('@');
    return `${user.slice(0, 2)}***@***.${(domain || '').split('.').pop() || 'com'}`;
  }

  if (isSensitiveColumn || /^\d{9,13}$/.test(s) || /^[A-Za-z]{1,4}\d{2,10}$/i.test(s)) {
    const keep = Math.min(3, Math.max(1, s.length <= 3 ? 1 : 3));
    return `${s.slice(0, keep)}***`;
  }

  return s;
}

/**
 * Builds a privacy-safe, aggregated payload for AI suggestions (Step 10d.B).
 * NEVER includes customer rows. Includes only column summaries, rounded numbers (2 sig figs),
 * dates truncated to YYYY-MM, and masked samples.
 */
export function buildAiPayload(
  profile: DatasetProfile,
  options?: { maxSampleValues?: number; maxCategories?: number },
): AiDatasetPayload {
  const maxSamples = options?.maxSampleValues ?? 5;
  const maxCats = options?.maxCategories ?? 20;

  const columns: AiColumnProfileSummary[] = profile.columns.map(col => {
    const isSensitive = SENSITIVE_NAME_RE.test(col.column);
    const maskedSamples = (col.sampleValues || [])
      .slice(0, maxSamples)
      .map(v => maskSensitiveSample(v, isSensitive, col.inferredType));

    const item: AiColumnProfileSummary = {
      column: col.column,
      inferredType: col.inferredType,
      nonNullCount: col.nonNullCount,
      missingCount: col.missingCount,
      missingRate: roundToSigFigs(col.missingRate, 2),
      uniqueCount: col.uniqueCount,
      uniqueRatio: roundToSigFigs(col.uniqueRatio, 2),
      sampleValues: maskedSamples,
    };

    if (col.numericStats) {
      item.numericStats = {
        min: roundToSigFigs(col.numericStats.min, 2),
        p5: roundToSigFigs(col.numericStats.p5, 2),
        median: roundToSigFigs(col.numericStats.median, 2),
        p95: roundToSigFigs(col.numericStats.p95, 2),
        max: roundToSigFigs(col.numericStats.max, 2),
        skewness: roundToSigFigs(col.numericStats.skewness, 2),
        isBinaryZeroOne: col.numericStats.isBinaryZeroOne,
      };
    }

    if (col.categories && col.categories.length > 0) {
      item.categories = col.categories.slice(0, maxCats);
    }

    return item;
  });

  return {
    referenceId: profile.referenceId,
    rowCount: profile.rowCount,
    columns,
  };
}

/**
 * Privacy-safe builder for validation report explanation requests sent to AI.
 * Strips raw error arrays, customer-level details, and formats numbers to 2 sig figs.
 */
export function buildAiValidationExplanationPayload(report: BaselineValidationReport): {
  ok: boolean;
  errorsCount: number;
  warningsCount: number;
  computed?: {
    rowCount: number;
    badCount: number;
    badRatePct: number;
    auc?: number;
    ks?: number;
    gini?: number;
    referenceFlaggedCount: number;
    referenceFlaggedPct: number;
    multivariateFitMs: number;
  };
} {
  const c = report.computed;
  return {
    ok: report.ok,
    errorsCount: report.errors?.length ?? 0,
    warningsCount: report.warnings?.length ?? 0,
    computed: c
      ? {
          rowCount: c.rowCount,
          badCount: c.badCount ?? 0,
          badRatePct: c.badRate != null ? roundToSigFigs(c.badRate * 100, 2) : 0,
          auc: c.performance?.auc != null ? roundToSigFigs(c.performance.auc, 2) : undefined,
          ks: c.performance?.ks != null ? roundToSigFigs(c.performance.ks, 2) : undefined,
          gini: c.performance?.gini != null ? roundToSigFigs(c.performance.gini, 2) : undefined,
          referenceFlaggedCount: c.referenceFlaggedCount ?? 0,
          referenceFlaggedPct: roundToSigFigs(c.referenceFlaggedPct ?? 0, 2),
          multivariateFitMs: roundToSigFigs(c.multivariateFitMs ?? 0, 2),
        }
      : undefined,
  };
}

/**
 * Filters workbook sheets to ONLY send scorecard tables to AI,
 * strictly excluding any customer data rows or extraneous sheets.
 */
export function buildAiScorecardPayload(sheets: XlsxWorksheet[]): string {
  const SCORECARD_SHEET_RE = /scorecard|คะแนน|weight|point|model|coef|woe|cut/i;
  let relevantSheets = sheets.filter(s => SCORECARD_SHEET_RE.test(s.name));
  if (relevantSheets.length === 0) {
    relevantSheets = sheets.filter(s => {
      const top = s.matrix.slice(0, 5).flat().map(v => String(v).toLowerCase());
      return top.some(k => k.includes('point') || k.includes('woe') || k.includes('bin') || k.includes('คะแนน'));
    });
  }
  if (relevantSheets.length === 0) {
    relevantSheets = sheets.slice(0, 1);
  }

  const parts: string[] = [];
  for (const s of relevantSheets) {
    parts.push(`=== Scorecard Sheet: "${s.name}" (Rows: ${s.rowCount}) ===`);
    const previewRows = s.matrix.slice(0, 50);
    for (const r of previewRows) {
      parts.push(r.join(' | '));
    }
    if (s.matrix.length > 50) {
      parts.push(`... (${s.matrix.length - 50} more rows omitted)`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

export interface AiSuggestionProviderOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected client for unit testing without network calls */
  client?: Pick<Anthropic, 'messages'>;
  /** If true, throws error immediately on failure instead of falling back to heuristic */
  throwOnError?: boolean;
}

export class AiSuggestionProvider implements SuggestionProvider {
  readonly name = 'ai';
  private client: Pick<Anthropic, 'messages'> | null = null;
  private model: string;
  private throwOnError: boolean;
  private lastUsage: AiUsageStats | null = null;

  constructor(opts: AiSuggestionProviderOptions = {}) {
    this.model = opts.model || process.env.AI_MODEL || DEFAULT_AI_MODEL;
    this.throwOnError = opts.throwOnError ?? false;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        this.client = new Anthropic({
          apiKey,
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
        });
      }
    }
  }

  isAvailable(): boolean {
    return Boolean(this.client);
  }

  getModel(): string {
    return this.model;
  }

  getLastUsage(): AiUsageStats | null {
    return this.lastUsage;
  }

  async suggestColumns(profile: DatasetProfile): Promise<ColumnSuggestion[]> {
    const heuristicResults = await heuristicProvider.suggestColumns(profile);
    const heurMap = new Map(heuristicResults.map(h => [h.column, h]));

    if (!this.client) {
      if (this.throwOnError) {
        throw new Error('ANTHROPIC_API_KEY is not configured or client initialization failed.');
      }
      return heuristicResults;
    }

    const payload = buildAiPayload(profile);
    const validRoles: ColumnRole[] = ['id', 'date', 'label', 'score', 'feature', 'ignore'];
    const validTypes: FeatureDataType[] = ['numeric', 'categorical', 'binary', 'date', 'string'];
    const colSet = new Set(profile.columns.map(c => c.column));

    const systemPrompt = `You are a credit risk modeling assistant. Given a privacy-safe dataset summary (metadata and masked sample values only), classify each column into its role in credit risk monitoring:
- id: Primary identifier / customer reference
- date: Application date or observation period
- label: Target variable (must be binary 0/1 default flag)
- score: Credit score or probability of default
- feature: Model input variable (numeric or categorical)
- ignore: Irrelevant text / high-cardinality metadata
Provide a clear, concise explanation in Thai for each column.
Return JSON strictly according to the provide_column_suggestions tool.`;

    const startTime = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Analyze this credit risk dataset profile and suggest column roles:\n${JSON.stringify(payload, null, 2)}`,
          },
        ],
        tools: [
          {
            name: 'provide_column_suggestions',
            description: 'Submits suggested column roles and data types for all columns.',
            input_schema: {
              type: 'object',
              properties: {
                suggestions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      column: { type: 'string' },
                      role: {
                        type: 'string',
                        enum: ['id', 'date', 'label', 'score', 'feature', 'ignore'],
                      },
                      type: {
                        type: 'string',
                        enum: ['numeric', 'categorical', 'binary', 'date', 'string'],
                      },
                      confidence: { type: 'number', minimum: 0, maximum: 1 },
                      reason: { type: 'string' },
                    },
                    required: ['column', 'role', 'type', 'confidence', 'reason'],
                  },
                },
              },
              required: ['suggestions'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'provide_column_suggestions' },
      });

      const durationMs = Date.now() - startTime;
      const usage = response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const promptTokens = usage?.input_tokens ?? 0;
      const completionTokens = usage?.output_tokens ?? 0;
      this.lastUsage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        durationMs,
        model: this.model,
      };

      // Extract tool call
      const toolUse = response.content.find(c => c.type === 'tool_use');
      const rawSuggestions =
        toolUse && typeof toolUse === 'object' && 'input' in toolUse && toolUse.input
          ? (toolUse.input as { suggestions?: ColumnSuggestion[] }).suggestions || []
          : [];

      const aiMap = new Map<string, ColumnSuggestion>();
      for (const item of rawSuggestions) {
        if (item && typeof item === 'object' && item.column) {
          aiMap.set(item.column, item);
        }
      }

      // Code Verification (Step 10d.A)
      return profile.columns.map(col => {
        const cName = col.column;
        const heur = heurMap.get(cName);
        const ai = aiMap.get(cName);

        if (!ai) {
          return heur!;
        }

        // 1. Column must actually exist
        if (!colSet.has(ai.column)) {
          return {
            ...heur!,
            reason: `[AI Fallback] คอลัมน์ "${ai.column}" ไม่มีอยู่ในไฟล์ — ใช้ผลจากกฎแทน (${heur!.reason})`,
          };
        }

        // 2. Role must be valid
        if (!validRoles.includes(ai.role)) {
          return {
            ...heur!,
            reason: `[AI Fallback] บทบาท "${ai.role}" ไม่ถูกต้อง — ใช้ผลจากกฎแทน (${heur!.reason})`,
          };
        }

        // 3. Type must be valid
        if (!validTypes.includes(ai.type)) {
          return {
            ...heur!,
            reason: `[AI Fallback] ชนิดข้อมูล "${ai.type}" ไม่ถูกต้อง — ใช้ผลจากกฎแทน (${heur!.reason})`,
          };
        }

        // 4. Label must be verified binary 0/1
        if (ai.role === 'label') {
          const isBinary01 =
            col.inferredType === 'binary' ||
            Boolean(col.numericStats?.isBinaryZeroOne) ||
            col.sampleValues.every(v => v === 0 || v === 1 || v === '0' || v === '1');
          if (!isBinary01) {
            return {
              ...heur!,
              reason: `[AI Fallback] คอลัมน์ "${cName}" ไม่ใช่ข้อมูล 0/1 (ไม่ผ่านเกณฑ์ตัวแปรเป้าหมาย) — ใช้ผลจากกฎแทน`,
            };
          }
        }

        return {
          column: cName,
          role: ai.role,
          type: ai.type,
          confidence: Math.max(0.1, Math.min(0.99, Number(ai.confidence) || 0.85)),
          reason: ai.reason ? String(ai.reason).trim() : heur?.reason || 'ระบุโดย AI',
        };
      });
    } catch (err: unknown) {
      const errStr = err instanceof Error ? err.message : String(err);
      const isModelError =
        (err as any)?.status === 404 ||
        errStr.toLowerCase().includes('not_found_error') ||
        errStr.toLowerCase().includes('model');
      const contextualMsg = isModelError
        ? `Anthropic API does not recognize model "${this.model}": ${errStr}`
        : `Anthropic API call failed with model "${this.model}": ${errStr}`;

      if (this.throwOnError) {
        throw new Error(contextualMsg);
      }
      // On timeout or failure in standard mode, seamlessly fallback to heuristics
      return heuristicResults;
    }
  }

  async suggestFeatureSettings(
    profile: DatasetProfile,
    mapping: ColumnMappingEntry[],
    options?: SuggestFeatureOptions,
  ): Promise<FeatureSettingSuggestion[]> {
    const heuristicResults = await heuristicProvider.suggestFeatureSettings(
      profile,
      mapping,
      options,
    );
    const heurMap = new Map(heuristicResults.map(h => [h.feature, h]));

    if (!this.client) {
      return heuristicResults;
    }

    const featureCols = mapping.filter(m => m.role === 'feature');
    if (featureCols.length === 0) return [];

    const payload = buildAiPayload({
      ...profile,
      columns: profile.columns.filter(c => featureCols.some(f => f.column === c.column)),
    });

    const systemPrompt = `You are a credit risk modeling expert. For each feature, provide:
1. A concise 1-line business description in Thai (data dictionary).
2. Proposed reasonable business min and max limits with rationale.
Return JSON strictly according to provide_feature_settings tool.`;

    const startTime = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Suggest business descriptions and min/max settings for these features:\n${JSON.stringify(payload, null, 2)}`,
          },
        ],
        tools: [
          {
            name: 'provide_feature_settings',
            description: 'Submits feature dictionary descriptions and validation boundaries.',
            input_schema: {
              type: 'object',
              properties: {
                settings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      feature: { type: 'string' },
                      description: { type: 'string' },
                      minValue: { type: ['number', 'null'] },
                      maxValue: { type: ['number', 'null'] },
                      reason: { type: 'string' },
                    },
                    required: ['feature', 'description', 'reason'],
                  },
                },
              },
              required: ['settings'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'provide_feature_settings' },
      });

      const durationMs = Date.now() - startTime;
      const usage = response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const promptTokens = usage?.input_tokens ?? 0;
      const completionTokens = usage?.output_tokens ?? 0;
      this.lastUsage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        durationMs,
        model: this.model,
      };

      const toolUse = response.content.find(c => c.type === 'tool_use');
      const rawSettings =
        toolUse && typeof toolUse === 'object' && 'input' in toolUse && toolUse.input
          ? (toolUse.input as { settings?: FeatureSettingSuggestion[] }).settings || []
          : [];

      const aiMap = new Map<string, FeatureSettingSuggestion>();
      for (const item of rawSettings) {
        if (item && typeof item === 'object' && item.feature) {
          aiMap.set(item.feature, item);
        }
      }

      return featureCols.map(m => {
        const featName = m.column;
        const heur = heurMap.get(featName);
        const ai = aiMap.get(featName);
        const colSummary = profile.columns.find(c => c.column === featName);

        if (!ai) return heur!;

        let minValue = heur?.minValue;
        let maxValue = heur?.maxValue;
        if (typeof ai.minValue === 'number' && Number.isFinite(ai.minValue)) {
          minValue = ai.minValue;
        }
        if (typeof ai.maxValue === 'number' && Number.isFinite(ai.maxValue)) {
          maxValue = ai.maxValue;
        }

        // Out-of-bounds verification against Reference stats
        let outOfBoundCount = 0;
        if (colSummary?.numericStats) {
          if (minValue !== null && minValue !== undefined && colSummary.numericStats.min < minValue) {
            outOfBoundCount += 1;
          }
          if (maxValue !== null && maxValue !== undefined && colSummary.numericStats.max > maxValue) {
            outOfBoundCount += 1;
          }
        }

        return {
          feature: featName,
          dataType: m.type,
          description: ai.description ? String(ai.description).trim() : undefined,
          minValue,
          maxValue,
          anomalyTransform: heur?.anomalyTransform,
          missingStrategy: heur?.missingStrategy,
          categories: heur?.categories,
          reason: ai.reason ? String(ai.reason).trim() : heur?.reason || '',
          outOfBoundCount,
        };
      });
    } catch (err: unknown) {
      const errStr = err instanceof Error ? err.message : String(err);
      const isModelError =
        (err as any)?.status === 404 ||
        errStr.toLowerCase().includes('not_found_error') ||
        errStr.toLowerCase().includes('model');
      const contextualMsg = isModelError
        ? `Anthropic API does not recognize model "${this.model}": ${errStr}`
        : `Anthropic API call failed with model "${this.model}": ${errStr}`;

      if (this.throwOnError) {
        throw new Error(contextualMsg);
      }
      return heuristicResults;
    }
  }
}
