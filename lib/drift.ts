/**
 * Drift Detection layer — answers "did the distribution change vs the
 * reference?". Receives ONLY rows that already passed Data Validation.
 */
import type {
  DriftResult, DriftStatus, FeatureDefinition, MonitoringThresholds, ScoringConfig, StabilityResult,
} from './types';
import type { ReferenceProfile } from './reference';
import { DEFAULT_LABEL_COLUMN } from './defaults';
import {
  defaultBinLabels,
  formatCategoryDisplayLabel,
  psiForCategories,
  psiWithBoundaries,
  quantileBoundaries,
} from './stats';

export function classify(value: number, warning: number, critical: number): DriftStatus {
  if (value < warning) return 'STABLE';
  if (value < critical) return 'WARNING';
  return 'CRITICAL';
}

const RANK: Record<DriftStatus, number> = { STABLE: 0, WARNING: 1, CRITICAL: 2 };

function stability(base: number[], actual: number[], boundaries: number[], labels: string[], warning: number, critical: number): StabilityResult {
  const r = psiWithBoundaries(base, actual, boundaries);
  return {
    value: r.value,
    status: classify(r.value, warning, critical),
    threshold: { warning, critical },
    bins: r.bins.map((b, i) => ({ label: labels[i] ?? `Bin ${i + 1}`, ...b })),
  };
}

export interface DriftDetectionOptions {
  labelColumn?: string | null;
  scoreColumn?: string | null;
  idColumn?: string | null;
  dateColumn?: string | null;
  actualCategories?: Record<string, string[]>;
}

/** Which features get a CSI, and with which bins/threshold. */
export function resolveCsiFeatures(
  registry: Record<string, FeatureDefinition>,
  thresholds: MonitoringThresholds,
  reference: ReferenceProfile,
  options?: DriftDetectionOptions,
) {
  const labelCol = options && 'labelColumn' in options ? options.labelColumn : DEFAULT_LABEL_COLUMN;
  const excluded = new Set<string>(
    [labelCol, options?.scoreColumn, options?.idColumn, options?.dateColumn].filter(
      (x): x is string => Boolean(x),
    ),
  );
  const keys = new Set<string>([
    ...Object.entries(registry)
      .filter(([k, d]) => d.monitoringEnabled !== false && (d.dataType === 'numeric' || d.dataType === 'categorical') && !excluded.has(k))
      .map(([k]) => k),
    ...Object.keys(thresholds.csi_features ?? {}).filter(k => !excluded.has(k)),
  ]);
  const out: {
    key: string;
    displayName: string;
    dataType: 'numeric' | 'categorical';
    source?: string;
    bins: number[];
    labels: string[];
    categories?: string[];
    threshold: number;
    skipped?: string;
  }[] = [];
  for (const key of keys) {
    const def = registry[key];
    const t = thresholds.csi_features?.[key];
    if (def?.dataType === 'categorical') {
      const refCatVals = reference.categoricalFeatures?.[key];
      const baseCats = reference.categorySpecs?.[key]?.categories ?? [];
      if (!refCatVals || refCatVals.length === 0) {
        out.push({
          key,
          displayName: t?.label || def?.displayName || key,
          dataType: 'categorical',
          bins: [],
          labels: [],
          categories: [],
          threshold: 0,
          skipped: 'ไม่มีตัวแปรนี้ใน Reference Dataset',
        });
        continue;
      }
      out.push({
        key,
        displayName: t?.label || def?.displayName || key,
        dataType: 'categorical',
        source: t?.source || def?.source,
        bins: [],
        labels: baseCats.map(formatCategoryDisplayLabel),
        categories: baseCats,
        threshold: t?.threshold ?? def?.csiThreshold ?? 0.10,
      });
      continue;
    }
    // User-editable thresholds.csi_features takes precedence over registry defaults.
    let bins = (t?.bins?.length ? t.bins : def?.binning?.boundaries) ?? [];
    let labels = (t?.bins?.length ? t.bin_labels : def?.binning?.binLabels) ?? [];
    const refVals = reference.features[key];
    if (!refVals) {
      out.push({
        key,
        displayName: t?.label || def?.displayName || key,
        dataType: 'numeric',
        bins: [],
        labels: [],
        threshold: 0,
        skipped: 'ไม่มีตัวแปรนี้ใน Reference Dataset',
      });
      continue;
    }
    if (bins.length === 0) bins = quantileBoundaries(refVals, 10);
    if (!labels || labels.length !== bins.length + 1) labels = defaultBinLabels(bins);
    out.push({
      key,
      displayName: t?.label || def?.displayName || key,
      dataType: 'numeric',
      source: t?.source || def?.source,
      bins, labels,
      threshold: t?.threshold ?? def?.csiThreshold ?? 0.10,
    });
  }
  return out;
}

