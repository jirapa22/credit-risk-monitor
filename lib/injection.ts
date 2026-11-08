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
import { mulberry32 } from './random';
import { getReferenceProfile, getReferenceRows } from './reference';
import { quantile } from './anomaly/univariate';
import { SEVERITY_TABLE, ANOMALY_KIND, expectedFor, type InjectionKind, type Sev } from './injection-meta';
export { SEVERITY_TABLE, ANOMALY_KIND, EXPECTED_LAYER, expectedFor, type InjectionKind } from './injection-meta';


const DEFAULT_TARGETS: Record<AnomalyType, string[]> = {
  none: [],
  unit_error: ['monthly_income'], extreme_outlier: ['monthly_income'], negative_value: ['monthly_income'],
  type_error: ['monthly_income'], missing_injection: ['monthly_income'],
  swapped_columns: ['monthly_income', 'loan_amount'], duplicate_rows: [],
  multivariate_inconsistent: ['monthly_income', 'loan_amount', 'dti_ratio'],
  schema_break: ['monthly_income'],
  mean_shift: ['monthly_income'], variance_change: ['monthly_income'],
};

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

export function injectAnomaly(model: any, params: InjectionParams): InjectionResult {
  const referenceId: string = model.referenceDatasetId;
  const registry = (model.featureRegistry ?? {}) as Record<string, FeatureDefinition>;
  const ref = getReferenceRows(referenceId);
  const profile = getReferenceProfile(referenceId, model.scoring);

  const type = params.type;
  const kind = ANOMALY_KIND[type];
  const severity: AnomalySeverity = type === 'none' ? 'none' : params.severity && params.severity !== 'none' ? params.severity : 'medium';
  const rate = type === 'none' ? 0 : params.rate ?? (kind === 'drift' ? 1 : 0.05);
  if (!(rate >= 0 && rate <= 1)) throw new Error('rate ต้องอยู่ระหว่าง 0 ถึง 1');
  const n = params.n ?? ref.rows.length;
  const seed = params.seed ?? 42;
  const targetFeatures = params.targetFeatures?.length ? params.targetFeatures : DEFAULT_TARGETS[type];
  const rnd = mulberry32(seed);

  // ── Bootstrap base file (unique ids so clean files never trigger DUPLICATE_ID) ──
  const width = String(n).length;
  const rows: Record<string, unknown>[] = Array.from({ length: n }, (_, i) => ({
    ...ref.rows[Math.floor(rnd() * ref.rows.length)],
    customer_id: `BS${String(i + 1).padStart(width, '0')}`,
  }));
  let columns = [...ref.columns];
  const gt: GroundTruthRow[] = rows.map((r, i) => ({ row: i + 1, id: String(r.customer_id), injected: false, kind: 'clean', type: 'none' }));

  const k = Math.round(rate * n);
  const idx = type === 'none' ? [] : pickIndices(n, k, rnd);
  const sevKey = severity as Sev;
  const sorted = (f: string) => [...(profile.features[f] ?? [])].sort((a, b) => a - b);
  const mark = (i: number, original: Record<string, unknown>) => { gt[i] = { ...gt[i], injected: true, kind, type, original }; };
  const snapshot = (r: Record<string, unknown>, cols: string[]) => Object.fromEntries(cols.map(c => [c, r[c]]));

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
        gt.push({ row: rows.length, id: String(copy.customer_id), injected: true, kind, type, original: { duplicateOfRow: i + 1 } });
      }
      break;
    }
    case 'multivariate_inconsistent': {
      const q = SEVERITY_TABLE.multivariate_inconsistent[sevKey];
      const [fi, fl, fd] = targetFeatures;
      const pool = (f: string, p: number, side: 'le' | 'ge') => {
        const s = sorted(f), cut = quantile(s, p);
        const out = s.filter(v => (side === 'le' ? v <= cut : v >= cut));
        return out.length ? out : [cut];
      };
      const pi = pool(fi, q.income, 'le'), pl = pool(fl, q.loan, 'ge'), pd = pool(fd, q.dti, 'le');
      const draw = (p: number[]) => p[Math.floor(rnd() * p.length)];
      for (const i of idx) { mark(i, snapshot(rows[i], [fi, fl, fd])); rows[i][fi] = draw(pi); rows[i][fl] = draw(pl); rows[i][fd] = draw(pd); }
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
  return {
    columns,
    rows,
    csvText: toCsv(rows, columns),
    groundTruth: gt,
    expected: expectedFor(type, severity),
    spec: { type, severity, rate, targetFeatures, n, seed, referenceId, kind, injectedCount },
  };
}
