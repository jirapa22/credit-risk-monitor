/**
 * Suggestion Engine entry point (Step 10c.A).
 */
import { calculateAScore } from '../scoring';
import { parseNumber } from '../validation';
import type { ScoringConfig } from '../types';
import { buildDatasetProfile, heuristicProvider, niceCeil, niceFloor } from './heuristic';
import { detectScoreDirection } from './scoreDirection';
import { AiSuggestionProvider, buildAiPayload, maskSensitiveSample, DEFAULT_AI_MODEL } from './ai';
import {
  CombinedSuggestionProvider,
  clearSuggestionCache,
  buildCacheKey,
  type CombinedStrategy,
  type CombinedProviderOptions,
} from './combined';
import { verifyNumberGrounding, type GroundingCheckResult } from './grounding';
import { extractScorecardWithAi, type AiScorecardExtractionResult } from './scorecardExtract';
import type {
  AiUsageStats,
  ColumnMappingEntry,
  ColumnSuggestion,
  DatasetProfile,
  FeatureSettingSuggestion,
  ScoreDirectionSuggestion,
  SuggestionProvider,
} from './types';

export * from './types';
export {
  buildDatasetProfile,
  heuristicProvider,
  niceCeil,
  niceFloor,
  detectScoreDirection,
  AiSuggestionProvider,
  buildAiPayload,
  maskSensitiveSample,
  DEFAULT_AI_MODEL,
  CombinedSuggestionProvider,
  clearSuggestionCache,
  buildCacheKey,
  type CombinedStrategy,
  type CombinedProviderOptions,
  verifyNumberGrounding,
  type GroundingCheckResult,
  extractScorecardWithAi,
  type AiScorecardExtractionResult,
};

export interface RunSuggestOptions {
  referenceId: string;
  rows: Record<string, unknown>[];
  columns?: string[];
  mapping?: ColumnMappingEntry[];
  scoringFeatures?: string[];
  scoring?: ScoringConfig | null;
  provider?: SuggestionProvider;
  providerType?: 'auto' | 'heuristic' | 'ai';
  combinedStrategy?: CombinedStrategy;
  sha256?: string;
}

export interface SuggestResponsePayload {
  provider: string;
  profile: DatasetProfile;
  columns: ColumnSuggestion[];
  featureSettings: FeatureSettingSuggestion[];
  scoreDirection: ScoreDirectionSuggestion | null;
  usage?: AiUsageStats | null;
  aiStatus?: { available: boolean; model: string };
}

export async function generateSuggestions(
  options: RunSuggestOptions,
): Promise<SuggestResponsePayload> {
  let provider: SuggestionProvider;
  if (options.provider) {
    provider = options.provider;
  } else if (options.providerType === 'heuristic') {
    provider = heuristicProvider;
  } else if (options.providerType === 'ai') {
    provider = new AiSuggestionProvider();
  } else {
    // 'auto' (default): combined provider if Anthropic key is set, else heuristic
    provider = process.env.ANTHROPIC_API_KEY
      ? new CombinedSuggestionProvider(undefined, { strategy: options.combinedStrategy ?? 'ai_primary' })
      : heuristicProvider;
  }

  const profile = buildDatasetProfile(options.referenceId, options.rows, options.columns);
  const columns = await provider.suggestColumns(profile);

  const effectiveMapping: ColumnMappingEntry[] =
    options.mapping && options.mapping.length > 0
      ? options.mapping
      : columns.map(c => ({
          column: c.column,
          role: c.role,
          type: c.type,
        }));

  const scoringFeatures =
    options.scoringFeatures ??
    (options.scoring?.features?.length ? options.scoring.features : undefined);

  const featureSettings = await provider.suggestFeatureSettings(profile, effectiveMapping, {
    scoringFeatures,
  });

  // Determine label & score columns to auto-detect scoreDirection
  const labelCol = effectiveMapping.find(m => m.role === 'label')?.column ?? null;
  const scoreCol = effectiveMapping.find(m => m.role === 'score')?.column ?? null;

  let scoreDirection: ScoreDirectionSuggestion | null = null;
  if (labelCol) {
    const labels: (number | null)[] = options.rows.map(r => {
      const n = parseNumber(r[labelCol]);
      return n === 0 || n === 1 ? n : null;
    });

    let scores: (number | null)[] = [];
    if (scoreCol) {
      scores = options.rows.map(r => {
        const n = parseNumber(r[scoreCol]);
        return Number.isFinite(n) ? n : null;
      });
    } else if (options.scoring && options.scoring.features?.length) {
      const sc = options.scoring;
      scores = options.rows.map(r => {
        const rec: Record<string, number> = {};
        for (const f of sc.features) {
          const v = parseNumber(r[f]);
          if (!Number.isFinite(v)) return null;
          rec[f] = v;
        }
        try {
          return calculateAScore(sc, rec);
        } catch {
          return null;
        }
      });
    }

    if (scores.length > 0) {
      scoreDirection = detectScoreDirection(scores, labels);
    }
  }

  const usage = provider.getLastUsage ? provider.getLastUsage() : null;
  const aiStatus = {
    available: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.AI_MODEL || DEFAULT_AI_MODEL,
  };

  return {
    provider: provider.name,
    profile,
    columns,
    featureSettings,
    scoreDirection,
    usage,
    aiStatus,
  };
}

