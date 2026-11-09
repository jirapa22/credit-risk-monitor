/**
 * Sandbox anomaly injector — builds a seeded test file with row-level ground truth.
 *
 *   Reference rows ──bootstrap(n, seed)──► base file ──inject(type, severity, rate)──► rows + csvText + groundTruth
 *
 * - The base is a BOOTSTRAP sample (with replacement) of the Reference, never the
 *   Reference itself: identical data would give PSI = 0 by construction, while a
 *   bootstrap carries real sampling noise, so false-alarm rates of 'none' are meaningful.
 * - Works on RAW rows (before validation) so schema / type problems can be simulated.
 * - Row numbers in groundTruth are 1-based data rows of the FINAL file (after
 *   duplicate rows are appended) = CleanRow.row after runMonitoring.
 * - Every severity value is a named constant (SEVERITY_TABLE) for the thesis tables.
 * - EXPECTED_LAYER is the experiment's HYPOTHESIS, not a guarantee — Step 5 measures it.
 */
import type { AnomalySeverity, AnomalyType, ExpectedLayer, FeatureDefinition } from './types';
import { getSpecialColumnSet, resolveModelColumns } from './defaults';
import { mulberry32 } from './random';
import { getReferenceProfile, getReferenceRows, type ReferenceProfile } from './reference';
import { quantile } from './anomaly/univariate';
import { SEVERITY_TABLE, ANOMALY_KIND, expectedFor, type InjectionKind, type Sev } from './injection-meta';
export { SEVERITY_TABLE, ANOMALY_KIND, EXPECTED_LAYER, expectedFor, type InjectionKind } from './injection-meta';

/**
 * Return numeric features from featureRegistry ordered by displayOrder (ascending),
 * excluding special columns (id, date, label, score).
 */
export function orderedRegistryFeatures(
  registry: Record<string, FeatureDefinition>,
  specialCols: Set<string>,
  fallbackColumns: string[] = [],
): string[] {
  const entries = Object.entries(registry)
    .filter(([k, d]) => !specialCols.has(k) && (d.dataType === 'numeric' || !d.dataType) && d.monitoringEnabled !== false)
    .map(([k, d], idx) => ({ key: k, order: typeof d.displayOrder === 'number' ? d.displayOrder : Infinity, idx }));
  entries.sort((a, b) => a.order - b.order || a.idx - b.idx);
  if (entries.length > 0) return entries.map(e => e.key);
  return fallbackColumns.filter(c => !specialCols.has(c));
}

function rankVector(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation between two numeric arrays on rows where both are finite. */
export function spearmanCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  if (xs.length < 3) return 0;
  const rx = rankVector(xs);
  const ry = rankVector(ys);
  const meanX = rx.reduce((s, v) => s + v, 0) / rx.length;
  const meanY = ry.reduce((s, v) => s + v, 0) / ry.length;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < rx.length; i++) {
    const dx = rx[i] - meanX;
    const dy = ry[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

/**
 * Find the feature pair with the highest |Spearman correlation| in the Reference dataset,
 * or use model.experimentConfig.multivariateTargets if configured.
 */
export function selectMultivariateTargets(
  profile: ReferenceProfile,
  orderedFeatures: string[],
  model?: any,
): { targets: string[]; correlation: number } {
  const configured: string[] | undefined = model?.experimentConfig?.multivariateTargets;
  if (Array.isArray(configured) && configured.length >= 2) {
    const [f1, f2] = configured;
    const corr = spearmanCorrelation(profile.features[f1] ?? [], profile.features[f2] ?? []);
    return { targets: [...configured], correlation: corr };
  }
  const candidates = orderedFeatures.filter(f => (profile.features[f]?.length ?? 0) > 0);
  if (candidates.length < 2) {
    return { targets: candidates.slice(0, 2), correlation: 0 };
  }
  let bestPair: [string, string] = [candidates[0], candidates[1]];
  let bestCorr = 0;
  let bestAbs = -1;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const f1 = candidates[i];
      const f2 = candidates[j];
      const c = spearmanCorrelation(profile.features[f1] ?? [], profile.features[f2] ?? []);
      const abs = Math.abs(c);
      if (abs > bestAbs) {
        bestAbs = abs;
        bestCorr = c;
        bestPair = [f1, f2];
      }
    }
  }
  return { targets: bestPair, correlation: bestCorr };
}

