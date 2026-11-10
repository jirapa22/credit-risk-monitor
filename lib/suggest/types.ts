/**
 * Suggestion Provider Interface (Step 10c).
 *
 * Designed so Step 10c uses `heuristicProvider` (rule-based) and Step 10d can
 * plug in an AI/LLM provider implementing the exact same `SuggestionProvider`
 * contract — receiving ONLY `DatasetProfile` (column names + summary stats +
 * at most 5 sample values per column, NEVER raw rows).
 */
import type { AnomalyTransform, FeatureDataType, MissingStrategy } from '../types';

export type ColumnRole = 'id' | 'date' | 'label' | 'score' | 'feature' | 'ignore';

export interface NumericColumnSummary {
  min: number;
  max: number;
  mean: number;
  median: number;
  sd: number;
  iqr: number;
  p0_5: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  p99_5: number;
  skewness: number;
  allNonNegative: boolean;
  isBinaryZeroOne: boolean;
}

export interface ColumnProfileSummary {
  column: string;
  inferredType: FeatureDataType;
  nonNullCount: number;
  missingCount: number;
  missingRate: number;
  uniqueCount: number;
  uniqueRatio: number;
  /** At most 5 sample values (never full column data). */
  sampleValues: (string | number)[];
  numericStats?: NumericColumnSummary;
  /** Detected categories for categorical columns (up to 50). */
  categories?: string[];
}

export interface DatasetProfile {
  referenceId: string;
  rowCount: number;
  columns: ColumnProfileSummary[];
}

export interface ColumnSuggestion {
  column: string;
  role: ColumnRole;
  type: FeatureDataType;
  confidence: number;
  reason: string;
}

export interface ColumnMappingEntry {
  column: string;
  role: ColumnRole;
  type: FeatureDataType;
  displayName?: string;
}

export interface FeatureSettingSuggestion {
  feature: string;
  dataType: FeatureDataType;
  minValue?: number | null;
  maxValue?: number | null;
  anomalyTransform?: AnomalyTransform;
  missingStrategy?: MissingStrategy;
  categories?: string[];
  reason: string;
}

export interface SuggestFeatureOptions {
  /** Features used in scorecard calculation (when mode === 'scorecard'). */
  scoringFeatures?: string[];
}

export interface ScoreDirectionSuggestion {
  direction: 'higher_is_safer' | 'higher_is_riskier';
  auc: number;
  aucSafer: number;
  aucRiskier: number;
  reason: string;
}

export interface SuggestionProvider {
  readonly name: string;
  suggestColumns(
    profile: DatasetProfile,
  ): Promise<ColumnSuggestion[]> | ColumnSuggestion[];
  suggestFeatureSettings(
    profile: DatasetProfile,
    mapping: ColumnMappingEntry[],
    options?: SuggestFeatureOptions,
  ): Promise<FeatureSettingSuggestion[]> | FeatureSettingSuggestion[];
}