export function runDriftDetection(
  reference: ReferenceProfile,
  actualScores: number[],
  actualFeatures: Record<string, number[]>,
  registry: Record<string, FeatureDefinition>,
  thresholds: MonitoringThresholds,
  options?: DriftDetectionOptions,
): DriftResult & { skipped: Record<string, string> } {
  const scoresAvailable = reference.scores.length > 0 && actualScores.length > 0;
  const psi: StabilityResult = scoresAvailable
    ? stability(
        reference.scores, actualScores, reference.scoreBoundaries, defaultBinLabels(reference.scoreBoundaries),
        thresholds.psi_warning, thresholds.psi_critical,
      )
    : {
        value: 0,
        status: 'NOT_AVAILABLE',
        threshold: { warning: thresholds.psi_warning, critical: thresholds.psi_critical },
        bins: [],
      };

  const csi: DriftResult['csi'] = {};
  const skipped: Record<string, string> = {};
  for (const f of resolveCsiFeatures(registry, thresholds, reference, options)) {
    if (f.skipped) { skipped[f.key] = f.skipped; continue; }
    const critical = Math.max(thresholds.psi_critical, f.threshold);
    if (f.dataType === 'categorical') {
      const actualCats = options?.actualCategories?.[f.key];
      if (!actualCats || actualCats.length === 0) {
        skipped[f.key] = 'ไม่มีข้อมูลตัวแปรนี้ในไฟล์ที่อัปโหลด';
        continue;
      }
      const catPsi = psiForCategories(
        reference.categoricalFeatures?.[f.key] ?? [],
        actualCats,
        f.categories ?? [],
      );
      csi[f.key] = {
        value: catPsi.value,
        status: classify(catPsi.value, f.threshold, critical),
        threshold: { warning: f.threshold, critical },
        bins: catPsi.bins.map((b, i) => ({ label: catPsi.labels[i] ?? `Cat ${i + 1}`, ...b })),
        displayName: f.displayName,
        source: f.source,
      };
      continue;
    }
    const actual = actualFeatures[f.key];
    if (!actual || actual.length === 0) { skipped[f.key] = 'ไม่มีข้อมูลตัวแปรนี้ในไฟล์ที่อัปโหลด'; continue; }
    csi[f.key] = {
      ...stability(reference.features[f.key], actual, f.bins, f.labels, f.threshold, critical),
      displayName: f.displayName,
      source: f.source,
    };
  }

  const triggered: string[] = [];
  if (psi.status !== 'STABLE' && psi.status !== 'NOT_AVAILABLE') triggered.push('psi');
  for (const [k, r] of Object.entries(csi)) {
    if (r.status !== 'STABLE' && r.status !== 'NOT_AVAILABLE') triggered.push(`csi:${k}`);
  }
  const availableStatuses = [psi.status, ...Object.values(csi).map(c => c.status)].filter(
    (s): s is DriftStatus => s !== 'NOT_AVAILABLE',
  );
  const overallStatus = availableStatuses.reduce<DriftStatus>(
    (w, s) => (RANK[s] > RANK[w] ? s : w),
    'STABLE',
  );

  return { referenceId: reference.meta.referenceId, psi, csi, overallStatus, triggered, skipped };
}

export type { ScoringConfig };