/** Resolve default target features for an anomaly type from featureRegistry (sorted by displayOrder). */
export function resolveDefaultTargets(
  type: AnomalyType,
  orderedFeatures: string[],
  profile: ReferenceProfile,
  model?: any,
): string[] {
  if (type === 'none' || type === 'duplicate_rows') return [];
  if (type === 'swapped_columns') return orderedFeatures.slice(0, 2);
  if (type === 'multivariate_inconsistent') {
    return selectMultivariateTargets(profile, orderedFeatures, model).targets;
  }
  return orderedFeatures.slice(0, 1);
}

// ─── Public API ─────────────────────────────────────────────────────────────
export interface InjectionParams {
  type: AnomalyType;
  severity?: AnomalySeverity;      // default 'medium' ('none' for type none)
  rate?: number;                   // A: 0.05, B: 1, none: 0
  targetFeatures?: string[];
  n?: number;                      // default = Reference row count
  seed?: number;                   // default 42
}

export interface InjectionSpec extends Required<InjectionParams> {
  referenceId: string;
  kind: InjectionKind;
  injectedCount: number;
}

export interface GroundTruthRow {
  row: number;                     // 1-based data row in the final file (= CleanRow.row)
  id: string;
  injected: boolean;
  kind: InjectionKind;             // 'clean' when not injected
  type: AnomalyType | 'none';
  original?: Record<string, unknown>;
}

export interface InjectionResult {
  columns: string[];
  rows: Record<string, unknown>[];
  csvText: string;
  groundTruth: GroundTruthRow[];
  expected: { layer: ExpectedLayer; shouldAlarm: boolean };
  spec: InjectionSpec;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\n');
}

/** Pick k distinct indices from [0, n) (partial Fisher–Yates), returned sorted. */
function pickIndices(n: number, k: number, rnd: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) { const j = i + Math.floor(rnd() * (n - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k).sort((x, y) => x - y);
}

const keepType = (orig: unknown, v: number) => (Number.isInteger(Number(orig)) ? Math.round(v) : +v.toFixed(4));
const fmtThousands = (v: unknown) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 });

/**
 * Compute expected detection layer. For `unit_error`, checks whether the actual
 * injected values exceed `validation.maxValue` of the target feature(s).
 */
function resolveExpectedLayer(
  type: AnomalyType,
  severity: AnomalySeverity,
  rows: Record<string, unknown>[],
  idx: number[],
  targetFeatures: string[],
  registry: Record<string, FeatureDefinition>,
): { layer: ExpectedLayer; shouldAlarm: boolean } {
  if (type !== 'unit_error') return expectedFor(type, severity);
  if (idx.length === 0) return expectedFor(type, severity);
  let exceededRows = 0;
  for (const i of idx) {
    const rowExceeded = targetFeatures.some(f => {
      const maxVal = registry[f]?.validation?.maxValue;
      const minVal = registry[f]?.validation?.minValue;
      const v = Number(rows[i]?.[f]);
      if (!Number.isFinite(v)) return false;
      if (typeof maxVal === 'number' && v > maxVal) return true;
      if (typeof minVal === 'number' && v < minVal) return true;
      return false;
    });
    if (rowExceeded) exceededRows++;
  }
  const layer: ExpectedLayer = exceededRows >= Math.ceil(idx.length / 2) ? 'validation' : 'anomaly';
  return { layer, shouldAlarm: true };
}

