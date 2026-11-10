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
import type { FeatureDataType } from '../types';

export const DEFAULT_AI_MODEL = 'claude-3-5-sonnet-latest';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 1;

const SENSITIVE_NAME_RE =
  /(?:^|[_\s-]|\b)(id|no|cust|acct|account|phone|tel|email|card|citizen|pid|nid|ssn|name)(?:$|[_\s-]|\b)|รหัส|เลข|บัตร|เบอร์|โทร|อีเมล|ชื่อ/i;

/**
 * Masks identifier/PII strings for PDPA compliance.
 * e.g. "EXT0012" -> "EXT***", "0812345678" -> "081***", "test@bank.com" -> "te***@***"
 */
export function maskSensitiveSample(val: unknown, isSensitiveColumn = false): string | number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 0;
    // Round to at most 2 significant digits to avoid leaking exact customer values
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(val) || 1)) - 1);
    return Math.round(val / mag) * mag;
  }
  const s = String(val ?? '').trim();
  if (!s) return '';

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
 * NEVER includes customer rows. Includes only column summaries and masked samples.
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
      .map(v => maskSensitiveSample(v, isSensitive));

    const item: AiColumnProfileSummary = {
      column: col.column,
      inferredType: col.inferredType,
      nonNullCount: col.nonNullCount,
      missingCount: col.missingCount,
      missingRate: col.missingRate,
      uniqueCount: col.uniqueCount,
      uniqueRatio: col.uniqueRatio,
      sampleValues: maskedSamples,
    };

    if (col.numericStats) {
      item.numericStats = {
        min: col.numericStats.min,
        p5: col.numericStats.p5,
        median: col.numericStats.median,
        p95: col.numericStats.p95,
        max: col.numericStats.max,
        skewness: col.numericStats.skewness,
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

export interface AiSuggestionProviderOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected client for unit testing without network calls */
  client?: Pick<Anthropic, 'messages'>;
}

export class AiSuggestionProvider implements SuggestionProvider {
  readonly name = 'ai';
  private client: Pick<Anthropic, 'messages'> | null = null;
  private model: string;
  private lastUsage: AiUsageStats | null = null;

  constructor(opts: AiSuggestionProviderOptions = {}) {
    this.model = opts.model || process.env.AI_MODEL || DEFAULT_AI_MODEL;
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
    } catch {
      // On timeout or failure, seamlessly fallback to heuristics
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
    } catch {
      return heuristicResults;
    }
  }
}
