/**
 * Combined (Hybrid) Suggestion Provider & Cache (Step 10d.A).
 *
 * Merges heuristic rules and AI suggestions:
 *   - Both agree  -> boost confidence (+0.05 up to 0.99), agreement = 'agree'
 *   - Disagree    -> selects the higher confidence candidate, retains both as
 *                    `aiProposal` and `heuristicProposal` for transparent UI presentation.
 *   - Caches results by `referenceId + sha256 + provider + model`.
 */
import { heuristicProvider } from './heuristic';
import { AiSuggestionProvider } from './ai';
import type {
  AiUsageStats,
  ColumnMappingEntry,
  ColumnProposal,
  ColumnSuggestion,
  DatasetProfile,
  FeatureSettingSuggestion,
  SuggestFeatureOptions,
  SuggestionProvider,
} from './types';

interface CacheEntry {
  timestamp: number;
  columns: ColumnSuggestion[];
  settings?: FeatureSettingSuggestion[];
  usage?: AiUsageStats | null;
}

const suggestionCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function buildCacheKey(
  referenceId: string,
  sha256 = 'none',
  providerName = 'combined',
  modelName = 'default',
): string {
  return `${referenceId}::${sha256}::${providerName}::${modelName}`;
}

export function clearSuggestionCache(): void {
  suggestionCache.clear();
}

export class CombinedSuggestionProvider implements SuggestionProvider {
  readonly name = 'combined';
  private aiProvider: AiSuggestionProvider;
  private lastUsage: AiUsageStats | null = null;

  constructor(aiProvider?: AiSuggestionProvider) {
    this.aiProvider = aiProvider || new AiSuggestionProvider();
  }

  getAiProvider(): AiSuggestionProvider {
    return this.aiProvider;
  }

  getLastUsage(): AiUsageStats | null {
    return this.lastUsage;
  }

  async suggestColumns(
    profile: DatasetProfile,
    sha256?: string,
  ): Promise<ColumnSuggestion[]> {
    const model = this.aiProvider.getModel();
    const cacheKey = buildCacheKey(profile.referenceId, sha256, this.name, model);
    const cached = suggestionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      this.lastUsage = cached.usage ?? null;
      return cached.columns;
    }

    const heurList = await heuristicProvider.suggestColumns(profile);
    const heurMap = new Map(heurList.map(h => [h.column, h]));

    if (!this.aiProvider.isAvailable()) {
      const results: ColumnSuggestion[] = heurList.map(h => ({
        ...h,
        agreement: 'heuristic_only',
        heuristicProposal: {
          role: h.role,
          type: h.type,
          confidence: h.confidence,
          reason: h.reason,
        },
      }));
      suggestionCache.set(cacheKey, { timestamp: Date.now(), columns: results, usage: null });
      return results;
    }

    const aiList = await this.aiProvider.suggestColumns(profile);
    this.lastUsage = this.aiProvider.getLastUsage();
    const aiMap = new Map(aiList.map(a => [a.column, a]));

    const merged: ColumnSuggestion[] = profile.columns.map(col => {
      const cName = col.column;
      const h = heurMap.get(cName);
      const a = aiMap.get(cName);

      if (!h && !a) {
        return {
          column: cName,
          role: 'feature',
          type: col.inferredType,
          confidence: 0.5,
          reason: 'กำหนดเป็น feature โดยค่าเริ่มต้น',
          agreement: 'heuristic_only',
        };
      }

      if (!a && h) {
        return {
          ...h,
          agreement: 'heuristic_only',
          heuristicProposal: {
            role: h.role,
            type: h.type,
            confidence: h.confidence,
            reason: h.reason,
          },
        };
      }

      if (!h && a) {
        return {
          ...a,
          agreement: 'ai_only',
          aiProposal: {
            role: a.role,
            type: a.type,
            confidence: a.confidence,
            reason: a.reason,
          },
        };
      }

      const hProp: ColumnProposal = {
        role: h!.role,
        type: h!.type,
        confidence: h!.confidence,
        reason: h!.reason,
      };

      const aProp: ColumnProposal = {
        role: a!.role,
        type: a!.type,
        confidence: a!.confidence,
        reason: a!.reason,
      };

      const agrees = h!.role === a!.role && h!.type === a!.type;
      if (agrees) {
        const boosted = Math.min(0.99, Math.max(h!.confidence, a!.confidence) + 0.05);
        return {
          column: cName,
          role: h!.role,
          type: h!.type,
          confidence: +boosted.toFixed(2),
          reason: `${a!.reason} (กฎและ AI สรุปตรงกัน)`,
          aiProposal: aProp,
          heuristicProposal: hProp,
          agreement: 'agree',
        };
      }

      // Disagreement: Choose based on confidence
      const chooseAi = a!.confidence >= h!.confidence;
      const winner = chooseAi ? a! : h!;
      return {
        column: cName,
        role: winner.role,
        type: winner.type,
        confidence: winner.confidence,
        reason: chooseAi
          ? `${a!.reason} [AI: ${a!.role} vs กฎ: ${h!.role}]`
          : `${h!.reason} [กฎ: ${h!.role} vs AI: ${a!.role}]`,
        aiProposal: aProp,
        heuristicProposal: hProp,
        agreement: 'disagree',
      };
    });

    suggestionCache.set(cacheKey, {
      timestamp: Date.now(),
      columns: merged,
      usage: this.lastUsage,
    });
    return merged;
  }

  async suggestFeatureSettings(
    profile: DatasetProfile,
    mapping: ColumnMappingEntry[],
    options?: SuggestFeatureOptions,
  ): Promise<FeatureSettingSuggestion[]> {
    const heurSettings = await heuristicProvider.suggestFeatureSettings(
      profile,
      mapping,
      options,
    );
    const heurMap = new Map(heurSettings.map(s => [s.feature, s]));

    if (!this.aiProvider.isAvailable()) {
      return heurSettings;
    }

    const aiSettings = await this.aiProvider.suggestFeatureSettings(
      profile,
      mapping,
      options,
    );
    const aiMap = new Map(aiSettings.map(s => [s.feature, s]));

    return mapping
      .filter(m => m.role === 'feature')
      .map(m => {
        const featName = m.column;
        const h = heurMap.get(featName);
        const a = aiMap.get(featName);

        if (!a) return h!;
        return {
          feature: featName,
          dataType: m.type,
          description: a.description || undefined,
          minValue: a.minValue !== undefined ? a.minValue : h?.minValue,
          maxValue: a.maxValue !== undefined ? a.maxValue : h?.maxValue,
          anomalyTransform: h?.anomalyTransform,
          missingStrategy: h?.missingStrategy,
          categories: h?.categories,
          reason: a.reason ? `${a.reason} (AI)` : h?.reason || '',
          outOfBoundCount: a.outOfBoundCount,
        };
      });
  }
}