export function injectAnomaly(model: any, params: InjectionParams): InjectionResult {
  const referenceId: string = model.referenceDatasetId;
  const registry = (model.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const cols = resolveModelColumns(model);
  const idColumn = cols.idColumn;
  const labelColumn = cols.labelColumn ?? undefined;
  const scoreColumn = cols.scoreColumn ?? undefined;
  const specialCols = getSpecialColumnSet(model);
  const ref = getReferenceRows(referenceId);
  const profile = getReferenceProfile(referenceId, model.scoring, { labelColumn, scoreColumn });

  const type = params.type;
  const kind = ANOMALY_KIND[type];
  const severity: AnomalySeverity = type === 'none' ? 'none' : params.severity && params.severity !== 'none' ? params.severity : 'medium';
  const rate = type === 'none' ? 0 : params.rate ?? (kind === 'drift' ? 1 : 0.05);
  if (!(rate >= 0 && rate <= 1)) throw new Error('rate ต้องอยู่ระหว่าง 0 ถึง 1');
  const n = params.n ?? ref.rows.length;
  const seed = params.seed ?? 42;
  const orderedFeatures = orderedRegistryFeatures(registry, specialCols, ref.columns);
  const resolvedDefaults = resolveDefaultTargets(type, orderedFeatures, profile, model);
  const targetFeatures = params.targetFeatures?.length ? params.targetFeatures : resolvedDefaults;
  const rnd = mulberry32(seed);

  // ── Bootstrap base file (unique ids so clean files never trigger DUPLICATE_ID) ──
  const width = String(n).length;
  const rows: Record<string, unknown>[] = Array.from({ length: n }, (_, i) => ({
    ...ref.rows[Math.floor(rnd() * ref.rows.length)],
    [idColumn]: `BS${String(i + 1).padStart(width, '0')}`,
  }));
  let columns = [...ref.columns];
  const gt: GroundTruthRow[] = rows.map((r, i) => ({
    row: i + 1,
    id: String(r[idColumn] ?? `ROW_${i + 1}`),
    injected: false,
    kind: 'clean',
    type: 'none',
  }));

  const k = Math.round(rate * n);
  const idx = type === 'none' ? [] : pickIndices(n, k, rnd);
  const sevKey = severity as Sev;
  const sorted = (f: string) => [...(profile.features[f] ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  const mark = (i: number, original: Record<string, unknown>) => { gt[i] = { ...gt[i], injected: true, kind, type, original }; };
  const snapshot = (r: Record<string, unknown>, colsToSnap: string[]) => Object.fromEntries(colsToSnap.map(c => [c, r[c]]));

  switch (type) {
    case 'none': break;

    case 'unit_error':
    case 'negative_value': {
      const factor = SEVERITY_TABLE[type][sevKey];
      for (const i of idx) { mark(i, snapshot(rows[i], targetFeatures)); for (const f of targetFeatures) rows[i][f] = keepType(rows[i][f], Number(rows[i][f]) * factor); }
      break;
    }
    case 'extreme_outlier': {
      const factor = SEVERITY_TABLE.extreme_outlier[sevKey];
      const p99 = Object.fromEntries(targetFeatures.map(f => [f, quantile(sorted(f), 0.99)]));
      for (const i of idx) { mark(i, snapshot(rows[i], targetFeatures)); for (const f of targetFeatures) rows[i][f] = keepType(rows[i][f], p99[f] * factor); }
      break;
    }
    case 'type_error': {
      const tpl = SEVERITY_TABLE.type_error[sevKey];
      for (const i of idx) { mark(i, snapshot(rows[i], targetFeatures)); for (const f of targetFeatures) rows[i][f] = tpl.replace('<value>', fmtThousands(rows[i][f])); }
      break;
    }
    case 'missing_injection': {
      for (const i of idx) { mark(i, snapshot(rows[i], targetFeatures)); for (const f of targetFeatures) rows[i][f] = ''; }
      break;
    }
    case 'swapped_columns': {
      const [a, b] = targetFeatures;
      for (const i of idx) { mark(i, snapshot(rows[i], [a, b])); [rows[i][a], rows[i][b]] = [rows[i][b], rows[i][a]]; }
      break;
    }
    case 'duplicate_rows': {
      for (const i of idx) {
        const copy = { ...rows[i] };
        rows.push(copy);
        gt.push({ row: rows.length, id: String(copy[idColumn] ?? `ROW_${rows.length}`), injected: true, kind, type, original: { duplicateOfRow: i + 1 } });
      }
      break;
    }
    case 'multivariate_inconsistent': {
      const q = SEVERITY_TABLE.multivariate_inconsistent[sevKey];
      const pool = (f: string, p: number, side: 'le' | 'ge') => {
        const s = sorted(f), cut = quantile(s, p);
        const out = s.filter(v => (side === 'le' ? v <= cut : v >= cut));
        return out.length ? out : [cut];
      };
      const draw = (p: number[]) => p[Math.floor(rnd() * p.length)];
      if (targetFeatures.length >= 3) {
        const [f1, f2, f3] = targetFeatures;
        const p1 = pool(f1, q.income, 'le');
        const p2 = pool(f2, q.loan, 'ge');
        const p3 = pool(f3, q.dti, 'le');
        for (const i of idx) {
          mark(i, snapshot(rows[i], [f1, f2, f3]));
          rows[i][f1] = draw(p1);
          rows[i][f2] = draw(p2);
          rows[i][f3] = draw(p3);
        }
      } else {
        const [f1, f2] = targetFeatures;
        const corr = spearmanCorrelation(profile.features[f1] ?? [], profile.features[f2] ?? []);
        // Contradict the Reference correlation direction while keeping each marginal value inside Reference tails:
        //  - Positive correlation (corr >= 0): f1 in upper tail (>= q.loan) and f2 in lower tail (<= q.dti)
        //  - Negative correlation (corr < 0):  both f1 and f2 in upper tail (>= q.loan)
        const p1 = pool(f1, q.loan, 'ge');
        const p2 = corr >= 0 ? pool(f2, q.dti, 'le') : pool(f2, q.loan, 'ge');
        for (const i of idx) {
          mark(i, snapshot(rows[i], [f1, f2]));
          rows[i][f1] = draw(p1);
          rows[i][f2] = draw(p2);
        }
      }
      break;
    }
    case 'schema_break': {
      // File-level: every row is affected, so all rows are ground-truth "injected".
      const mode = SEVERITY_TABLE.schema_break[sevKey];
      const rename = (c: string) => (mode === 'rename_case' ? c.replace(/(^|_)([a-z])/g, (_, s, ch) => s + ch.toUpperCase()) : c.slice(0, -1));
      for (const f of targetFeatures) {
        if (mode === 'drop_column') {
          columns = columns.filter(c => c !== f);
          for (const r of rows) delete r[f];
        } else {
          const nf = rename(f);
          columns = columns.map(c => (c === f ? nf : c));
          for (const r of rows) { r[nf] = r[f]; delete r[f]; }
        }
      }
      for (let i = 0; i < gt.length; i++) gt[i] = { ...gt[i], injected: true, kind, type, original: { schema: mode, columns: targetFeatures } };
      break;
    }
    case 'mean_shift': {
      const delta = SEVERITY_TABLE.mean_shift[sevKey];
      for (const i of idx) { mark(i, snapshot(rows[i], targetFeatures)); for (const f of targetFeatures) rows[i][f] = keepType(rows[i][f], Number(rows[i][f]) * (1 + delta)); }
      break;
    }
    case 'variance_change': {
      const factor = SEVERITY_TABLE.variance_change[sevKey];
      const meta = Object.fromEntries(targetFeatures.map(f => {
        const log = registry[f]?.anomalyTransform === 'log1p';
        const vals = (profile.features[f] ?? []).map(v => (log ? Math.log1p(v) : v)).sort((a, b) => a - b);
        return [f, { log, med: quantile(vals, 0.5) }];
      }));
      for (const i of idx) {
        mark(i, snapshot(rows[i], targetFeatures));
        for (const f of targetFeatures) {
          const { log, med } = meta[f];
          const x = Number(rows[i][f]);
          const y = log ? Math.log1p(Math.max(x, 0)) : x;
          const y2 = med + factor * (y - med);
          rows[i][f] = keepType(rows[i][f], log ? Math.expm1(y2) : y2);
        }
      }
      break;
    }
  }

  const injectedCount = gt.filter(g => g.injected).length;
  const expected = resolveExpectedLayer(type, severity, rows, idx, targetFeatures, registry);
  return {
    columns,
    rows,
    csvText: toCsv(rows, columns),
    groundTruth: gt,
    expected,
    spec: { type, severity, rate, targetFeatures, n, seed, referenceId, kind, injectedCount },
  };
}
