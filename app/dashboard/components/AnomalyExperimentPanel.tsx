'use client';
/**
 * Model Sandbox → 🧪 Anomaly Experiment
 *
 *  Part 1 "ทดลองเอง": POST /api/sandbox/experiments/run (≤ 10 seeds) + history + CSV export
 *  Part 2 "ผลการทดลองเต็ม": static /experiments/latest_summary.json written by `npm run experiments`
 *
 * Only client-safe constants are imported (lib/injection-meta) — no pipeline code in the bundle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { SEVERITY_TABLE, ANOMALY_KIND, expectedFor } from '@/lib/injection-meta';
import type { AnomalySeverity, AnomalyType, ExpectedLayer } from '@/lib/types';

// ─── Static metadata ────────────────────────────────────────────────────────
const DETECTORS = ['validation', 'iqr', 'mad', 'cross_field', 'isolation_forest', 'lof', 'anomaly_any', 'all_layers'] as const;
type Detector = typeof DETECTORS[number];
const DETECTOR_LABEL: Record<Detector, string> = {
  validation: 'Validation (ชั้น 1–2)', iqr: 'IQR', mad: 'MAD (Robust Z)', cross_field: 'Cross-field',
  isolation_forest: 'Isolation Forest', lof: 'LOF', anomaly_any: 'ชั้น 3–4 รวม', all_layers: 'ทุกชั้นรวม',
};
const LAYER_LABEL: Record<ExpectedLayer, string> = { validation: 'validation', anomaly: 'anomaly', drift: 'drift', none: 'ไม่มี' };

const TYPE_INFO: Record<AnomalyType, string> = {
  unit_error: 'กรอกผิดหน่วย — รายได้ถูกคูณด้วย ×10 / ×100 / ×1000',
  extreme_outlier: 'ค่าสุดโต่ง — ตั้งเป็น p99 ของ Reference × ตัวคูณ',
  negative_value: 'ค่าติดลบในตัวแปรที่ต้องเป็นบวก',
  type_error: 'ชนิดข้อมูลผิด — ตัวเลขกลายเป็นข้อความ',
  missing_injection: 'ค่าว่างในคอลัมน์ที่จำเป็น',
  swapped_columns: 'สลับค่ารายได้กับวงเงินกู้ในแถวเดียวกัน',
  duplicate_rows: 'แถวซ้ำ (customer_id เดิม) ถูกแทรกต่อท้าย',
  multivariate_inconsistent: 'แต่ละค่าปกติ แต่รวมกันขัดแย้ง (รายได้ต่ำ + วงเงินสูง + DTI ต่ำ)',
  schema_break: 'โครงสร้างไฟล์เสีย — เปลี่ยนชื่อหรือลบคอลัมน์ (ทั้งไฟล์)',
  mean_shift: 'ลูกค้าจริงเปลี่ยน — รายได้เฉลี่ยลดลงทั้งพอร์ต',
  variance_change: 'ลูกค้าจริงเปลี่ยน — การกระจายของรายได้กว้างขึ้น',
  none: 'ไม่ฉีดอะไรเลย (bootstrap จาก Reference) — ใช้วัดการเตือนผิด',
};
const GROUPS: { label: string; types: AnomalyType[] }[] = [
  { label: 'กลุ่ม A — ข้อมูลผิด', types: (Object.keys(ANOMALY_KIND) as AnomalyType[]).filter(t => ANOMALY_KIND[t] === 'data_error') },
  { label: 'กลุ่ม B — drift จริง', types: (Object.keys(ANOMALY_KIND) as AnomalyType[]).filter(t => ANOMALY_KIND[t] === 'drift') },
  { label: 'ไม่ฉีด', types: ['none'] },
];
const RATES = [0.01, 0.05, 0.10, 0.20, 0.30];
const SEVS = ['low', 'medium', 'high'] as const;

function severityLabel(type: AnomalyType, sev: typeof SEVS[number]): string {
  if (type === 'none') return '';
  if (type === 'multivariate_inconsistent') {
    const v = SEVERITY_TABLE.multivariate_inconsistent[sev];
    return `p${Math.round(v.income * 100)}/p${Math.round(v.loan * 100)}/p${Math.round(v.dti * 100)}`;
  }
  const v = SEVERITY_TABLE[type][sev];
  switch (type) {
    case 'unit_error': return `×${v}`;
    case 'extreme_outlier': return `p99 ×${v}`;
    case 'negative_value': return `×${v}`;
    case 'type_error': return `"${v === '<value> บาท' ? '25,000 บาท' : v}"`;
    case 'missing_injection': return 'ค่าว่าง';
    case 'swapped_columns': return 'สลับคอลัมน์';
    case 'duplicate_rows': return 'คัดลอกแถว';
    case 'schema_break': return ({ rename_case: 'เปลี่ยนตัวพิมพ์', rename_typo: 'สะกดผิด', drop_column: 'ลบคอลัมน์' } as Record<string, string>)[String(v)] ?? String(v);
    case 'mean_shift': return `${Math.round(Number(v) * 100)}%`;
    case 'variance_change': return `×${v}`;
  }
  return String(v);
}

// ─── Types of API / JSON payloads ───────────────────────────────────────────
interface Stat { n: number; mean: number | null; sd: number | null; ciLow: number | null; ciHigh: number | null }
interface DriftSnap { status: string; psi: number; csi: Record<string, number> }
interface RunResponse {
  experimentId: string; type: AnomalyType; severity: AnomalySeverity; rate: number; seeds: number[];
  expected: { layer: ExpectedLayer; shouldAlarm: boolean };
  detectors: Record<Detector, { TP: number; FP: number; FN: number; TN: number; precision: Stat; recall: Stat; f1: Stat; flagRate: Stat }>;
  file: Record<string, Stat>;
  msPerTrial: number;
  trials: { seed: number; kind: string; rowCount: number; injectedCount: number; routedLayer: ExpectedLayer; routingCorrect: boolean; blocked: boolean; drift: DriftSnap | null; driftExcludingFlagged: DriftSnap | null }[];
  error?: string; errors?: string[];
}
interface HistoryRun {
  runId: string; createdAt: string; experimentId: string; rate?: number;
  anomaly: { type: string; severity: string; seed?: number };
  expected: { layer: string }; outcome: string; detected: boolean;
  drift: { overallStatus: string; psi: number } | null;
  fileMetrics?: { routedLayer: string; routingCorrect: boolean };
  metrics?: Record<string, { recall: number | null }>;
}
interface SummaryMeta {
  commit: string; startedAt: string; elapsedSec: number; trials: number; msPerTrial: number; quick?: boolean;
}
interface SummaryRow {
  type: string; severity: string; rate: number; detector: string;
  recall_mean: number | null; recall_ci_high: number | null;
}
interface BatchRow {
  type: string; severity: string; rate: number; expected_layer: string; trials: number;
  falseAlarm_rate: number | null; rescued_rate: number | null; detected_rate: number | null;
  preserved_rate: number | null; routingCorrect_rate: number | null; blocked_rate: number | null;
  [k: string]: string | number | null | undefined;
}
interface FullSummary { meta: SummaryMeta; summary: SummaryRow[]; batch: BatchRow[] }

// ─── Small UI helpers ───────────────────────────────────────────────────────
const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(d));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(0)}%`);
const STATUS_STYLE: Record<string, string> = {
  STABLE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  WARNING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  CRITICAL: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  BLOCKED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};
const RANK: Record<string, number> = { STABLE: 0, WARNING: 1, CRITICAL: 2, BLOCKED: 3 };
function StatusBadge({ s }: { s: string }) {
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${STATUS_STYLE[s] ?? STATUS_STYLE.BLOCKED}`}>{s}</span>;
}
function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold text-indigo-300 uppercase tracking-wider bg-indigo-500/10 px-2 py-0.5 rounded">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}
/** red (0) → amber → green (1) */
function heat(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'rgba(51,65,85,0.4)';
  const h = Math.max(0, Math.min(1, v)) * 130;   // 0 = red, 130 = green
  return `hsla(${h}, 70%, 38%, 0.85)`;
}
const mode = <T,>(a: T[]): T | undefined => {
  const m = new Map<T, number>(); a.forEach(x => m.set(x, (m.get(x) ?? 0) + 1));
  return [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
};

// ════════════════════════════════════════════════════════════════════════════
export default function AnomalyExperimentPanel() {
  const [section, setSection] = useState<'try' | 'full'>('try');
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {([['try', '🔬 ทดลองเอง'], ['full', '📊 ผลการทดลองเต็ม']] as const).map(([k, label]) => (
          <button key={k} id={`anomaly-section-${k}`} onClick={() => setSection(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${section === k ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-200' : 'border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>
      {section === 'try' ? <TryPanel /> : <FullResultsPanel />}
    </div>
  );
}

// ─── Part 1: interactive trial ──────────────────────────────────────────────
function TryPanel() {
  const [type, setType] = useState<AnomalyType>('extreme_outlier');
  const [severity, setSeverity] = useState<typeof SEVS[number]>('medium');
  const [rate, setRate] = useState(0.05);
  const [nSeeds, setNSeeds] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [history, setHistory] = useState<HistoryRun[]>([]);

  const kind = ANOMALY_KIND[type];
  const isA = kind === 'data_error';

  const loadHistory = useCallback(() => {
    fetch('/api/sandbox/experiments', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => setHistory(((j.runs ?? []) as HistoryRun[]).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50)))
      .catch(() => { /* history is optional */ });
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const body: Record<string, unknown> = { type, seeds: Array.from({ length: nSeeds }, (_, i) => i + 1) };
      if (type !== 'none') body.severity = severity;
      if (isA) body.rate = rate;
      const r = await fetch('/api/sandbox/experiments/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await r.json()) as RunResponse;
      if (!r.ok) throw new Error([j.error, ...(j.errors ?? [])].filter(Boolean).join(' — '));
      setResult(j);
      loadHistory();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      {/* Form */}
      <div className="xl:col-span-1 space-y-4">
        <Card title="⚙️ ตั้งค่าการทดลอง">
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="exp-type" className="text-[11px] text-slate-400">ประเภทความผิดปกติ</label>
              <select id="exp-type" value={type} onChange={e => setType(e.target.value as AnomalyType)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:border-indigo-500 outline-none">
                {GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.types.map(t => <option key={t} value={t}>{t}</option>)}
                  </optgroup>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 leading-snug">{TYPE_INFO[type]}</p>
            </div>

            {type !== 'none' && (
              <div className="space-y-1">
                <span className="text-[11px] text-slate-400">ความรุนแรง</span>
                <div className="grid grid-cols-3 gap-1">
                  {SEVS.map(s => (
                    <button key={s} id={`exp-sev-${s}`} onClick={() => setSeverity(s)}
                      className={`px-2 py-1.5 rounded-lg text-[11px] border transition-all ${severity === s ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
                      <div className="font-semibold">{s}</div>
                      <div className="opacity-80">{severityLabel(type, s)}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1">
              <span className="text-[11px] text-slate-400">สัดส่วนแถวที่ฉีด {isA ? '' : '(กลุ่ม B ใช้ทุกแถว / none ไม่ฉีด)'}</span>
              <div className="grid grid-cols-5 gap-1">
                {RATES.map(r => (
                  <button key={r} id={`exp-rate-${r}`} disabled={!isA} onClick={() => setRate(r)}
                    className={`px-1 py-1.5 rounded-lg text-[11px] border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${isA && rate === r ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
                    {Math.round(r * 100)}%
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="exp-seeds" className="text-[11px] text-slate-400">จำนวน seed: <span className="text-slate-200 font-semibold">{nSeeds}</span></label>
              <input id="exp-seeds" type="range" min={1} max={10} value={nSeeds} onChange={e => setNSeeds(Number(e.target.value))} className="w-full accent-indigo-500" />
            </div>

            <div className="text-[11px] text-slate-500 bg-slate-950/60 rounded-lg px-2 py-1.5">
              คาดว่าจะจับได้ที่ชั้น: <span className="text-indigo-300 font-semibold">{LAYER_LABEL[expectedFor(type, type === 'none' ? 'none' : severity).layer]}</span>
            </div>

            <button id="exp-run" onClick={run} disabled={loading}
              className="w-full py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/20 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-60 transition-all">
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />กำลังรัน {nSeeds} seed…
                </span>
              ) : '▶ รันการทดลอง'}
            </button>
            {error && <p className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-2 py-1.5">{error}</p>}
          </div>
        </Card>
      </div>

      {/* Results */}
      <div className="xl:col-span-2 space-y-4">
        {result ? <TrialResultView r={result} /> : (
          <div className="h-full min-h-[240px] flex items-center justify-center bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl text-sm text-slate-500">
            เลือกประเภทความผิดปกติแล้วกด “รันการทดลอง”
          </div>
        )}
      </div>

      {/* History */}
      <div className="xl:col-span-3">
        <Card title="🗂️ ประวัติการทดลอง" right={
          <a id="exp-export" href="/api/sandbox/experiments/export" className="text-[11px] font-semibold px-3 py-1 rounded-lg border border-indigo-500/40 text-indigo-200 hover:bg-indigo-500/10 transition-all">⬇ Export CSV</a>
        }>
          {history.length === 0 ? <p className="text-xs text-slate-500">ยังไม่มีการทดลองที่บันทึกไว้</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-slate-400">
                  <tr className="border-b border-slate-800">
                    {['เวลา', 'type', 'severity', 'rate', 'seed', 'คาด', 'จับได้ที่', 'Recall (ทุกชั้น)', 'drift', 'PSI', 'ผล'].map(h => <th key={h} className="text-left font-medium py-1.5 pr-3">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.runId} className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30">
                      <td className="py-1 pr-3 whitespace-nowrap">{new Date(h.createdAt).toLocaleString('th-TH')}</td>
                      <td className="pr-3">{h.anomaly.type}</td>
                      <td className="pr-3">{h.anomaly.severity}</td>
                      <td className="pr-3">{h.rate === undefined ? '–' : pct(h.rate)}</td>
                      <td className="pr-3">{h.anomaly.seed ?? '–'}</td>
                      <td className="pr-3">{h.expected.layer}</td>
                      <td className="pr-3">{h.fileMetrics ? `${h.fileMetrics.routedLayer} ${h.fileMetrics.routingCorrect ? '✅' : '❌'}` : '–'}</td>
                      <td className="pr-3">{fmt(h.metrics?.all_layers?.recall)}</td>
                      <td className="pr-3">{h.drift ? <StatusBadge s={h.drift.overallStatus} /> : <StatusBadge s="BLOCKED" />}</td>
                      <td className="pr-3">{h.drift ? h.drift.psi.toFixed(4) : '–'}</td>
                      <td className="pr-3 font-semibold">{h.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function TrialResultView({ r }: { r: RunResponse }) {
  const kind = r.trials[0]?.kind;
  const noPositives = kind === 'drift' || kind === 'clean';
  const routed = mode(r.trials.map(t => t.routedLayer)) ?? 'none';
  const routedOk = r.trials.filter(t => t.routingCorrect).length;

  const chart = DETECTORS.map(d => ({
    name: DETECTOR_LABEL[d],
    value: noPositives ? r.detectors[d].flagRate.mean : r.detectors[d].recall.mean,
  }));

  // Drift comparison: mean PSI / CSI over seeds, worst status, and whether statuses differ in any seed
  const drift = useMemo(() => {
    const ok = r.trials.filter(t => t.drift);
    if (ok.length === 0) return null;
    const keys = Object.keys(ok[0].drift!.csi);
    const avg = (pick: (t: typeof ok[number]) => number) => ok.reduce((s, t) => s + pick(t), 0) / ok.length;
    const exOf = (t: typeof ok[number]) => t.driftExcludingFlagged ?? t.drift!;
    const worst = (xs: string[]) => xs.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'STABLE');
    return {
      rows: [{ key: 'PSI (คะแนนรวม)', all: avg(t => t.drift!.psi), ex: avg(t => exOf(t).psi) },
        ...keys.map(k => ({ key: `CSI ${k}`, all: avg(t => t.drift!.csi[k] ?? 0), ex: avg(t => exOf(t).csi[k] ?? 0) }))],
      statusAll: worst(ok.map(t => t.drift!.status)),
      statusEx: worst(ok.map(t => exOf(t).status)),
      differs: ok.some(t => exOf(t).status !== t.drift!.status),
      blockedSeeds: r.trials.length - ok.length,
    };
  }, [r]);

  return (
    <>
      {/* (a) routing badge */}
      <div className="flex flex-wrap items-center gap-3 bg-slate-900/60 border border-slate-800 rounded-2xl px-4 py-3">
        <span className="text-xs text-slate-400">ผลการกำหนดชั้น ({r.trials.length} seed):</span>
        <span className="text-sm font-semibold text-slate-100">
          คาด: <span className="text-indigo-300">{LAYER_LABEL[r.expected.layer]}</span> → จับได้ที่: <span className="text-indigo-300">{LAYER_LABEL[routed]}</span>{' '}
          {routedOk === r.trials.length ? '✅' : routedOk === 0 ? '❌' : `⚠️ ${routedOk}/${r.trials.length}`}
        </span>
        <span className="ml-auto text-[11px] text-slate-500">{r.trials[0]?.rowCount} แถว · ฉีด {r.trials[0]?.injectedCount} แถว · {fmt(r.msPerTrial, 0)} ms/trial</span>
      </div>

      {/* (b) detector table */}
      <Card title="🎯 ผลรายตัวตรวจ (เฉลี่ยทุก seed)">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-slate-400">
              <tr className="border-b border-slate-800">
                {['ตัวตรวจ', 'TP', 'FP', 'FN', 'TN', 'Precision', 'Recall', 'F1', 'Flag rate'].map(h => <th key={h} className="text-left font-medium py-1.5 pr-3">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {DETECTORS.map(d => {
                const m = r.detectors[d];
                const strong = d === 'anomaly_any' || d === 'all_layers';
                return (
                  <tr key={d} className={`border-b border-slate-800/60 ${strong ? 'text-slate-100 font-semibold' : 'text-slate-300'}`}>
                    <td className="py-1 pr-3">{DETECTOR_LABEL[d]}</td>
                    <td className="pr-3">{fmt(m.TP, 1)}</td><td className="pr-3">{fmt(m.FP, 1)}</td>
                    <td className="pr-3">{fmt(m.FN, 1)}</td><td className="pr-3">{fmt(m.TN, 1)}</td>
                    <td className="pr-3">{fmt(m.precision.mean)}</td><td className="pr-3">{fmt(m.recall.mean)}</td>
                    <td className="pr-3">{fmt(m.f1.mean)}</td><td className="pr-3">{pct(m.flagRate.mean)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500">
          หมายเหตุ: Recall ของชั้น 3–4 (IQR, MAD, Cross-field, IF, LOF, ชั้น 3–4 รวม) คิดจากแถวที่ผ่าน validation มาแล้วเท่านั้น
          ส่วน Validation และ “ทุกชั้นรวม” คิดจากทุกแถวในไฟล์ · “–” = ไม่มีค่า (ตัวหารเป็น 0)
        </p>
      </Card>

      {/* (c) bar chart */}
      <Card title={noPositives ? '📊 สัดส่วนแถวที่โดนธง (ไม่มีข้อมูลผิดจริง — เป็นการติดธงลูกค้าจริงโดยไม่จำเป็น)' : '📊 Recall รายตัวตรวจ'}>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ top: 8, right: 8, left: -16, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} angle={-30} textAnchor="end" interval={0} />
              <YAxis domain={[0, noPositives ? 'auto' : 1]} tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={v => (noPositives ? `${(v * 100).toFixed(0)}%` : v)} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                formatter={(v: unknown) => (typeof v === 'number' ? (noPositives ? `${(v * 100).toFixed(1)}%` : v.toFixed(3)) : '–')} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {chart.map((c, i) => <Cell key={i} fill={noPositives ? '#f59e0b' : heat(c.value)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* (d) drift comparison */}
      <Card title="🌊 เทียบ Drift: ข้อมูลทั้งหมด vs ตัดแถวที่โดนธง (ตัดทั้งสองฝั่ง)">
        {!drift ? <p className="text-xs text-slate-400">ไฟล์ไม่ผ่าน validation — ไม่ได้คำนวณ PSI/CSI <StatusBadge s="BLOCKED" /></p> : (
          <>
            <div className="grid grid-cols-2 gap-3">
              {([['ข้อมูลทั้งหมด (ผลทางการ)', drift.statusAll, 'all'], ['ตัดแถวที่โดนธง (what-if)', drift.statusEx, 'ex']] as const).map(([label, st, key]) => (
                <div key={key} className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between"><span className="text-[11px] text-slate-400">{label}</span><StatusBadge s={st} /></div>
                  {drift.rows.map(row => (
                    <div key={row.key} className="flex justify-between text-[11px]">
                      <span className="text-slate-400">{row.key}</span>
                      <span className="text-slate-100 font-mono">{(key === 'all' ? row.all : row.ex).toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {drift.differs && (
              <div className="text-[12px] text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
                ⚠️ การตัดแถวที่โดนธงทำให้ผลเปลี่ยน — ถ้าเป็น drift จริง การตัดแถวอาจลบสัญญาณออก ควรให้ผู้ใช้ตรวจสอบก่อนตัดสินใจ
              </div>
            )}
            <p className="text-[11px] text-slate-500">
              ค่าเฉลี่ยจาก {r.trials.length - drift.blockedSeeds} seed · สถานะแสดงระดับที่รุนแรงที่สุดในทุก seed
              {drift.blockedSeeds > 0 && ` · ${drift.blockedSeeds} seed ไม่ผ่าน validation`}
            </p>
          </>
        )}
      </Card>
    </>
  );
}

// ─── Part 2: full grid results ──────────────────────────────────────────────
function FullResultsPanel() {
  const [data, setData] = useState<FullSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [sev, setSev] = useState<typeof SEVS[number]>('medium');

  useEffect(() => {
    fetch('/experiments/latest_summary.json', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <div className="bg-slate-900/40 border border-dashed border-slate-700 rounded-2xl p-8 text-center text-sm text-slate-400">ยังไม่มีผลการทดลองเต็ม — รัน <code className="text-indigo-300">npm run experiments</code></div>;
  if (!data) return <div className="text-sm text-slate-500 p-6">กำลังโหลดผลการทดลอง…</div>;

  const { meta, summary, batch } = data;
  const typesA = GROUPS[0].types.filter(t => t !== 'schema_break');
  const sget = (type: string, severity: string, rate: number, detector: string) =>
    summary.find(r => r.type === type && r.severity === severity && Math.abs(r.rate - rate) < 1e-9 && r.detector === detector);

  // file-level table: A at rate 5% / medium; B at medium; schema_break medium; none
  const fileRows = [
    ...GROUPS[0].types.map(t => batch.find(b => b.type === t && b.severity === 'medium' && (t === 'schema_break' || Math.abs(b.rate - 0.05) < 1e-9))),
    ...GROUPS[1].types.map(t => batch.find(b => b.type === t && b.severity === 'medium')),
    batch.find(b => b.type === 'none'),
  ].filter((b): b is BatchRow => Boolean(b));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 bg-slate-900/60 border border-slate-800 rounded-2xl px-4 py-3 text-xs text-slate-300">
        <span>🧪 <b className="text-slate-100">{Number(meta.trials).toLocaleString()}</b> trial</span>
        <span>commit <code className="text-indigo-300">{meta.commit}</code></span>
        <span>รันเมื่อ {new Date(meta.startedAt).toLocaleString('th-TH')}</span>
        <span>ใช้เวลา {Math.round(meta.elapsedSec)} วินาที ({Number(meta.msPerTrial).toFixed(0)} ms/trial)</span>
        {meta.quick && <span className="text-amber-300">⚠️ ผลจากโหมด --quick</span>}
      </div>

      <Card title="🔥 Heatmap: Recall (ทุกชั้นรวม) — type × rate" right={
        <div className="flex gap-1">
          {SEVS.map(s => (
            <button key={s} id={`heat-sev-${s}`} onClick={() => setSev(s)}
              className={`px-2 py-0.5 rounded text-[11px] border ${sev === s ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>{s}</button>
          ))}
        </div>
      }>
        <div className="overflow-x-auto">
          <table className="text-[11px] border-separate border-spacing-1">
            <thead><tr><th className="text-left text-slate-400 font-medium pr-2">type</th>{RATES.map(r => <th key={r} className="text-slate-400 font-medium w-16">{Math.round(r * 100)}%</th>)}</tr></thead>
            <tbody>
              {typesA.map(t => (
                <tr key={t}>
                  <td className="text-slate-300 pr-2 whitespace-nowrap">{t} <span className="text-slate-500">({severityLabel(t, sev)})</span></td>
                  {RATES.map(rt => {
                    const v = sget(t, sev, rt, 'all_layers')?.recall_mean ?? null;
                    return <td key={rt} className="text-center font-mono text-white rounded" style={{ background: heat(v) }} title={`${t} · ${sev} · ${rt}`}>{fmt(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500">สีแดง = จับไม่ได้ (0) → สีเขียว = จับได้ครบ (1)</p>
      </Card>

      <Card title="⚖️ เทียบตัวตรวจชั้น 3–4: Recall เฉลี่ย ± 95% CI (rate 5%, severity medium)">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-slate-400"><tr className="border-b border-slate-800">
              <th className="text-left font-medium py-1.5 pr-3">type</th>
              {(['iqr', 'mad', 'isolation_forest', 'lof'] as const).map(d => <th key={d} className="text-left font-medium pr-3">{DETECTOR_LABEL[d]}</th>)}
            </tr></thead>
            <tbody>
              {typesA.map(t => (
                <tr key={t} className="border-b border-slate-800/60 text-slate-300">
                  <td className="py-1 pr-3">{t}</td>
                  {(['iqr', 'mad', 'isolation_forest', 'lof'] as const).map(d => {
                    const s = sget(t, 'medium', 0.05, d);
                    const m = s?.recall_mean ?? null;
                    const h = m === null || s?.recall_ci_high == null ? null : s.recall_ci_high - m;
                    return <td key={d} className="pr-3 font-mono">{m === null ? '–' : `${m.toFixed(2)} ± ${fmt(h)}`}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500">“–” = ข้อมูลผิดถูกตัดที่ validation ทั้งหมด จึงไม่มีแถวไปถึงชั้น 3–4</p>
      </Card>

      <Card title="📁 ผลระดับไฟล์ (กลุ่ม A: rate 5%, ทุกกลุ่ม: severity medium)">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-slate-400"><tr className="border-b border-slate-800">
              {['type', 'คาดชั้น', 'trial', 'falseAlarm', 'rescued', 'detected', 'preserved', 'routingCorrect', 'blocked'].map(h => <th key={h} className="text-left font-medium py-1.5 pr-3">{h}</th>)}
            </tr></thead>
            <tbody>
              {fileRows.map(b => (
                <tr key={`${b.type}-${b.rate}`} className="border-b border-slate-800/60 text-slate-300">
                  <td className="py-1 pr-3">{b.type}</td><td className="pr-3">{b.expected_layer}</td><td className="pr-3">{b.trials}</td>
                  {(['falseAlarm_rate', 'rescued_rate', 'detected_rate', 'preserved_rate', 'routingCorrect_rate', 'blocked_rate'] as const).map(k => (
                    <td key={k} className="pr-3 font-mono">{pct(b[k])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500">
          falseAlarm = เตือน drift ทั้งที่เป็นข้อมูลผิด/ไม่มีอะไรเปลี่ยน · rescued = เตือนผิดแต่หายเมื่อตัดแถวที่โดนธง ·
          detected = จับ drift จริงได้ · preserved = ยังจับ drift ได้หลังตัดแถวที่โดนธง · “–” = ไม่เกี่ยวกับกลุ่มนี้
        </p>
      </Card>
    </div>
  );
}
