'use client';
import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import AnomalyExperimentPanel from './components/AnomalyExperimentPanel';
import BaselineRegistryPanel from './components/BaselineRegistryPanel';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Legend } from 'recharts';
import { formatAppDateTime } from '../../lib/time';
import {
  DEFAULT_AUC_MIN,
  DEFAULT_GINI_MIN,
  DEFAULT_KS_MIN,
  DEFAULT_PSI_WARNING,
  DEFAULT_PSI_CRITICAL,
} from '../../lib/defaults';

// ─── Types ──────────────────────────────────────────────────────────────────
interface ModelConfig {
  activeModelId: string;
  models: Record<string, ModelEntry>;
}

interface ModelEntry {
  id: string;
  name: string;
  description: string;
  type: string;
  createdAt: string;
  status: string;
  referenceDatasetId?: string;
  columns?: { idColumn?: string; dateColumn?: string | null; labelColumn?: string | null; scoreColumn?: string | null; };
  featureRegistry?: Record<string, any>;
  scoring: {
    base_points: number;
    features: string[];
    scorecard: Record<string, { bins: number[]; bin_labels: string[]; count?: number[]; woe: number[]; points: number[]; bad_rate: number[] }>;
  };
  baseline: {
    lockedAt: string;
    sample_size: number;
    bad_rate: number;
    performance: { train?: { auc: number; gini: number; ks: number; period?: string }; test?: { auc: number; gini: number; ks: number; period?: string } };
    feature_stats: Record<string, { mean: number; std: number; min: number; p25: number; p50: number; p75: number; max: number }>;
    score_distribution?: { mean: number; min: number; max: number; decile_bounds: number[] };
    ksDecileTable?: { decile: string; n: number; bad: number; good: number; minScore: number; maxScore: number; badRate: number; cumBad: number; cumGood: number; ks: number }[];
  };
  thresholds: {
    psi_warning: number;
    psi_critical: number;
    gini_min: number;
    auc_min: number;
    ks_min: number;
    csi_features: Record<string, { threshold: number; bins: number[]; bin_labels: string[] }>;
  };
}

interface UploadSummary {
  totalRows: number;
  periods: { period: string; count: number; pct: number }[];
  missingData: { column: string; label: string; missingCount: number; missingPct: number }[];
}

interface MonitorLog {
  logId: string;
  modelId: string;
  modelName: string;
  configVersion?: string;
  referenceId?: string;
  uploadedAt: string;
  fileName: string;
  rowCount: number;
  processedRows?: number;
  skippedRows?: number;
  validationOk?: boolean;
  results: { psi: number; csi: Record<string, number>; status: string } | null;
  uploadSummary?: UploadSummary;
  verdict: string;
  triggerAction?: string | null;
  flaggedRows?: number | null;
  hasDetail?: boolean;
  triggered?: string[];
  psiStatus?: string | null;
  verdictReason?: string | null;
  triggerReasons?: string[];
  thresholdMode?: 'fixed' | 'calibrated';
}

interface ValidationIssueGroup { type: string; severity: 'error' | 'warning'; column?: string; count: number; sampleRows: number[]; message: string }
interface ValidationIssue { type: string; severity: 'error' | 'warning'; column?: string; row?: number; value?: string; message: string }
interface ValidationResult {
  ok: boolean; totalRows: number; validRows: number; rejectedRows: number; rejectedPct: number;
  warningRows?: number; warningRowPct?: number;
  blockingErrors: ValidationIssue[]; warnings: ValidationIssue[]; groups: ValidationIssueGroup[]; issues: ValidationIssue[];
}
interface ReferenceMeta { referenceId: string; version: string; rowCount: number; badRate: number; periodStart: string; periodEnd: string; sha256: string; source: string }
interface StorageInfo { kind: 'upstash' | 'file' | 'memory'; persistent: boolean; error?: string }

const ISSUE_LABEL: Record<string, string> = {
  EMPTY_FILE: 'ไฟล์/ข้อมูลไม่พอ', MISSING_COLUMN: 'ไม่พบคอลัมน์', DUPLICATE_COLUMN: 'คอลัมน์ซ้ำ', MISSING_VALUE: 'ค่าว่าง',
  INVALID_TYPE: 'ชนิดข้อมูลผิด', OUT_OF_RANGE: 'ค่านอกช่วง', INVALID_DATE: 'วันที่ผิดรูปแบบ', INVALID_BINARY: 'ต้องเป็น 0/1',
  DUPLICATE_ID: 'รหัสลูกค้าซ้ำ', MALFORMED_ROW: 'แถวผิดรูปแบบ',
  UNSEEN_CATEGORY: 'หมวดหมู่ใหม่ที่ไม่เคยพบใน Reference',
};

type ActiveTab = 'registry' | 'sandbox' | 'monitor';
type CsiFeatureItem = { key: string; label: string; source: string; threshold: string; bins: string[] };

// CSV is parsed and validated on the server (lib/csv.ts + lib/validation.ts).

// ─── Helper Components ───────────────────────────────────────────────────────
function Badge({ status }: { status: string }) {
  const map: Record<string, string> = {
    STABLE: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    WARNING: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    CRITICAL: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    PASS: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    FAIL: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    INVALID_DATA: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  };
  const icons: Record<string, string> = { STABLE: '✅', WARNING: '⚠️', CRITICAL: '🚨', PASS: '✅', FAIL: '❌', INVALID_DATA: '🧾' };
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded border font-bold ${map[status] || 'bg-slate-700/30 text-slate-400 border-slate-600'}`}>
      {icons[status] || ''} {status}
    </span>
  );
}

function MetricCard({ label, value, suffix = '', color = 'text-slate-200', small = false }: { label: string; value: string | number | null; suffix?: string; color?: string; small?: boolean }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-3">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`font-bold font-mono ${small ? 'text-sm' : 'text-lg'} ${color}`}>
        {value !== null && value !== undefined ? `${typeof value === 'number' ? value.toFixed(4) : value}${suffix}` : '—'}
      </p>
    </div>
  );
}

// ─── Trend Chart Helpers ───────────────────────────────────────────────────
function getLogPeriodInfo(l: MonitorLog): {
  periodLabel: string;
  isFallback: boolean;
  sortKey: string;
  isOot: boolean;
} {
  const fileName = l.fileName || '';
  const isOot =
    /(?:^|[_ -])(oot|test|dev|val|eval|special|sandbox)(?:$|[_ -])/i.test(fileName) ||
    /oot/i.test(fileName);

  // 1. Check uploadSummary.periods
  const rawPeriods = l.uploadSummary?.periods || [];
  const validPeriods = rawPeriods
    .map(p => p.period)
    .filter(p => p && p !== 'ไม่ระบุวันที่' && p !== 'UNKNOWN' && p !== 'UNKNOWN_PERIOD');

  if (validPeriods.length === 1) {
    return {
      periodLabel: validPeriods[0],
      isFallback: false,
      sortKey: validPeriods[0],
      isOot,
    };
  }

  if (validPeriods.length > 1) {
    const sorted = [...validPeriods].sort();
    return {
      periodLabel: `${sorted[0]} – ${sorted[sorted.length - 1]}`,
      isFallback: false,
      sortKey: sorted[0],
      isOot,
    };
  }

  // 2. Check filename for YYYY-MM
  const match = fileName.match(/(20\d{2}[-_]\d{2})/);
  if (match) {
    const p = match[1].replace('_', '-');
    return {
      periodLabel: p,
      isFallback: false,
      sortKey: p,
      isOot,
    };
  }

  // 3. Fallback to upload time with clear label
  const uploadDate = new Date(l.uploadedAt);
  const dateStr = !isNaN(uploadDate.getTime())
    ? uploadDate.toLocaleDateString('th-TH', { day: '2-digit', month: 'short' })
    : 'ไม่ระบุ';
  return {
    periodLabel: `${dateStr} (อัปโหลด)`,
    isFallback: true,
    sortKey: l.uploadedAt || '9999',
    isOot,
  };
}

function deriveVerdictReason(
  l: MonitorLog,
  warnPsi: number,
  critPsi: number,
  csiFeatures: CsiFeatureItem[],
  thresholdMode: string
): string {
  if (!l.results) {
    return l.validationOk === false
      ? `ข้อมูลไม่ผ่านการตรวจสอบ (ตัดแถวออก ${(l.skippedRows ?? 0).toLocaleString()} แถว)`
      : 'ไม่มีผลการคำนวณ Drift';
  }

  const psiVal = l.results.psi;
  const modeTag = thresholdMode === 'calibrated' ? ' [เกณฑ์ Calibrated]' : '';

  // Check CSI features for warnings/criticals
  const csiCriticals: string[] = [];
  const csiWarnings: string[] = [];
  const csiStatus = (l.results as any)?.csiStatus as Record<string, string> | undefined;
  const csiDetail = (l.results as any)?.csiDetail as Record<string, any> | undefined;

  for (const f of csiFeatures) {
    const val = l.results.csi?.[f.key];
    const st = csiStatus?.[f.key];
    const det = csiDetail?.[f.key];
    const thr = parseFloat(f.threshold) || DEFAULT_PSI_WARNING;
    const isCrit = st === 'CRITICAL' || (val !== undefined && val >= Math.max(critPsi, thr));
    const isWarn = st === 'WARNING' || (val !== undefined && val >= thr && !isCrit);

    if (val !== undefined) {
      const pValStr = det?.pValue !== undefined && det?.pValue !== null ? `, p=${Number(det.pValue).toFixed(4)}` : '';
      let unseenStr = '';
      if (det?.unseenRowCount && det.unseenRowCount > 0) {
        unseenStr = `, พบ ${det.unseenRowCount} แถว (${det.unseenDistinctCategories || 1} หมวดใหม่)`;
      } else if (det?.unseenCount && det.unseenCount > 0) {
        unseenStr = `, พบ ${det.unseenCount} แถว`;
      }
      const text = `${f.label || f.key} (CSI: ${val.toFixed(4)}${pValStr}${unseenStr})`;
      if (isCrit) {
        csiCriticals.push(text);
      } else if (isWarn) {
        csiWarnings.push(text);
      }
    }
  }

  // Check skipped optional features
  const totalMonitoredCount = csiFeatures.length;
  const evaluatedCount = Object.keys(l.results.csi || {}).length;
  let skippedFeaturesNote = '';
  if (totalMonitoredCount > 0 && evaluatedCount < totalMonitoredCount) {
    const skippedKeys = csiFeatures
      .filter(f => l.results?.csi?.[f.key] === undefined)
      .map(f => f.label || f.key);
    if (skippedKeys.length > 0) {
      skippedFeaturesNote = `ตรวจ CSI ${evaluatedCount} จาก ${totalMonitoredCount} ตัวแปร (ข้าม: ${skippedKeys.join(', ')})`;
    }
  }

  // Check missing data signals if any
  const missingParts: string[] = [];
  if (l.uploadSummary?.missingData && l.uploadSummary.missingData.length > 0) {
    for (const m of l.uploadSummary.missingData) {
      if (m.missingCount > 0) {
        missingParts.push(`${m.label || m.column} ว่าง ${m.missingPct}% (${m.missingCount.toLocaleString()} แถว)`);
      }
    }
  }
  const missingNote = missingParts.length > 0 ? `พบค่าว่าง: ${missingParts.join(', ')}` : '';
  const skippedNote = l.skippedRows && l.skippedRows > 0 ? `(ตัดแถวออก ${l.skippedRows.toLocaleString()} แถว)` : '';

  // Check label drift signals (e.g. m06)
  const labelDrift = (l as any)?.labelDrift;
  let labelDriftNote = '';
  if (labelDrift && labelDrift.status !== 'STABLE' && labelDrift.status !== 'NOT_AVAILABLE') {
    const pThr = labelDrift.pThreshold;
    const pThrStr = pThr !== undefined && pThr !== null ? ` เทียบเกณฑ์ p < ${pThr}` : '';
    const pStr = labelDrift.pValue !== undefined && labelDrift.pValue !== null ? ` (p=${Number(labelDrift.pValue).toFixed(4)}${pThrStr})` : '';
    labelDriftNote = `สัญญาณ Label Drift: ${labelDrift.reason || 'อัตราหนี้เสียเปลี่ยนแปลงอย่างมีนัยสำคัญ'}${pStr}`;
  } else {
    const lReason = l.triggerReasons?.find(r => r.includes('Label Drift') || r.includes('Bad Rate') || r.includes('อัตราผิดนัดชำระหนี้'));
    if (lReason) {
      labelDriftNote = `สัญญาณ Label Drift: ${lReason.replace(/^\[[^\]]+\]\s*/, '')}`;
    }
  }

  if (l.verdict === 'CRITICAL') {
    const reasons: string[] = [];
    if (psiVal >= critPsi) {
      reasons.push(`PSI รวม (${psiVal.toFixed(4)}) เกินเกณฑ์วิกฤต (≥ ${critPsi.toFixed(2)})`);
      if (csiCriticals.length > 0) {
        reasons.push(`CSI ของ ${csiCriticals.join(', ')} เกินเกณฑ์วิกฤต`);
      }
    } else {
      reasons.push(
        `PSI รวม (${psiVal.toFixed(4)}) ยังต่ำกว่าเกณฑ์วิกฤต (< ${critPsi.toFixed(2)}) แต่สถานะภาพรวมเป็น CRITICAL เนื่องจากพบตัวแปรที่มีการเปลี่ยนแปลงรุนแรง: ${csiCriticals.length > 0 ? csiCriticals.join(', ') : 'ตัวแปรรายตัวเกินเกณฑ์'}`
      );
    }
    if (labelDriftNote) reasons.push(labelDriftNote);
    if (reasons.length === 0 && l.verdictReason) {
      reasons.push(l.verdictReason);
    }
    if (reasons.length === 0) {
      reasons.push(`ผลลัพธ์ของโมเดลอยู่ในระดับวิกฤต (PSI: ${psiVal.toFixed(4)})`);
    }
    if (skippedFeaturesNote) reasons.push(skippedFeaturesNote);
    if (missingNote) reasons.push(missingNote);
    if (skippedNote) reasons.push(skippedNote);
    return `${reasons.join(' · ')}${modeTag}`;
  }

  if (l.verdict === 'WARNING') {
    const reasons: string[] = [];
    if (psiVal >= warnPsi) {
      reasons.push(`PSI รวม (${psiVal.toFixed(4)}) เกินเกณฑ์เฝ้าระวัง (≥ ${warnPsi.toFixed(2)})`);
    }
    if (csiWarnings.length > 0) {
      reasons.push(`CSI ของ ${csiWarnings.join(', ')} เกินเกณฑ์เฝ้าระวัง`);
    }
    if (labelDriftNote) {
      reasons.push(labelDriftNote);
    }
    if (reasons.length === 0 && l.verdictReason) {
      reasons.push(l.verdictReason);
    }
    if (reasons.length === 0) {
      reasons.push(`ผลลัพธ์ของโมเดลอยู่ในระดับเฝ้าระวัง (PSI: ${psiVal.toFixed(4)})`);
    }
    if (skippedFeaturesNote) reasons.push(skippedFeaturesNote);
    if (missingNote) reasons.push(missingNote);
    if (skippedNote) reasons.push(skippedNote);
    return `${reasons.join(' · ')}${modeTag}`;
  }

  if (l.verdict === 'STABLE') {
    const notes: string[] = [`PSI (${psiVal.toFixed(4)}) และ CSI ทุกตัวแปรอยู่ในเกณฑ์ปกติ (ต่ำกว่า ${warnPsi.toFixed(2)})`];
    if (skippedFeaturesNote) notes.push(skippedFeaturesNote);
    if (missingNote) notes.push(missingNote);
    if (skippedNote) notes.push(skippedNote);
    return `${notes.join(' · ')}${modeTag}`;
  }

  return `สถานะ ${l.verdict}${modeTag}`;
}

function deriveTriggerExplanation(l: MonitorLog): { action: string; ruleId?: string; details: string[] } {
  const action = l.triggerAction || (l.verdict === 'INVALID_DATA' ? 'INVESTIGATE_DATA' : 'CONTINUE');
  const details: string[] = [];

  let ruleId: string | undefined = (l as any).triggerRule || undefined;
  if (!ruleId && l.triggerReasons && l.triggerReasons.length > 0) {
    const match = l.triggerReasons[0].match(/^\[([^\]]+)\]/);
    if (match) ruleId = match[1];
  }

  if (l.triggerReasons && l.triggerReasons.length > 0) {
    for (const r of l.triggerReasons) {
      const clean = r.replace(/^\[[^\]]+\]\s*/, '');
      details.push(clean);
    }
  } else if (l.verdict === 'INVALID_DATA') {
    details.push('ข้อมูลไม่ผ่านเกณฑ์การตรวจสอบโครงสร้าง');
  } else {
    details.push('ไม่มีกฎ Trigger ใดถูกกระตุ้น — ดำเนินการตามปกติ');
  }

  return { action, ruleId, details };
}

const TrendTooltip = ({ active, payload }: any) => {
  if (!active || !payload || !payload.length) return null;
  const data = payload[0]?.payload;
  if (!data) return null;

  return (
    <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-3 shadow-2xl max-w-sm text-xs space-y-2 pointer-events-none z-50">
      {/* Header */}
      <div className="border-b border-slate-800 pb-1.5 flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-200 truncate max-w-[180px]" title={data.fileName}>
          📁 {data.fileName}
        </span>
        <div className="flex items-center gap-1.5 font-mono text-[10px]">
          <span className="text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-800/40">
            {data.period}
          </span>
          {data.totalRoundsInPeriod > 1 && (
            <span className="text-indigo-300 bg-indigo-950/60 px-1.5 py-0.5 rounded border border-indigo-800/40 font-sans">
              รอบที่ {data.uploadRound}/{data.totalRoundsInPeriod} {data.isLatestInPeriod ? '(ล่าสุด)' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-3 gap-2 bg-slate-950/40 p-2 rounded-lg border border-slate-800/60 text-[11px]">
        <div>
          <span className="text-slate-500 block text-[10px]">ประเภท</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium inline-block mt-0.5 ${data.isOot ? 'bg-purple-950/60 text-purple-300 border border-purple-800/40' : 'bg-slate-800 text-slate-300'}`}>
            {data.isOot ? 'OOT / อื่นๆ' : 'รายเดือน (Monthly)'}
          </span>
        </div>
        <div>
          <span className="text-slate-500 block text-[10px]">ค่า PSI</span>
          <span className="font-mono font-bold text-slate-100 block mt-0.5">{data.psi !== null ? Number(data.psi).toFixed(4) : '—'}</span>
        </div>
        <div>
          <span className="text-slate-500 block text-[10px]">สถานะ Drift</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold inline-block mt-0.5 ${
            data.verdict === 'CRITICAL' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' :
            data.verdict === 'WARNING' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
            data.verdict === 'STABLE' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
            'bg-slate-800 text-slate-400'
          }`}>
            {data.verdict}
          </span>
        </div>
      </div>

      {/* Section 1: Verdict (จากการวัด drift) */}
      <div className="pt-1.5 border-t border-slate-800 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
            📊 Verdict (จากการวัด drift)
          </span>
          <span className="text-[10px] font-mono text-slate-500">{data.verdict}</span>
        </div>
        <p className="text-[11px] text-slate-300 leading-relaxed bg-slate-950/70 p-2 rounded-lg border border-slate-800/80">
          <strong className="text-amber-400 font-semibold">เพราะ: </strong>
          {data.verdictReason}
        </p>
      </div>

      {/* Section 2: Trigger Decision */}
      <div className="pt-1.5 border-t border-slate-800 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">
            ⚡ Trigger Decision
          </span>
          <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono">
            {data.triggerDecision?.ruleId ? `${data.triggerDecision.ruleId} → ` : ''}{data.triggerDecision?.action || 'CONTINUE'}
          </span>
        </div>
        <div className="text-[11px] text-slate-300 leading-relaxed bg-slate-950/70 p-2 rounded-lg border border-slate-800/80 space-y-1">
          {data.triggerDecision?.details?.map((msg: string, i: number) => (
            <p key={i} className="flex items-start gap-1">
              <span className="text-indigo-400 select-none">•</span>
              <span>{msg}</span>
            </p>
          ))}
        </div>
      </div>

      {/* CSI items if any */}
      {data.csiItems && data.csiItems.length > 0 && (
        <div className="pt-1 border-t border-slate-800 space-y-0.5 text-[10px]">
          <p className="font-semibold text-slate-400 mb-1">CSI รายตัวแปร:</p>
          <div className="grid grid-cols-1 gap-1 max-h-24 overflow-y-auto pr-1">
            {data.csiItems.map((c: any) => (
              <div key={c.key} className="flex justify-between items-center text-slate-400 font-mono text-[10px]">
                <span className="truncate max-w-[170px]" title={c.label}>
                  {c.label}:
                  {c.unseenCount && c.unseenCount > 0 ? (
                    <span className="ml-1 text-[9px] text-amber-300 font-sans">
                      (พบหมวดหมู่ใหม่ {c.unseenCount})
                    </span>
                  ) : null}
                </span>
                <span className={c.value !== null && c.value >= DEFAULT_PSI_CRITICAL ? 'text-rose-400 font-bold' : c.value !== null && c.value >= DEFAULT_PSI_WARNING ? 'text-amber-400 font-bold' : 'text-slate-300'}>
                  {c.value !== null ? c.value.toFixed(4) : '—'}
                  {c.pValue !== undefined && c.pValue !== null ? ` (p=${Number(c.pValue).toFixed(3)})` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export interface ColumnTierGroups {
  requiredCols: string[];
  optionalFeatureCols: string[];
  alternativeCols: string[];
}

function getModelExpectedColumns(
  effectiveModel: any,
  fallbackFeatures: CsiFeatureItem[] = []
): ColumnTierGroups {
  const reqSet = new Set<string>();
  const optFeatureSet = new Set<string>();
  const altSet = new Set<string>();

  // 1. Feature columns
  const scorecardKeys = new Set<string>(
    effectiveModel?.scoring?.scorecard ? Object.keys(effectiveModel.scoring.scorecard).filter(Boolean) : []
  );
  scorecardKeys.forEach(k => reqSet.add(k));

  if (effectiveModel?.featureRegistry) {
    for (const [k, def] of Object.entries(effectiveModel.featureRegistry as Record<string, any>)) {
      if (!k) continue;
      const col = def?.columnName || k;
      if (scorecardKeys.has(k) || def?.required === true) {
        reqSet.add(col);
      } else {
        optFeatureSet.add(col);
      }
    }
  }

  // Fallbacks if no features found yet
  if (reqSet.size === 0 && optFeatureSet.size === 0) {
    if (fallbackFeatures.length > 0) {
      for (const f of fallbackFeatures) if (f.key) reqSet.add(f.key);
    } else if (Array.isArray(effectiveModel?.features)) {
      for (const f of effectiveModel.features) if (f) reqSet.add(f);
    }
  }

  // 2. Score column
  const scoreCol = effectiveModel?.columns?.scoreColumn;
  if (scoreCol) {
    if (reqSet.size === 0 && optFeatureSet.size === 0) {
      reqSet.add(scoreCol);
    } else {
      altSet.add(`${scoreCol} (คะแนนเดิม ถ้ามี)`);
    }
  }

  // 3. Optional metadata columns
  const cols = effectiveModel?.columns;
  if (cols?.idColumn) altSet.add(`${cols.idColumn} (รหัสอ้างอิง)`);
  if (cols?.dateColumn) altSet.add(`${cols.dateColumn} (วันที่/Period)`);
  if (cols?.labelColumn) altSet.add(`${cols.labelColumn} (ผลจริง/Default Flag สำหรับวัด Performance)`);
  if (cols?.segmentColumn) altSet.add(`${cols.segmentColumn} (กลุ่มลูกค้า)`);

  return {
    requiredCols: Array.from(reqSet),
    optionalFeatureCols: Array.from(optFeatureSet),
    alternativeCols: Array.from(altSet),
  };
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('sandbox');
  const [sandboxSubTab, setSandboxSubTab] = useState<'reference' | 'experiment'>('reference');
  const [showOot, setShowOot] = useState(true);
  const [latestOnlyPerPeriod, setLatestOnlyPerPeriod] = useState(false);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [monitorLogs, setMonitorLogs] = useState<MonitorLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [registeredModels, setRegisteredModels] = useState<any[]>([]);

  // Sandbox state
  const [thresholds, setThresholds] = useState({
    psi_warning: String(DEFAULT_PSI_WARNING),
    psi_critical: String(DEFAULT_PSI_CRITICAL),
    gini_min: String(DEFAULT_GINI_MIN),
    auc_min: String(DEFAULT_AUC_MIN),
    ks_min: String(DEFAULT_KS_MIN),
  });
  const defaultCsiFeatures: CsiFeatureItem[] = [];
  const [csiFeatures, setCsiFeatures] = useState<CsiFeatureItem[]>(defaultCsiFeatures);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Monitor state
  const [fileName, setFileName] = useState('');
  const [rowCount, setRowCount] = useState(0);
  const [uploadedMetrics, setUploadedMetrics] = useState<any>(null);
  const [uploadedCsiDetail, setUploadedCsiDetail] = useState<Record<string, any> | null>(null);
  const [uploadedRiskGrades, setUploadedRiskGrades] = useState<any[]>([]);
  const [previewCustomers, setPreviewCustomers] = useState<any[]>([]);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadErrorCode, setUploadErrorCode] = useState('');
  const [selectedLog, setSelectedLog] = useState<MonitorLog | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [reference, setReference] = useState<ReferenceMeta | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [onlyCurrentVersion, setOnlyCurrentVersion] = useState(true);
  const [duplicateUploadWarning, setDuplicateUploadWarning] = useState<string | null>(null);
  const [viewingHistoricalRun, setViewingHistoricalRun] = useState<{
    runId: string;
    fileName: string;
    uploadedAt: string;
    hasDetail: boolean;
  } | null>(null);
  const [latestUploadSession, setLatestUploadSession] = useState<{
    uploadedMetrics: any;
    uploadedCsiDetail: any;
    uploadedRiskGrades: any[];
    previewCustomers: any[];
    validation: ValidationResult | null;
    uploadSummary: UploadSummary | null;
    fileName: string;
    rowCount: number;
  } | null>(null);
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<{
    type: 'single' | 'multiple';
    ids: string[];
    displayInfo: string;
  } | null>(null);
  const [isDeletingLog, setIsDeletingLog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadLogs = useCallback(async (targetModelId?: string) => {
    try {
      const mId = targetModelId || selectedModelId;
      const url = mId ? `/api/monitor-log?modelId=${encodeURIComponent(mId)}` : '/api/monitor-log';
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      setMonitorLogs(Array.isArray(data.log) ? data.log : []);
      if (data.storage) setStorage(data.storage);
    } catch (err) {
      console.error('loadLogs error:', err);
    }
  }, [selectedModelId]);

  // ── Load data: effective config + reference + persisted monitoring runs ──
  const loadData = useCallback(async (targetModelId?: string) => {
    try {
      setIsLoading(true);
      const mId = targetModelId || selectedModelId;
      const url = mId ? `/api/get-latest-psi?modelId=${encodeURIComponent(mId)}` : '/api/get-latest-psi';
      const [psiRes, modelsRes] = await Promise.all([
        fetch(url, { cache: 'no-store' }),
        fetch('/api/registry/models', { cache: 'no-store' }),
      ]);
      const psiData = await psiRes.json();
      const modelsData = await modelsRes.json();
      if (modelsRes.ok && Array.isArray(modelsData.models)) {
        setRegisteredModels(modelsData.models);
      }
      if (psiData.reference) setReference(psiData.reference);
      if (psiData.storage) setStorage(psiData.storage);
      await loadLogs(mId);

      if (psiData.config) {
        setConfig(psiData.config);
        const resolvedId = mId || psiData.config.activeModelId;
        if (!selectedModelId && !targetModelId) {
          setSelectedModelId(resolvedId);
        }
        const currentModel = psiData.config.models[resolvedId];
        if (currentModel?.thresholds) {
          const t = currentModel.thresholds;
          setThresholds({
            psi_warning:  String(t.psi_warning  ?? DEFAULT_PSI_WARNING),
            psi_critical: String(t.psi_critical ?? DEFAULT_PSI_CRITICAL),
            gini_min:     String(t.gini_min     ?? DEFAULT_GINI_MIN),
            auc_min:      String(t.auc_min      ?? DEFAULT_AUC_MIN),
            ks_min:       String(t.ks_min       ?? DEFAULT_KS_MIN),
          });
          const loaded: CsiFeatureItem[] = [];
          if (t.csi_features) {
            for (const [feat, cfg] of Object.entries(t.csi_features as Record<string, any>)) {
              loaded.push({
                key: feat, label: cfg.label || feat, source: cfg.source || '',
                threshold: String(cfg.threshold ?? 0.10),
                bins: Array.isArray(cfg.bins) ? cfg.bins.map(String) : [],
              });
            }
          } else if (currentModel.featureRegistry) {
            for (const [feat, def] of Object.entries(currentModel.featureRegistry as Record<string, any>)) {
              loaded.push({
                key: feat,
                label: def.displayName || feat,
                source: def.dataType || '',
                threshold: '0.10',
                bins: [],
              });
            }
          }
          setCsiFeatures(loaded);
        }
      }
    } catch (err) {
      console.error('loadData error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [loadLogs, selectedModelId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Save config ──
  const saveConfig = async () => {
    const targetModelId = selectedModelId || config?.activeModelId;
    if (!targetModelId) return;
    setIsSavingConfig(true);
    try {
      // Build csi_features payload from dynamic list (keyed by feature column name)
      const csiPayload: Record<string, any> = {};
      for (const feat of csiFeatures) {
        if (!feat.key.trim()) continue; // skip blank keys
        csiPayload[feat.key.trim()] = {
          label: feat.label,
          source: feat.source,
          threshold: parseFloat(feat.threshold) || 0.10,
          bins: feat.bins.map(Number).filter(isFinite),
          bin_labels: [], // auto-generated from bins in backend if needed
        };
      }
      const res = await fetch('/api/save-model-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: targetModelId,
          thresholds: {
            psi_warning: thresholds.psi_warning,
            psi_critical: thresholds.psi_critical,
            gini_min: thresholds.gini_min,
            auc_min: thresholds.auc_min,
            ks_min: thresholds.ks_min,
            csi_features: csiPayload,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('❌ บันทึกไม่สำเร็จ:\n• ' + (data.errors?.join('\n• ') || data.error || res.status));
        return;
      }
      if (data.model) setConfig(prev => prev ? { ...prev, models: { ...prev.models, [targetModelId]: data.model } } : prev);
      if (data.storage) setStorage(data.storage);
      alert(`✅ บันทึกแล้ว — Config Version ${data.configVersion}${data.warning ? `\n⚠️ ${data.warning}` : ''}`);
    } catch (err: any) {
      alert('❌ บันทึกไม่สำเร็จ: ' + err.message);
    } finally {
      setIsSavingConfig(false);
    }
  };

  // ── CSI feature helpers ──
  const updateCsiFeature = (idx: number, field: keyof CsiFeatureItem, value: string) => {
    setCsiFeatures(prev => prev.map((f, i) => i === idx ? { ...f, [field]: value } : f));
  };
  const updateCsiBin = (idx: number, binIdx: number, value: string) => {
    setCsiFeatures(prev => prev.map((f, i) => {
      if (i !== idx) return f;
      const newBins = [...f.bins]; newBins[binIdx] = value;
      return { ...f, bins: newBins };
    }));
  };
  const addCsiBin = (idx: number) => {
    setCsiFeatures(prev => prev.map((f, i) => i === idx ? { ...f, bins: [...f.bins, ''] } : f));
  };
  const removeCsiBin = (idx: number, binIdx: number) => {
    setCsiFeatures(prev => prev.map((f, i) => {
      if (i !== idx) return f;
      return { ...f, bins: f.bins.filter((_, bi) => bi !== binIdx) };
    }));
  };
  const addCsiFeature = () => {
    setCsiFeatures(prev => [...prev, { key: '', label: '', source: '', threshold: '0.10', bins: [] }]);
  };
  const removeCsiFeature = (idx: number) => {
    setCsiFeatures(prev => prev.filter((_, i) => i !== idx));
  };

  // ── File upload ──
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setUploadError('');
    setUploadErrorCode('');
    setUploadedMetrics(null);
    setUploadedCsiDetail(null);
    setUploadedRiskGrades([]);
    setPreviewCustomers([]);
    setUploadSummary(null);
    setValidation(null);
    setIsUploading(true);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        if (!text || !text.trim()) throw new Error('ไฟล์ CSV ว่างเปล่า');

        // Server parses + validates (single source of truth for the rules)
        const res = await fetch('/api/monitor-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csvText: text, fileName: file.name, modelId: selectedModelId }),
        });
        const data = await res.json();
        if (data.validation) {
          setValidation(data.validation);
          setRowCount(data.validation.totalRows);
        }
        if (data.storage) setStorage(data.storage);
        if (data.uploadSummary) setUploadSummary(data.uploadSummary);
        if (!res.ok) {
          await loadLogs();
          let errText = data.error || data.detail || 'เกิดข้อผิดพลาดในการประมวลผล';
          const isNoActive =
            data.code === 'NO_ACTIVE_VERSION' ||
            errText.includes('ยังไม่มีเวอร์ชันที่เปิดใช้งาน') ||
            (res.status === 404 && errText.includes('ACTIVE'));
          if (isNoActive) {
            setUploadErrorCode('NO_ACTIVE_VERSION');
            errText = `โมเดล "${selectedModelId || currentModelId}" ยังไม่มีเวอร์ชันที่เปิดใช้งาน (ACTIVE) — การติดตามผลต้องใช้โมเดลสถานะ ACTIVE เท่านั้น`;
          }
          setUploadError(errText);
          throw new Error(errText);
        }
        if (data.duplicateInfo) {
          const formattedTime = formatAppDateTime(data.duplicateInfo.uploadedAt, { showSeconds: true });
          setDuplicateUploadWarning(`ไฟล์นี้เคยอัปโหลดแล้ว (${data.duplicateInfo.fileName} เมื่อ ${formattedTime})`);
        } else if (data.duplicateWarning) {
          setDuplicateUploadWarning(data.duplicateWarning);
        } else {
          setDuplicateUploadWarning(null);
        }
        setUploadedMetrics(data);
        setUploadedCsiDetail(data.csiDetail || null);
        setUploadedRiskGrades(data.riskGradeDist || []);
        setPreviewCustomers(data.scoredCustomers || []);
        setLatestUploadSession({
          uploadedMetrics: data,
          uploadedCsiDetail: data.csiDetail || null,
          uploadedRiskGrades: data.riskGradeDist || [],
          previewCustomers: data.scoredCustomers || [],
          validation: data.validation || null,
          uploadSummary: data.uploadSummary || null,
          fileName: file.name,
          rowCount: data.validation?.totalRows || 0,
        });
        setViewingHistoricalRun(null);
        await loadLogs();
      } catch (err: any) {
        setUploadError(err.message || 'เกิดข้อผิดพลาด');
      } finally {
        setIsUploading(false);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSelectLog = async (log: MonitorLog) => {
    if (viewingHistoricalRun?.runId === log.logId) {
      setViewingHistoricalRun(null);
      if (latestUploadSession) {
        setUploadedMetrics(latestUploadSession.uploadedMetrics);
        setUploadedCsiDetail(latestUploadSession.uploadedCsiDetail);
        setUploadedRiskGrades(latestUploadSession.uploadedRiskGrades);
        setPreviewCustomers(latestUploadSession.previewCustomers);
        setValidation(latestUploadSession.validation);
        setUploadSummary(latestUploadSession.uploadSummary);
        setFileName(latestUploadSession.fileName);
        setRowCount(latestUploadSession.rowCount);
      } else {
        setUploadedMetrics(null);
        setUploadedCsiDetail(null);
        setUploadedRiskGrades([]);
        setPreviewCustomers([]);
        setValidation(null);
        setUploadSummary(null);
        setFileName('');
        setRowCount(0);
      }
      return;
    }

    try {
      const mId = selectedModelId || config?.activeModelId || '';
      const res = await fetch(`/api/monitor-log/detail?runId=${encodeURIComponent(log.logId)}&modelId=${encodeURIComponent(mId)}`);
      const data = await res.json();
      if (data.ok && data.hasDetail && data.detail) {
        setViewingHistoricalRun({
          runId: log.logId,
          fileName: log.fileName,
          uploadedAt: log.uploadedAt,
          hasDetail: true,
        });
        setUploadedMetrics(data.detail);
        setUploadedCsiDetail(data.detail.csiDetail || null);
        setUploadedRiskGrades(data.detail.riskGradeDist || []);
        setPreviewCustomers(data.detail.scoredCustomers || []);
        setValidation(data.detail.validation);
        setUploadSummary(data.detail.uploadSummary || null);
        setFileName(log.fileName);
        setRowCount(data.detail.validation?.totalRows || 0);
        setSelectedLog(log);
        window.scrollTo({ top: 300, behavior: 'smooth' });
      } else {
        setViewingHistoricalRun({
          runId: log.logId,
          fileName: log.fileName,
          uploadedAt: log.uploadedAt,
          hasDetail: false,
        });
        setSelectedLog(log);
        setUploadedMetrics(null);
        setUploadedCsiDetail(null);
        setUploadedRiskGrades([]);
        setPreviewCustomers([]);
        setValidation(null);
        setUploadSummary(log.uploadSummary || null);
        setFileName(log.fileName);
        setRowCount(log.rowCount || 0);
      }
    } catch (err) {
      console.error('Failed to load log detail:', err);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!confirmDelete || confirmDelete.ids.length === 0) return;
    setIsDeletingLog(true);
    try {
      const mId = selectedModelId || config?.activeModelId || '';
      const res = await fetch('/api/monitor-log', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: mId, runIds: confirmDelete.ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ลบไม่สำเร็จ');
      setSelectedLogIds(new Set());
      setConfirmDelete(null);
      if (viewingHistoricalRun && confirmDelete.ids.includes(viewingHistoricalRun.runId)) {
        setViewingHistoricalRun(null);
      }
      await loadLogs(mId);
    } catch (err: any) {
      alert(`เกิดข้อผิดพลาดในการลบ: ${err.message}`);
    } finally {
      setIsDeletingLog(false);
    }
  };

  const currentModelId = selectedModelId || config?.activeModelId || '';
  const currentRegModel = registeredModels.find((m: any) => m.modelId === currentModelId);
  const activeVer = currentRegModel?.versions?.find((v: any) => v.status === 'ACTIVE');
  const displayVer =
    activeVer ||
    (Array.isArray(currentRegModel?.versions) && currentRegModel.versions.length > 0
      ? [...currentRegModel.versions].sort((a: any, b: any) => {
          const tA = new Date(a.createdAt).getTime();
          const tB = new Date(b.createdAt).getTime();
          if (!Number.isNaN(tA) && !Number.isNaN(tB) && tA !== tB) return tB - tA;
          return String(b.version).localeCompare(String(a.version), undefined, { numeric: true });
        })[0]
      : undefined);

  let headerBadgeText = `${currentModelId} · ยังไม่เปิดใช้งาน`;
  let headerBadgeStyle = 'border-slate-700 text-slate-400 bg-slate-800/40';

  if (activeVer) {
    headerBadgeText = `${currentModelId}@${activeVer.version} · ${activeVer.referenceDatasetId} · ACTIVE`;
    headerBadgeStyle = 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10';
  } else if (displayVer) {
    const statusNote = displayVer.status === 'ARCHIVED'
      ? 'ARCHIVED (ถูกเก็บถาวร)'
      : `${displayVer.status} (ยังไม่เปิดใช้งาน)`;
    headerBadgeText = `${currentModelId}@${displayVer.version} · ${displayVer.referenceDatasetId} · ${statusNote}`;
    if (displayVer.status === 'VALIDATED') {
      headerBadgeStyle = 'border-blue-500/40 text-blue-300 bg-blue-500/10';
    } else if (displayVer.status === 'DRAFT') {
      headerBadgeStyle = 'border-amber-500/40 text-amber-300 bg-amber-500/10';
    } else if (displayVer.status === 'ARCHIVED') {
      headerBadgeStyle = 'border-slate-700 text-slate-400 bg-slate-800/40';
    } else {
      headerBadgeStyle = 'border-slate-700 text-slate-400 bg-slate-800/40';
    }
  }

  const model = config ? (config.models[currentModelId] || (currentRegModel ? null : config.models[config.activeModelId])) : null;
  const scorecard = model?.scoring?.scorecard || {};
  // featLabels: generated dynamically from csiFeatures (so scorecard table uses correct labels)
  const featLabels: Record<string, string> = Object.fromEntries(
    csiFeatures.map(f => [f.key, f.label || f.key])
  );


  const psiWarningNum = parseFloat(thresholds.psi_warning) || DEFAULT_PSI_WARNING;
  const psiCriticalNum = parseFloat(thresholds.psi_critical) || DEFAULT_PSI_CRITICAL;

  const ksDecileTable = model?.baseline?.ksDecileTable ?? [];
  const maxKS = ksDecileTable.length > 0 ? Math.max(...ksDecileTable.map(r => r.ks)) : 0;
  const currentVersion = (model as any)?.configVersion as string | undefined;
  const visibleLogs = onlyCurrentVersion && currentVersion
    ? monitorLogs.filter(l => (l.configVersion ?? currentVersion) === currentVersion)
    : monitorLogs;
  const driftLogs = visibleLogs.filter(l => l.results);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-6 py-3 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-sm font-bold">M</div>
            <div>
              <p className="text-sm font-bold text-slate-100">Credit Risk Monitor</p>
              <div className="flex items-center gap-2 mt-0.5">
                <select
                  value={selectedModelId || config?.activeModelId || ''}
                  onChange={e => {
                    const newId = e.target.value;
                    setSelectedModelId(newId);
                    loadData(newId);
                    loadLogs(newId);
                  }}
                  className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-200 outline-none focus:border-indigo-500"
                >
                  {(registeredModels.length > 0
                    ? registeredModels
                    : [{ modelId: config?.activeModelId || 'default', name: model?.name || 'Active Model' }]
                  ).map((m: any) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.modelId} — {m.name}
                    </option>
                  ))}
                </select>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${headerBadgeStyle}`}>
                  {headerBadgeText}
                </span>
                <button
                  onClick={async () => {
                    const target = selectedModelId || config?.activeModelId;
                    if (!target) return;
                    await fetch('/api/registry/default', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ modelId: target }),
                    });
                    alert(`✅ ตั้งโมเดล "${target}" เป็นค่าเริ่มต้นเรียบร้อย`);
                  }}
                  title="ตั้งโมเดลนี้เป็นค่าเริ่มต้นเมื่อเปิดระบบ"
                  className="px-2 py-0.5 text-[10px] bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded transition"
                >
                  ⭐ ตั้งเป็นค่าเริ่มต้น
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-slate-800/60 rounded-xl p-1">
            {([
              ['registry', '🗂 Baseline Registry'],
              ['sandbox', '🔬 Model Sandbox'],
              ['monitor', '📊 Monitoring'],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === tab
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            {storage && (
              <span
                title={storage.persistent ? `จัดเก็บผลถาวร (${storage.kind})` : 'ยังไม่ได้ตั้งค่าฐานข้อมูล — ผลจะหายเมื่อ server restart'}
                className={`px-2 py-0.5 rounded border text-[10px] font-mono ${storage.persistent ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10' : 'border-amber-500/40 text-amber-300 bg-amber-500/10'}`}>
                {storage.persistent ? '💾' : '⚠️'} {storage.kind}
              </span>
            )}
            {currentVersion && <span className="font-mono text-[10px] text-slate-500">cfg v{currentVersion}</span>}
            {activeVer ? (
              <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Model Active</span>
              </span>
            ) : displayVer?.status === 'VALIDATED' ? (
              <span className="flex items-center gap-1.5 text-blue-400 font-medium">
                <span className="w-2 h-2 rounded-full bg-blue-400" />
                <span>Model Validated (ยังไม่ Active)</span>
              </span>
            ) : displayVer?.status === 'DRAFT' ? (
              <span className="flex items-center gap-1.5 text-amber-400 font-medium">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <span>Model Draft (แบบร่าง)</span>
              </span>
            ) : displayVer?.status === 'ARCHIVED' ? (
              <span className="flex items-center gap-1.5 text-slate-400 font-medium">
                <span className="w-2 h-2 rounded-full bg-slate-500" />
                <span>Model Archived (เก็บถาวร)</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-slate-400 font-medium">
                <span className="w-2 h-2 rounded-full bg-slate-500" />
                <span>ยังไม่เปิดใช้งาน</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-6 py-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-slate-400 text-sm animate-pulse">Loading model data...</div>
          </div>
        ) : (
          /* ════════════════════════════════════════════════════════
             TAB: REGISTRY
          ════════════════════════════════════════════════════════ */
          activeTab === 'registry' ? (
            <BaselineRegistryPanel
              selectedModelId={selectedModelId || config?.activeModelId || ''}
              onSelectModel={mId => {
                setSelectedModelId(mId);
                loadData(mId);
                loadLogs(mId);
              }}
              onModelActivated={(mId, ver, openMon) => {
                setSelectedModelId(mId);
                loadData(mId);
                loadLogs(mId);
                if (openMon) setActiveTab('monitor');
              }}
              onRegistryChange={mId => {
                const target = mId || selectedModelId;
                loadData(target);
                loadLogs(target);
              }}
            />
          ) :

          /* ════════════════════════════════════════════════════════
             TAB: SANDBOX
          ════════════════════════════════════════════════════════ */
          activeTab === 'sandbox' ? (
            <div className="space-y-4">
            {/* Sandbox sub-tabs */}
            <div className="flex items-center gap-1 bg-slate-900/60 border border-slate-800 rounded-xl p-1 w-fit">
              {([['reference', '📋 Model Reference'], ['experiment', '🧪 Anomaly Experiment']] as const).map(([key, label]) => (
                <button
                  key={key}
                  id={`sandbox-subtab-${key}`}
                  onClick={() => setSandboxSubTab(key)}
                  className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${sandboxSubTab === key ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {sandboxSubTab === 'reference' ? (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              {/* Left: Model Info + Config */}
              <div className="xl:col-span-1 space-y-4">
                {/* Model Info Card */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider bg-indigo-500/10 px-2 py-0.5 rounded">📋 A. Model Info</span>
                  </div>
                  <div className="space-y-1.5">
                    {[
                      ['Model ID', model?.id || currentModelId],
                      ['Model Name', model?.name || currentRegModel?.name || currentModelId],
                      ['Type', (model as any)?.modelCard?.modelType || model?.type || (model as any)?.mode || ((model as any)?.modelTable ? 'Scorecard (Model Table)' : (model?.scoring ? 'Scorecard' : 'score_column'))],
                      ['Features', (model as any)?.modelTable?.features?.join(', ') || model?.scoring?.features?.join(', ') || (model?.featureRegistry ? Object.keys(model.featureRegistry).filter(k => (model.featureRegistry![k] as any)?.usedInModel !== false).join(', ') : '—')],
                      ['Base Points', String((model as any)?.modelTable?.base_points ?? model?.scoring?.base_points ?? '—')],
                      ['Dev Sample', (model as any)?.modelCard?.sampleSize ? `${(model as any).modelCard.sampleSize.toLocaleString()} obs` : (model as any)?.developmentStats?.reported?.train?.n ? `${(model as any).developmentStats.reported.train.n.toLocaleString()} obs` : model?.baseline?.sample_size ? `${model.baseline.sample_size.toLocaleString()} obs` : '—'],
                      ['Bad Rate', (model as any)?.developmentStats?.reported?.train?.badRate !== undefined ? `${((model as any).developmentStats.reported.train.badRate * 100).toFixed(1)}%` : model?.baseline?.bad_rate !== undefined ? `${((model.baseline.bad_rate ?? 0) * 100).toFixed(1)}%` : '—'],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between items-center text-xs">
                        <span className="text-slate-500">{k}:</span>
                        <span className="text-slate-200 font-mono text-right max-w-40 truncate">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Baseline Performance */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                  {(() => {
                    const devPerf = (model as any)?.developmentStats?.reported || (model as any)?.developmentStats?.computed;
                    const testPerf = devPerf?.test || model?.baseline?.performance?.test;
                    const trainPerf = devPerf?.train || model?.baseline?.performance?.train;
                    const overallPerf = (model?.baseline?.performance as any)?.overall;
                    const ootPerf = devPerf?.oot;

                    // If test and train are identical or if we only have overall/baseline performance
                    const isIdenticalTestTrain = Boolean(
                      testPerf && trainPerf &&
                      testPerf.auc === trainPerf.auc &&
                      testPerf.gini === trainPerf.gini &&
                      testPerf.ks === trainPerf.ks
                    );
                    const isWholeDataset = Boolean(overallPerf || (!trainPerf && testPerf) || isIdenticalTestTrain);

                    const hasDevData = Boolean(
                      overallPerf ||
                      (testPerf && (testPerf.auc !== undefined || testPerf.gini !== undefined || testPerf.ks !== undefined)) ||
                      (trainPerf && (trainPerf.auc !== undefined || trainPerf.gini !== undefined || trainPerf.ks !== undefined)) ||
                      (ootPerf && (ootPerf.auc !== undefined || ootPerf.gini !== undefined || ootPerf.ks !== undefined))
                    );

                    if (!hasDevData) {
                      return (
                        <>
                          <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded">📈 B. Baseline Performance</span>
                          <div className="bg-slate-950/40 border border-slate-800/60 rounded-xl p-4 text-center mt-2">
                            <p className="text-xs text-slate-500 italic">ไม่มีข้อมูลสถิติตอนพัฒนา (Train/Test/OOT)</p>
                          </div>
                        </>
                      );
                    }

                    return (
                      <>
                        {isWholeDataset ? (
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded">📈 B. Baseline Performance (Baseline ทั้งชุด)</span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-blue-500/40 text-blue-300 bg-blue-500/10">คำนวณโดยระบบจาก Baseline</span>
                          </div>
                        ) : (
                          <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded">📈 B. Baseline Performance (Train / Test / OOT)</span>
                        )}

                        <div className="space-y-3 mt-2">
                          {isWholeDataset ? (
                            <div>
                              {(overallPerf || testPerf)?.period && (
                                <p className="text-[9px] text-slate-500 uppercase mb-1 font-mono">ช่วงเวลา: {(overallPerf || testPerf).period}</p>
                              )}
                              <div className="grid grid-cols-3 gap-2">
                                {[
                                  { k: 'AUC', v: (overallPerf || testPerf)?.auc },
                                  { k: 'Gini', v: (overallPerf || testPerf)?.gini },
                                  { k: 'KS', v: (overallPerf || testPerf)?.ks },
                                ].map(({ k, v }) => (
                                  <div key={k} className="bg-slate-950/50 rounded-xl p-2 text-center">
                                    <p className="text-[9px] text-slate-500 uppercase mb-1">{k}</p>
                                    <p className="text-sm font-bold font-mono text-emerald-400">
                                      {typeof v === 'number' ? v.toFixed(3) : '—'}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <>
                              {testPerf && (testPerf.auc !== undefined || testPerf.gini !== undefined || testPerf.ks !== undefined) && (
                                <div>
                                  <p className="text-[9px] text-slate-500 uppercase mb-1">Test Performance</p>
                                  <div className="grid grid-cols-3 gap-2">
                                    {[
                                      { k: 'AUC', v: testPerf?.auc },
                                      { k: 'Gini', v: testPerf?.gini },
                                      { k: 'KS', v: testPerf?.ks },
                                    ].map(({ k, v }) => (
                                      <div key={k} className="bg-slate-950/50 rounded-xl p-2 text-center">
                                        <p className="text-[9px] text-slate-500 uppercase mb-1">{k}</p>
                                        <p className="text-sm font-bold font-mono text-emerald-400">
                                          {typeof v === 'number' ? v.toFixed(3) : '—'}
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {trainPerf && (trainPerf.auc !== undefined || trainPerf.gini !== undefined || trainPerf.ks !== undefined) && (
                                <div className="border-t border-slate-800 pt-2">
                                  <p className="text-[9px] text-slate-500 mb-1">Train Performance</p>
                                  <div className="flex gap-3 text-[10px] font-mono">
                                    <span className="text-slate-400">AUC: <span className="text-blue-400">{typeof trainPerf?.auc === 'number' ? trainPerf.auc.toFixed(3) : '—'}</span></span>
                                    <span className="text-slate-400">Gini: <span className="text-blue-400">{typeof trainPerf?.gini === 'number' ? trainPerf.gini.toFixed(3) : '—'}</span></span>
                                    <span className="text-slate-400">KS: <span className="text-blue-400">{typeof trainPerf?.ks === 'number' ? trainPerf.ks.toFixed(3) : '—'}</span></span>
                                  </div>
                                </div>
                              )}

                              {ootPerf && (ootPerf.auc !== undefined || ootPerf.gini !== undefined || ootPerf.ks !== undefined) && (
                                <div className="border-t border-slate-800 pt-2">
                                  <p className="text-[9px] text-slate-500 mb-1">OOT Performance</p>
                                  <div className="flex gap-3 text-[10px] font-mono">
                                    <span className="text-slate-400">AUC: <span className="text-purple-400">{typeof ootPerf?.auc === 'number' ? ootPerf.auc.toFixed(3) : '—'}</span></span>
                                    <span className="text-slate-400">Gini: <span className="text-purple-400">{typeof ootPerf?.gini === 'number' ? ootPerf.gini.toFixed(3) : '—'}</span></span>
                                    <span className="text-slate-400">KS: <span className="text-purple-400">{typeof ootPerf?.ks === 'number' ? ootPerf.ks.toFixed(3) : '—'}</span></span>
                                  </div>
                                </div>
                              )}
                            </>
                          )}

                          {/* Development Stability (ความผันผวนตอนพัฒนา: Train vs Test/OOT) */}
                        <div className="border-t border-slate-800 pt-3 mt-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold text-slate-300">
                              ⚖️ ความผันผวนตอนพัฒนา (Development Stability: Train vs Test/OOT)
                            </span>
                            {(() => {
                              const stab = (model as any)?.developmentStats?.stability;
                              if (stab && stab.available) {
                                return (
                                  <span className="text-[9px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                                    {stab.source || 'คำนวณโดยระบบจาก Baseline'}
                                  </span>
                                );
                              }
                              return (
                                <span className="text-[9px] font-mono text-slate-500 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800">
                                  ไม่มีข้อมูล
                                </span>
                              );
                            })()}
                          </div>
                          {(() => {
                            const stab = (model as any)?.developmentStats?.stability;
                            if (!stab || !stab.available) {
                              return (
                                <p className="text-[10px] text-slate-500 italic bg-slate-950/40 p-2 rounded-lg border border-slate-800/40">
                                  ไม่มีข้อมูล: {stab?.reason || 'ไม่มีคอลัมน์วันที่ หรือข้อมูลน้อยกว่า 500 แถว'}
                                </p>
                              );
                            }
                            return (
                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center justify-between text-[9px] text-slate-400 bg-slate-950/40 px-2 py-1.5 rounded-lg border border-slate-800/40 font-mono">
                                  <span>Train: {stab.trainCount?.toLocaleString()} ({Math.round((stab.trainRatio ?? 0.75) * 100)}%) · {stab.trainPeriod}</span>
                                  <span className="text-slate-600">vs</span>
                                  <span>Test/OOT: {stab.testCount?.toLocaleString()} ({Math.round((1 - (stab.trainRatio ?? 0.75)) * 100)}%) · {stab.testPeriod}</span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <div className="bg-slate-950/50 rounded-xl p-2 px-3 text-center border border-slate-800">
                                    <p className="text-[9px] text-slate-500 uppercase mb-0.5">Score PSI (Dev)</p>
                                    <p className="text-xs font-bold font-mono text-indigo-400">
                                      {typeof stab.scorePsi === 'number' ? stab.scorePsi.toFixed(4) : '—'}
                                    </p>
                                  </div>
                                  {stab.featureCsi && Object.keys(stab.featureCsi).length > 0 && (
                                    <div className="flex-1 overflow-x-auto">
                                      <p className="text-[8px] text-slate-500 uppercase mb-1">Feature CSI (Dev)</p>
                                      <div className="flex flex-wrap gap-1.5">
                                        {Object.entries(stab.featureCsi).map(([feat, csiVal]: [string, any]) => (
                                          <span key={feat} className="text-[9px] font-mono px-2 py-0.5 rounded bg-slate-950/60 border border-slate-800 text-slate-300">
                                            <span className="text-slate-500">{featLabels[feat] || feat}:</span> {typeof csiVal === 'number' ? csiVal.toFixed(4) : csiVal}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </>
                    );
                  })()}
                </div>

                {/* Thresholds Config */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-4">
                  <span className="text-[10px] font-bold text-rose-400 uppercase tracking-wider bg-rose-500/10 px-2 py-0.5 rounded">📐 C. Monitoring Thresholds</span>

                  <div className="space-y-2">
                    <p className="text-[9px] text-amber-400 font-bold uppercase">PSI Thresholds</p>
                    {[
                      { k: 'PSI Warning', v: 'psi_warning', color: 'text-amber-400' },
                      { k: 'PSI Critical', v: 'psi_critical', color: 'text-rose-400' },
                    ].map(({ k, v, color }) => (
                      <div key={k} className="flex items-center justify-between">
                        <label className="text-[11px] text-slate-400">{k}:</label>
                        <input type="text" value={thresholds[v as keyof typeof thresholds]}
                          onChange={e => setThresholds(p => ({ ...p, [v]: e.target.value }))}
                          className={`bg-slate-900 border border-slate-700 px-2 py-1 rounded text-xs font-mono ${color} w-20 text-right outline-none focus:border-indigo-500`} />
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <p className="text-[9px] text-emerald-400 font-bold uppercase">Performance Minimums</p>
                    {[
                      { k: 'Gini Min', v: 'gini_min' }, { k: 'AUC Min', v: 'auc_min' }, { k: 'KS Min', v: 'ks_min' },
                    ].map(({ k, v }) => (
                      <div key={k} className="flex items-center justify-between">
                        <label className="text-[11px] text-slate-400">{k}:</label>
                        <input type="text" value={thresholds[v as keyof typeof thresholds]}
                          onChange={e => setThresholds(p => ({ ...p, [v]: e.target.value }))}
                          className="bg-slate-900 border border-slate-700 px-2 py-1 rounded text-xs font-mono text-emerald-400 w-20 text-right outline-none focus:border-indigo-500" />
                      </div>
                    ))}
                  </div>

                  {/* Per-Feature CSI — Dynamic */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[9px] text-indigo-400 font-bold uppercase">CSI per Feature</p>
                      <button onClick={addCsiFeature}
                        className="text-[9px] px-2 py-1 bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/30 text-indigo-400 rounded-lg font-bold transition">
                        + เพิ่ม Feature
                      </button>
                    </div>

                    {csiFeatures.map((feat, idx) => (
                      <div key={idx} className="bg-slate-950/50 border border-slate-800/60 rounded-xl p-3 space-y-2">
                        {/* Row 1: Feature Key + Label + Delete */}
                        <div className="flex items-start gap-2">
                          <div className="flex-1 space-y-1.5">
                            <div className="flex gap-1.5">
                              <div className="flex-1">
                                <p className="text-[8px] text-slate-600 mb-0.5">Column Name (ชื่อตัวแปรใน CSV)</p>
                                <input
                                  type="text"
                                  value={feat.key}
                                  onChange={e => updateCsiFeature(idx, 'key', e.target.value)}
                                  placeholder="e.g. debt_ratio"
                                  className="w-full bg-slate-900 border border-slate-700 px-2 py-1 rounded text-[10px] font-mono text-emerald-400 outline-none focus:border-indigo-500 placeholder-slate-700"
                                />
                              </div>
                              <div className="flex-1">
                                <p className="text-[8px] text-slate-600 mb-0.5">Label (ชื่อแสดงผล)</p>
                                <input
                                  type="text"
                                  value={feat.label}
                                  onChange={e => updateCsiFeature(idx, 'label', e.target.value)}
                                  placeholder="e.g. DTI Ratio"
                                  className="w-full bg-slate-900 border border-slate-700 px-2 py-1 rounded text-[10px] text-slate-200 outline-none focus:border-indigo-500 placeholder-slate-700"
                                />
                              </div>
                              <div className="w-16">
                                <p className="text-[8px] text-slate-600 mb-0.5">CSI Limit</p>
                                <input
                                  type="text"
                                  value={feat.threshold}
                                  onChange={e => updateCsiFeature(idx, 'threshold', e.target.value)}
                                  className="w-full bg-slate-900 border border-slate-700 px-1.5 py-1 rounded text-[10px] font-mono text-rose-400 text-right outline-none focus:border-indigo-500"
                                />
                              </div>
                            </div>
                            {/* Source / Origin */}
                            <div>
                              <p className="text-[8px] text-slate-600 mb-0.5">Source / ที่มาของตัวแปร</p>
                              <input
                                type="text"
                                value={feat.source}
                                onChange={e => updateCsiFeature(idx, 'source', e.target.value)}
                                placeholder="e.g. WOE-transformed — อัตราส่วนหนี้ต่อรายได้..."
                                className="w-full bg-slate-900 border border-slate-700 px-2 py-1 rounded text-[9px] text-slate-400 outline-none focus:border-indigo-500 placeholder-slate-700"
                              />
                            </div>
                          </div>
                          <button onClick={() => removeCsiFeature(idx)}
                            className="mt-4 text-[10px] px-2 py-1 bg-rose-900/20 hover:bg-rose-900/40 border border-rose-500/20 text-rose-400 rounded-lg transition">
                            ✕
                          </button>
                        </div>

                        {/* Row 2: Bins */}
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-[8px] text-slate-600">Bin Boundaries ({feat.bins.length} ค่า → {feat.bins.length + 1} pools)</p>
                            <button onClick={() => addCsiBin(idx)}
                              className="text-[8px] px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded transition">+ bin</button>
                          </div>
                          {feat.bins.length === 0 ? (
                            <p className="text-[9px] text-slate-700 italic">ยังไม่มี bin — คลิก + bin เพื่อเพิ่ม (จะใช้ decile method อัตโนมัติ)</p>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {feat.bins.map((b, bi) => (
                                <div key={bi} className="flex items-center gap-0.5">
                                  <input
                                    type="text"
                                    value={b}
                                    onChange={e => updateCsiBin(idx, bi, e.target.value)}
                                    className="bg-slate-900 border border-slate-700 px-1.5 py-1 rounded text-[9px] font-mono text-indigo-400 w-20 text-center outline-none focus:border-indigo-500"
                                  />
                                  <button onClick={() => removeCsiBin(idx, bi)}
                                    className="text-[8px] text-slate-600 hover:text-rose-400 transition">✕</button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    {csiFeatures.length === 0 && (
                      <p className="text-[10px] text-slate-600 italic text-center py-2">ยังไม่มี feature — กด + เพิ่ม Feature</p>
                    )}
                  </div>

                  <div className="flex gap-2 pt-1">
                    <button onClick={saveConfig} disabled={isSavingConfig}
                      className="flex-1 py-2 px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold transition disabled:opacity-50">
                      {isSavingConfig ? 'กำลังบันทึก...' : '💾 Save Config'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Center + Right: Simulation */}
              <div className="xl:col-span-2 space-y-5">
                {/* Scorecard / Model Structure Reference */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-bold text-slate-200">
                      📋 {(model as any)?.modelTable ? 'Model Structure (Pools & Points)' : 'Scorecard Reference'}
                    </h2>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono font-bold text-slate-400 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800">
                        {(model as any)?.modelTable?.source || ((model as any)?.modelTable ? 'คำนวณโดยระบบจาก Baseline' : 'จากไฟล์รายงานโมเดล (Model Report)')}
                      </span>
                      {((model as any)?.modelTable?.base_points !== undefined || model?.scoring?.base_points !== undefined) && (
                        <span className="text-[10px] font-mono font-bold text-indigo-400 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800">
                          Base Points = {(model as any)?.modelTable?.base_points ?? model?.scoring?.base_points}
                        </span>
                      )}
                      {(model as any)?.modelTable?.totalIV !== undefined && (
                        <span className="text-[10px] font-mono font-bold text-emerald-400 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800">
                          Total IV = {(model as any).modelTable.totalIV.toFixed(4)}
                        </span>
                      )}
                    </div>
                  </div>

                  {(() => {
                    const mt = (model as any)?.modelTable;
                    if (mt && Array.isArray(mt.rows) && mt.rows.length > 0) {
                      const grouped: Record<string, any[]> = {};
                      for (const r of mt.rows) {
                        if (!r.variable || r.variable === 'base_points') continue;
                        if (!grouped[r.variable]) grouped[r.variable] = [];
                        grouped[r.variable].push(r);
                      }
                      return (
                        <div className="space-y-5">
                          {Object.entries(grouped).map(([varName, pRows]) => (
                            <div key={varName}>
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-[11px] font-bold text-slate-300">{featLabels[varName] || varName}</p>
                                <div className="flex items-center gap-2">
                                  {(() => {
                                    const varIv = (model as any)?.ivSummary?.[varName]?.iv;
                                    if (varIv !== undefined && varIv !== null) {
                                      const ivColor = varIv >= 0.30 ? 'text-emerald-400' : varIv >= 0.10 ? 'text-blue-400' : varIv >= 0.02 ? 'text-amber-400' : 'text-slate-500';
                                      return (
                                        <span className={`text-[10px] font-mono font-bold ${ivColor} bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800`}>
                                          IV = {varIv.toFixed(4)}
                                        </span>
                                      );
                                    }
                                    return null;
                                  })()}
                                  <span className="text-[10px] font-mono text-slate-500 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800">
                                    {pRows.length} pools
                                  </span>
                                </div>
                              </div>
                              <div className="overflow-x-auto">
                                <table className="w-full text-[10px]">
                                  <thead>
                                    <tr className="border-b border-slate-800">
                                      <th className="text-left pb-1 text-slate-500 font-medium">Pool ID</th>
                                      <th className="text-left pb-1 text-slate-500 font-medium">Range / Categories</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">Points</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">Count</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">สัดส่วน</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">Bad Count</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">Bad Rate</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">WOE</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">IV</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {pRows.map((r, i) => {
                                      const rangeText = r.categories
                                        ? (Array.isArray(r.categories) ? r.categories.join(', ') : String(r.categories))
                                        : (r.lower !== null && r.lower !== undefined ? `${r.lower}` : '-∞') +
                                          ' – ' +
                                          (r.upper !== null && r.upper !== undefined ? `${r.upper}` : '+∞');
                                      return (
                                        <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                                          <td className="py-1 text-slate-300 font-mono">{r.pool_id || `P${i + 1}`}</td>
                                          <td className="py-1 text-slate-300">{rangeText}</td>
                                          <td className={`py-1 text-right font-mono font-bold ${(r.points ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {(r.points ?? 0) >= 0 ? '+' : ''}{r.points}
                                          </td>
                                          <td className="py-1 text-right font-mono text-slate-400">
                                            {typeof r.count === 'number' ? r.count.toLocaleString() : (r.count !== undefined && r.count !== null ? r.count : '—')}
                                          </td>
                                          <td className="py-1 text-right font-mono text-slate-400">
                                            {typeof r.share === 'number' ? `${(r.share * 100).toFixed(1)}%` : '—'}
                                          </td>
                                          <td className="py-1 text-right font-mono text-slate-400">
                                            {typeof r.badCount === 'number' ? r.badCount.toLocaleString() : '—'}
                                          </td>
                                          <td className="py-1 text-right font-mono text-slate-400">
                                            {typeof r.badRate === 'number' ? `${(r.badRate * 100).toFixed(2)}%` : '—'}
                                          </td>
                                          <td className="py-1 text-right font-mono text-slate-400">
                                            {typeof r.woe === 'number' ? r.woe.toFixed(4) : '—'}
                                          </td>
                                          <td className="py-1 text-right font-mono text-slate-400">
                                            {typeof r.iv === 'number' ? r.iv.toFixed(4) : '—'}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    }

                    if (Object.keys(scorecard).length > 0) {
                      return (
                        <div className="space-y-5">
                          {Object.keys(scorecard).map(feat => {
                            const sc = scorecard[feat];
                            const ivEntry = (model as any)?.ivSummary?.[feat];
                            if (!sc) return null;
                            const iv = ivEntry?.iv ?? null;
                            const ivColor = iv === null ? 'text-slate-500'
                              : iv >= 0.30 ? 'text-emerald-400'
                              : iv >= 0.10 ? 'text-blue-400'
                              : iv >= 0.02 ? 'text-amber-400'
                              : 'text-slate-500';
                            const ivStrength = iv === null ? '—'
                              : iv >= 0.30 ? 'Strong'
                              : iv >= 0.10 ? 'Medium'
                              : iv >= 0.02 ? 'Weak'
                              : 'Negligible';
                            return (
                              <div key={feat}>
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-[11px] font-bold text-slate-300">{featLabels[feat] || feat}</p>
                                  {iv !== null && (
                                    <span className={`text-[10px] font-mono font-bold ${ivColor} bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800`}>
                                      IV = {iv.toFixed(4)}&nbsp;·&nbsp;{ivStrength}
                                    </span>
                                  )}
                                </div>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-[10px]">
                                    <thead>
                                      <tr className="border-b border-slate-800">
                                        <th className="text-left pb-1 text-slate-500 font-medium">Bin</th>
                                        <th className="text-right pb-1 text-slate-500 font-medium">Count</th>
                                        <th className="text-right pb-1 text-slate-500 font-medium">WOE</th>
                                        <th className="text-right pb-1 text-slate-500 font-medium">Points</th>
                                        <th className="text-right pb-1 text-slate-500 font-medium">Bad Rate</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {sc.bin_labels.map((label: string, i: number) => (
                                        <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                                          <td className="py-1 text-slate-300">{label}</td>
                                          <td className="py-1 text-right font-mono text-slate-500">{sc.count?.[i] ?? '—'}</td>
                                          <td className={`py-1 text-right font-mono ${(sc.woe[i] ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{(sc.woe[i] ?? 0).toFixed(4)}</td>
                                          <td className={`py-1 text-right font-mono font-bold ${(sc.points[i] ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{(sc.points[i] ?? 0) >= 0 ? '+' : ''}{sc.points[i]}</td>
                                          <td className="py-1 text-right font-mono text-slate-400">{((sc.bad_rate[i] ?? 0) * 100).toFixed(1)}%</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    }

                    return (
                      <div className="bg-slate-950/40 border border-slate-800/60 rounded-xl p-4 text-center">
                        <p className="text-xs text-slate-500 italic">ไม่มีข้อมูลโครงสร้างโมเดล (Scorecard / Model Table)</p>
                      </div>
                    );
                  })()}
                </div>

                {/* IV Summary */}
                {(model as any)?.ivSummary && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-1">
                      <h2 className="text-sm font-bold text-slate-200">📊 Information Value (IV) Summary</h2>
                      <span className="text-[10px] font-mono text-slate-400 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800">
                        {(model as any)?.modelTable ? 'คำนวณโดยระบบจาก Baseline' : 'จาก ascore_model_report.xlsx · Sheet: IV Summary'}
                      </span>
                    </div>
                    <p className="text-[9px] text-slate-500 mb-4">
                      {(model as any)?.modelTable ? 'คำนวณโดยระบบจาก Baseline · ครอบคลุมทุกตัวแปรในโมเดล' : 'จาก ascore_model_report.xlsx · Sheet: IV Summary — ครอบคลุมทุกตัวแปรที่พิจารณา'}
                    </p>
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="border-b border-slate-800">
                          <th className="text-left pb-2 text-slate-500 font-medium">Variable</th>
                          <th className="text-right pb-2 text-slate-500 font-medium">IV</th>
                          <th className="text-right pb-2 text-slate-500 font-medium">Bins</th>
                          <th className="text-left pb-2 text-slate-500 font-medium pl-3">Strength</th>
                          <th className="text-center pb-2 text-slate-500 font-medium">In Model</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries((model as any).ivSummary as Record<string, any>).map(([varName, entry]) => {
                          const iv = entry.iv as number;
                          const inModel = entry.usedInModel as boolean;
                          const ivColor = iv >= 0.30 ? 'text-emerald-400'
                            : iv >= 0.10 ? 'text-blue-400'
                            : iv >= 0.02 ? 'text-amber-400'
                            : 'text-slate-500';
                          const barW = Math.min(iv / 0.5 * 100, 100);
                          return (
                            <tr key={varName} className={`border-b border-slate-800/40 ${inModel ? '' : 'opacity-60'}`}>
                              <td className="py-1.5 font-mono text-slate-300">
                                {inModel && <span className="mr-1 text-indigo-400">✓</span>}
                                {varName}
                              </td>
                              <td className="py-1.5 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full ${
                                      iv >= 0.30 ? 'bg-emerald-500' : iv >= 0.10 ? 'bg-blue-500' : 'bg-amber-500'
                                    }`} style={{ width: `${barW}%` }} />
                                  </div>
                                  <span className={`font-mono font-bold ${ivColor} w-12 text-right`}>{iv.toFixed(4)}</span>
                                </div>
                              </td>
                              <td className="py-1.5 text-right text-slate-500">{entry.numBins}</td>
                              <td className={`py-1.5 pl-3 ${ivColor}`}>{entry.strength}</td>
                              <td className="py-1.5 text-center">{inModel ? '✓' : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="mt-3 pt-3 border-t border-slate-800/60 grid grid-cols-4 gap-2 text-[9px] text-slate-600">
                      <span>IV &lt; 0.02 → Negligible</span>
                      <span>0.02–0.10 → Weak</span>
                      <span>0.10–0.30 → Medium</span>
                      <span>≥ 0.30 → Strong</span>
                    </div>
                  </div>
                )}

                {/* Feature Distribution */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                  <h2 className="text-sm font-bold text-slate-200 mb-4">📊 Baseline Feature Distribution</h2>
                  <div className="grid grid-cols-3 gap-4">
                    {Object.keys(model?.baseline?.feature_stats || model?.featureRegistry || scorecard).map(feat => {
                      const fs = model?.baseline?.feature_stats?.[feat];
                      if (!fs) return null;
                      return (
                        <div key={feat} className="bg-slate-950/40 rounded-xl p-3">
                          <p className="text-[10px] font-bold text-slate-300 mb-2">{featLabels[feat]}</p>
                          <div className="space-y-1">
                            {[['Mean', fs.mean], ['Std', fs.std], ['P25', fs.p25], ['P50', fs.p50], ['P75', fs.p75]].map(([k, v]) => (
                              <div key={k} className="flex justify-between text-[10px]">
                                <span className="text-slate-500">{k}:</span>
                                <span className="text-slate-300 font-mono">{typeof v === 'number' ? v.toLocaleString() : v}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Score Distribution — จาก ascore_model_report.xlsx */}
                {model?.baseline?.score_distribution && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                    <h2 className="text-sm font-bold text-slate-200 mb-1">📐 Score Distribution</h2>
                    <p className="text-[9px] text-slate-500 mb-4">จาก ascore_model_report.xlsx · Baseline scorecard distribution (n = {model.baseline.sample_size})</p>
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <div className="bg-slate-950/50 rounded-xl p-3 text-center">
                        <p className="text-[9px] text-slate-500 uppercase mb-1">Mean</p>
                        <p className="text-lg font-bold font-mono text-indigo-400">{model.baseline.score_distribution.mean?.toFixed(1)}</p>
                      </div>
                      <div className="bg-slate-950/50 rounded-xl p-3 text-center">
                        <p className="text-[9px] text-slate-500 uppercase mb-1">Min</p>
                        <p className="text-lg font-bold font-mono text-rose-400">{model.baseline.score_distribution.min?.toFixed(1)}</p>
                      </div>
                      <div className="bg-slate-950/50 rounded-xl p-3 text-center">
                        <p className="text-[9px] text-slate-500 uppercase mb-1">Max</p>
                        <p className="text-lg font-bold font-mono text-emerald-400">{model.baseline.score_distribution.max?.toFixed(1)}</p>
                      </div>
                    </div>
                    <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-2">Decile Bounds</p>
                    <div className="flex flex-wrap gap-2">
                      {model.baseline.score_distribution.decile_bounds?.map((b: number, i: number) => (
                        <div key={i} className="bg-slate-950/50 border border-slate-800 rounded-lg px-2.5 py-1.5 text-center">
                          <p className="text-[8px] text-slate-600">D{i + 1}</p>
                          <p className="text-[11px] font-mono text-slate-300">{b.toFixed(2)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* KS Decile Table — จาก ascore_model_report.xlsx */}
                {ksDecileTable.length > 0 && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                    <h2 className="text-sm font-bold text-slate-200 mb-1">📊 KS Decile Table</h2>
                    <p className="text-[9px] text-slate-500 mb-4">
                      จาก ascore_model_report.xlsx · Test period {model?.baseline?.performance?.test?.period ?? '—'} · Max KS = {(maxKS * 100).toFixed(1)}%
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="border-b border-slate-800">
                            {['Decile', 'N', 'Bad', 'Good', 'Score Range', 'Bad Rate', 'Cum Bad', 'Cum Good', 'KS'].map((h, i) => (
                              <th key={h} className={`pb-1 px-1.5 text-slate-500 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {ksDecileTable.map(row => {
                            const isMaxKS = row.ks === maxKS;
                            return (
                              <tr key={row.decile} className={`border-b border-slate-800/40 hover:bg-slate-800/20 ${isMaxKS ? 'bg-indigo-500/5' : ''}`}>
                                <td className="py-1 px-1.5 text-left text-slate-300 font-mono">{row.decile}</td>
                                <td className="py-1 px-1.5 text-right font-mono text-slate-400">{row.n}</td>
                                <td className="py-1 px-1.5 text-right font-mono text-rose-400">{row.bad}</td>
                                <td className="py-1 px-1.5 text-right font-mono text-emerald-400">{row.good}</td>
                                <td className="py-1 px-1.5 text-right font-mono text-slate-400">{row.minScore?.toFixed(1)}–{row.maxScore?.toFixed(1)}</td>
                                <td className="py-1 px-1.5 text-right font-mono text-slate-300">{(row.badRate * 100).toFixed(1)}%</td>
                                <td className="py-1 px-1.5 text-right font-mono text-slate-400">{(row.cumBad * 100).toFixed(1)}%</td>
                                <td className="py-1 px-1.5 text-right font-mono text-slate-400">{(row.cumGood * 100).toFixed(1)}%</td>
                                <td className={`py-1 px-1.5 text-right font-mono font-bold ${isMaxKS ? 'text-indigo-400' : 'text-slate-300'}`}>{(row.ks * 100).toFixed(1)}%</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
            ) : (
              <AnomalyExperimentPanel modelId={currentModelId} />
            )}
            </div>

          /* ════════════════════════════════════════════════════════
             TAB: MONITORING
          ════════════════════════════════════════════════════════ */
          ) : (
            <div className="space-y-6">
              {/* Duplicate upload warning */}
              {duplicateUploadWarning && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-center justify-between gap-3 text-xs text-amber-300">
                  <div className="flex items-center gap-2">
                    <span className="text-base">⚠️</span>
                    <span>คำเตือน: {duplicateUploadWarning}</span>
                  </div>
                  <button
                    onClick={() => setDuplicateUploadWarning(null)}
                    className="text-amber-400 hover:text-amber-200 px-2 py-1 text-xs"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Historical view banner */}
              {viewingHistoricalRun && (
                <div className="bg-indigo-950/60 border border-indigo-500/40 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-lg shadow-indigo-950/30">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 font-mono font-bold border border-indigo-500/30 flex items-center gap-1.5">
                      <span>🕒</span> ดูย้อนหลัง · {viewingHistoricalRun.fileName} · {formatAppDateTime(viewingHistoricalRun.uploadedAt)}
                    </span>
                    {!viewingHistoricalRun.hasDetail && (
                      <span className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-full font-medium">
                        ⚠️ ไม่มีรายละเอียด (บันทึกก่อนอัปเดต)
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setViewingHistoricalRun(null);
                      if (latestUploadSession) {
                        setUploadedMetrics(latestUploadSession.uploadedMetrics);
                        setUploadedCsiDetail(latestUploadSession.uploadedCsiDetail);
                        setUploadedRiskGrades(latestUploadSession.uploadedRiskGrades);
                        setPreviewCustomers(latestUploadSession.previewCustomers);
                        setValidation(latestUploadSession.validation);
                        setUploadSummary(latestUploadSession.uploadSummary);
                        setFileName(latestUploadSession.fileName);
                        setRowCount(latestUploadSession.rowCount);
                      } else {
                        setUploadedMetrics(null);
                        setUploadedCsiDetail(null);
                        setUploadedRiskGrades([]);
                        setPreviewCustomers([]);
                        setValidation(null);
                        setUploadSummary(null);
                        setFileName('');
                        setRowCount(0);
                      }
                    }}
                    className="text-xs px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition-colors flex items-center gap-1.5 shadow"
                  >
                    <span>⬅️</span> กลับไปมุมมองล่าสุด
                  </button>
                </div>
              )}

              {/* Legacy summary if viewing historical run without detail */}
              {viewingHistoricalRun && !viewingHistoricalRun.hasDetail && selectedLog && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-slate-200">สรุปข้อมูลการรัน (บันทึกก่อนอัปเดต)</h4>
                      <p className="text-xs text-slate-400 mt-0.5">{selectedLog.fileName} · {formatAppDateTime(selectedLog.uploadedAt)}</p>
                    </div>
                    <Badge status={selectedLog.verdict} />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <MetricCard label="PSI" value={selectedLog.results?.psi ?? null} color={selectedLog.results?.psi !== undefined && selectedLog.results.psi < psiWarningNum ? 'text-emerald-400' : 'text-amber-400'} />
                    <MetricCard label="Processed / Total" value={`${(selectedLog.processedRows ?? selectedLog.rowCount).toLocaleString()} / ${selectedLog.rowCount.toLocaleString()}`} color="text-slate-200" />
                    <MetricCard label="Trigger Action" value={selectedLog.triggerAction ?? '—'} color="text-indigo-400" />
                    <MetricCard label="Anomaly Flagged" value={selectedLog.flaggedRows ? `${selectedLog.flaggedRows} แถว` : '—'} color="text-amber-400" />
                  </div>
                </div>
              )}

              {/* Upload + baseline info row */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Active Model Info */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
                  <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider mb-3">Reference Dataset (คงที่)</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      <span className="text-xs font-bold text-slate-200">{model?.name}</span>
                      {currentVersion && <span className="text-[9px] font-mono text-slate-500">v{currentVersion}</span>}
                    </div>
                    {reference ? (
                      <div className="text-[10px] text-slate-400 space-y-0.5 mt-2 font-mono">
                        <p><span className="text-slate-500">ID:</span> {reference.referenceId} <span className="text-slate-600">v{reference.version}</span></p>
                        <p><span className="text-slate-500">N:</span> {reference.rowCount.toLocaleString()} · <span className="text-slate-500">Bad:</span> {(reference.badRate * 100).toFixed(2)}%</p>
                        {(() => {
                          const pStart = reference.periodStart?.trim();
                          const pEnd = reference.periodEnd?.trim();
                          let periodDisplay = 'ไม่ระบุ';
                          if (pStart && pEnd) {
                            periodDisplay = `${pStart} → ${pEnd}`;
                          } else if (pStart || pEnd) {
                            periodDisplay = pStart || pEnd;
                          } else {
                            const baselinePeriod =
                              (model as any)?.baseline?.performance?.train?.period ||
                              (model as any)?.developmentStats?.reported?.train?.period ||
                              (model as any)?.modelCard?.developmentPeriod;
                            if (baselinePeriod && String(baselinePeriod).trim()) {
                              periodDisplay = String(baselinePeriod).trim();
                            }
                          }
                          return <p><span className="text-slate-500">ช่วง:</span> {periodDisplay}</p>;
                        })()}
                        <p title={reference.sha256}><span className="text-slate-500">sha256:</span> {reference.sha256.slice(0, 12)}…</p>
                      </div>
                    ) : (
                      <p className="text-[10px] text-rose-400 mt-2">ไม่พบ Reference Dataset</p>
                    )}
                    <p className="text-[9px] text-slate-600">
                      PSI/CSI ทุกครั้งเทียบกับข้อมูลชุดนี้ชุดเดียว — ดูค่าประสิทธิภาพโมเดล (AUC/Gini/KS) ได้ที่แท็บ 📋 Model Reference
                    </p>
                  </div>
                </div>

                {/* Upload Zone */}
                <div className="lg:col-span-2 bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">📤 Upload New Data for Monitoring</p>
                    {!activeVer && (
                      <span className="text-[10px] text-amber-400 font-mono bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded">
                        ไม่มีเวอร์ชัน ACTIVE
                      </span>
                    )}
                  </div>

                  {!activeVer && (
                    <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3.5 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-start gap-2.5">
                        <span className="text-lg leading-none">⚠️</span>
                        <div className="space-y-0.5">
                          <p className="font-semibold text-amber-300">
                            โมเดล "{currentModelId}" ยังไม่มีเวอร์ชันที่เปิดใช้งาน (ACTIVE)
                          </p>
                          <p className="text-[11px] text-amber-200/80 leading-relaxed">
                            Monitoring ของโมเดลนี้จะใช้ไม่ได้จนกว่าจะเปิดใช้งานเวอร์ชันใหม่ กรุณาไปที่แท็บ Baseline Registry เพื่อเปิดใช้งานหรือเรียกกลับมาใช้งาน (Re-activate) เวอร์ชันที่ต้องการ
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => setActiveTab('registry')}
                        className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs transition shadow-sm whitespace-nowrap"
                      >
                        ไปที่แท็บ Registry
                      </button>
                    </div>
                  )}

                  <div
                    onClick={() => {
                      if (!activeVer) {
                        setUploadErrorCode('NO_ACTIVE_VERSION');
                        setUploadError(`โมเดล "${currentModelId}" ยังไม่มีเวอร์ชันที่เปิดใช้งาน (ACTIVE) — กรุณาไปที่แท็บ Registry เพื่อเปิดใช้งานเวอร์ชันก่อนทำการอัปโหลด`);
                        return;
                      }
                      fileInputRef.current?.click();
                    }}
                    className={`border-2 border-dashed ${!activeVer ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-700 hover:border-indigo-500'} rounded-xl p-6 cursor-pointer transition-all text-center group`}
                  >
                    {isUploading ? (
                      <div className="text-slate-400 text-sm animate-pulse">⏳ กำลังประมวลผล...</div>
                    ) : fileName ? (
                      <div>
                        <p className="text-sm font-bold text-emerald-400">✅ {fileName}</p>
                        <p className="text-xs text-slate-400">{rowCount.toLocaleString()} แถว — คลิกเพื่ออัปโหลดใหม่</p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-3xl mb-2 group-hover:scale-110 transition-transform">📂</p>
                        <p className="text-sm text-slate-300 font-medium">คลิกเพื่อเลือก CSV</p>
                        {(() => {
                          const expected = getModelExpectedColumns(activeVer || displayVer || model, csiFeatures);
                          return (
                            <div className="text-[11px] text-slate-400 mt-2 space-y-1.5 text-left max-w-lg mx-auto bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                              <p>
                                <strong className="text-rose-400 font-semibold">• 🔴 จำเป็น (Required):</strong>{' '}
                                <span className="font-mono text-slate-200">
                                  {expected.requiredCols.length > 0 ? expected.requiredCols.join(', ') : 'คอลัมน์ตัวแปรโมเดล'}
                                </span>{' '}
                                <span className="text-[10px] text-rose-300/80">(ไฟล์ถูกปฏิเสธถ้าขาด)</span>
                              </p>
                              {expected.optionalFeatureCols.length > 0 && (
                                <p>
                                  <strong className="text-amber-400 font-semibold">• 🟡 ใช้ถ้ามี (Optional Monitored):</strong>{' '}
                                  <span className="font-mono text-slate-300">
                                    {expected.optionalFeatureCols.join(', ')}
                                  </span>{' '}
                                  <span className="text-[10px] text-amber-300/80">(ขาดแล้วข้ามการตรวจ Drift ตัวนั้น)</span>
                                </p>
                              )}
                              {expected.alternativeCols.length > 0 && (
                                <p>
                                  <strong className="text-slate-400 font-semibold">• ⚪ ทางเลือกอื่น (Alternatives / Metadata):</strong>{' '}
                                  <span className="font-mono text-slate-300">
                                    {expected.alternativeCols.join(', ')}
                                  </span>
                                </p>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  <input type="file" accept=".csv" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                  {uploadError && (
                    <div className="mt-3 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs text-rose-300">
                      <p className="flex items-center gap-1.5">
                        <span>❌</span>
                        <span>{uploadError}</span>
                      </p>
                      {(uploadErrorCode === 'NO_ACTIVE_VERSION' || !activeVer) && (
                        <button
                          onClick={() => setActiveTab('registry')}
                          className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded-lg text-xs transition whitespace-nowrap"
                        >
                          ไปที่แท็บ Registry
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ── [1] Data Validation report (separate from drift) ── */}
              {validation && (
                <div className={`border rounded-2xl p-4 ${validation.ok ? 'border-slate-800 bg-slate-900/60' : 'border-fuchsia-500/40 bg-fuchsia-500/5'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <p className="text-[10px] font-bold text-fuchsia-300 uppercase tracking-wider">🧾 ขั้นที่ 1 — ตรวจสอบความถูกต้องของข้อมูล (Data Validation)</p>
                    {(() => {
                      if (!validation.ok) {
                        return <Badge status="FAIL" />;
                      }

                      // Read validation policy thresholds from active model config / version
                      const valPolicy = (model as any)?.validationPolicy || (displayVer as any)?.validationPolicy || {};
                      const warnRejPct = valPolicy.rejectedPctWarning ?? (model as any)?.triggerConfig?.validationWarningPct ?? 1.0;
                      const critRejPct = valPolicy.rejectedPctCritical ?? (model as any)?.triggerConfig?.validationCriticalPct ?? 5.0;

                      const hasRejected = validation.rejectedRows > 0;
                      const hasWarnings = (validation.warningRows ?? 0) > 0 || validation.warnings.length > 0;

                      if (!hasRejected && !hasWarnings) {
                        return (
                          <span className="text-[10px] px-2.5 py-0.5 rounded border font-bold bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                            ✅ PASS
                          </span>
                        );
                      }

                      // Text: "PASS (มีการตัดแถว N แถว, %)"
                      const label = hasRejected
                        ? `PASS (มีการตัดแถว ${validation.rejectedRows.toLocaleString()} แถว, ${validation.rejectedPct}%)`
                        : `PASS (พบคำเตือน ${(validation.warningRows ?? validation.warnings.length).toLocaleString()} แถว)`;

                      // Color level tied to model policy:
                      // - Orange (Critical/High): rejectedPct >= critRejPct
                      // - Yellow/Amber (Warning): rejectedPct >= warnRejPct or warnings exist
                      const isOrange = validation.rejectedPct >= critRejPct;
                      const badgeStyle = isOrange
                        ? 'bg-orange-500/15 text-orange-400 border-orange-500/30'
                        : 'bg-amber-500/15 text-amber-400 border-amber-500/30';

                      return (
                        <span className={`text-[10px] px-2.5 py-0.5 rounded border font-bold ${badgeStyle}`}>
                          ⚠️ {label}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2 mb-3">
                    <MetricCard small label="แถวทั้งหมด" value={validation.totalRows.toLocaleString()} />
                    <MetricCard small label="ผ่าน (ใช้คำนวณ)" value={validation.validRows.toLocaleString()} color="text-emerald-400" />
                    <MetricCard small label="ตัดออก" value={validation.rejectedRows.toLocaleString()} color={validation.rejectedRows ? 'text-rose-400' : 'text-slate-400'} />
                    <MetricCard small label="% ตัดออก" value={`${validation.rejectedPct}%`} color={validation.rejectedPct >= 5 ? 'text-rose-400' : validation.rejectedPct > 0 ? 'text-amber-400' : 'text-slate-400'} />
                    <MetricCard small label="แถวติดคำเตือน (ไม่ซ้ำ)" value={validation.warningRows !== undefined ? `${validation.warningRows.toLocaleString()} (${validation.warningRowPct ?? 0}%)` : '—'} color={validation.warningRows ? 'text-amber-400' : 'text-slate-400'} />
                  </div>
                  {validation.blockingErrors.length > 0 && (
                    <div className="mb-3 space-y-1">
                      <p className="text-[10px] font-bold text-rose-400">หยุดการคำนวณ PSI/CSI เนื่องจาก:</p>
                      {validation.blockingErrors.map((e, i) => (
                        <p key={i} className="text-[11px] text-rose-300">• {e.message}</p>
                      ))}
                    </div>
                  )}
                  {validation.warnings.length > 0 && (
                    <div className="mb-3 space-y-1">
                      {validation.warnings.map((w, i) => (
                        <p key={i} className="text-[11px] text-amber-300">⚠️ {w.message}</p>
                      ))}
                    </div>
                  )}
                  {validation.groups.length > 0 ? (
                    <div className="overflow-x-auto space-y-2">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-500">
                            <th className="text-left py-1.5 px-2 font-medium">ประเภท</th>
                            <th className="text-left py-1.5 px-2 font-medium">คอลัมน์</th>
                            <th className="text-right py-1.5 px-2 font-medium">จำนวนครั้งที่พบ</th>
                            <th className="text-left py-1.5 px-2 font-medium">ผลต่อแถว</th>
                            <th className="text-left py-1.5 px-2 font-medium">ตัวอย่างแถว</th>
                            <th className="text-left py-1.5 px-2 font-medium">รายละเอียด (ตัวอย่าง)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {validation.groups.map((g, i) => (
                            <tr key={i} className="border-b border-slate-800/40">
                              <td className={`py-1.5 px-2 font-semibold ${g.severity === 'error' ? 'text-rose-400' : 'text-amber-300'}`}>{ISSUE_LABEL[g.type] ?? g.type}</td>
                              <td className="py-1.5 px-2 font-mono text-slate-300">{g.column ?? '—'}</td>
                              <td className="py-1.5 px-2 text-right font-mono text-slate-300">{g.count.toLocaleString()} ครั้ง</td>
                              <td className="py-1.5 px-2 text-slate-400">{g.severity === 'error' ? 'ตัดแถวออก' : 'ใช้ได้ (แจ้งเตือน)'}</td>
                              <td className="py-1.5 px-2 font-mono text-slate-500">{g.sampleRows.join(', ')}{g.count > g.sampleRows.length ? ', …' : ''}</td>
                              <td className="py-1.5 px-2 text-slate-400">{g.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      {/* สรุปแถวไม่ซ้ำ เทียบกับ จำนวนครั้งที่พบ */}
                      {(() => {
                        const warnGroups = validation.groups.filter(g => g.severity === 'warning');
                        const totalWarnHits = warnGroups.reduce((acc, g) => acc + g.count, 0);
                        const uniqueWarnRows = validation.warningRows ?? 0;
                        const overlapCount = totalWarnHits - uniqueWarnRows;

                        return (
                          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-2.5 text-[10px] space-y-1">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-300">
                              <span>
                                📊 <strong>สรุปรายการคำเตือน:</strong> พบทั้งหมด <span className="font-mono font-bold text-amber-400">{totalWarnHits.toLocaleString()}</span> ครั้ง จากข้อมูล <span className="font-mono font-bold text-cyan-400">{uniqueWarnRows.toLocaleString()}</span> แถวไม่ซ้ำ ({validation.warningRowPct ?? 0}% ของแถวทั้งหมด)
                              </span>
                              {overlapCount > 0 && (
                                <span className="text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
                                  💡 มี {overlapCount} แถวที่พบคำเตือนมากกว่า 1 ประเภทในแถวเดียวกัน
                                </span>
                              )}
                            </div>
                            <p className="text-[9px] text-slate-500">
                              เลขแถวนับจากแถวข้อมูลแรก = 1 (ไม่นับ header) — แถวที่ติดเฉพาะคำเตือน (Warning) จะไม่ถูกตัดออกและยังคงนำไปคำนวณ PSI/CSI ตามปกติ
                            </p>
                          </div>
                        );
                      })()}
                    </div>
                  ) : validation.ok && (
                    <p className="text-[11px] text-emerald-400">✅ ข้อมูลทุกแถวผ่านการตรวจสอบ</p>
                  )}
                </div>
              )}

              {/* Results after upload */}
              {uploadedMetrics && (
                <div className="space-y-5">
                  {/* KPI Cards — PSI/CSI เท่านั้น */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <MetricCard label="PSI" value={uploadedMetrics.psi} color={uploadedMetrics.psi < psiWarningNum ? 'text-emerald-400' : uploadedMetrics.psi < psiCriticalNum ? 'text-amber-400' : 'text-rose-400'} />
                    <MetricCard label="N Used (valid)" value={(uploadedMetrics.processedRows ?? rowCount).toLocaleString()} color="text-slate-200" />
                    <MetricCard label="N Periods" value={uploadSummary ? String(uploadSummary.periods.length) : null} color="text-cyan-400" />
                    <MetricCard
                      label="Max Missing %"
                      value={uploadSummary ? `${Math.max(...uploadSummary.missingData.map(m => m.missingPct)).toFixed(1)}%` : null}
                      color={uploadSummary && Math.max(...uploadSummary.missingData.map(m => m.missingPct)) > 5 ? 'text-rose-400' : 'text-amber-400'}
                    />
                  </div>

                  {/* Upload Data Summary — ช่วงเวลา + ข้อมูลขาดหาย */}
                  {uploadSummary && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {/* Period breakdown */}
                      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
                        <p className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider mb-3">🗓️ ช่วงเวลาของข้อมูลที่อัปโหลด</p>
                        {uploadSummary.periods.length === 0 ? (
                          <p className="text-[10px] text-slate-600 italic">ไม่มีข้อมูล</p>
                        ) : (
                          <div className="space-y-1.5">
                            {uploadSummary.periods.map(p => (
                              <div key={p.period} className="flex items-center gap-2">
                                <span className={`text-[10px] font-mono w-20 shrink-0 ${p.period === 'ไม่ระบุวันที่' ? 'text-slate-600 italic' : 'text-slate-300'}`}>{p.period}</span>
                                <div className="flex-1 h-3 bg-slate-800 rounded overflow-hidden">
                                  <div className="h-full bg-cyan-500/70 rounded" style={{ width: `${Math.max(p.pct, 2)}%` }} />
                                </div>
                                <span className="text-[10px] font-mono text-slate-400 w-24 text-right">{p.count.toLocaleString()} ราย ({p.pct}%)</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Missing data */}
                      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
                        <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-3">⚠️ ข้อมูลขาดหายต่อคอลัมน์</p>
                        <div className="space-y-1.5">
                          {uploadSummary.missingData.map(m => {
                            const bad = m.missingPct > 5;
                            return (
                              <div key={m.column} className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-300 w-28 shrink-0 truncate">{m.label}</span>
                                <div className="flex-1 h-3 bg-slate-800 rounded overflow-hidden">
                                  <div className={`h-full rounded ${bad ? 'bg-rose-500/80' : 'bg-emerald-500/60'}`} style={{ width: `${Math.max(m.missingPct, m.missingPct > 0 ? 2 : 0)}%` }} />
                                </div>
                                <span className={`text-[10px] font-mono w-28 text-right ${bad ? 'text-rose-400 font-bold' : 'text-slate-400'}`}>{m.missingCount.toLocaleString()} ({m.missingPct}%)</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Comparison Table */}
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
                    <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
                      <h3 className="text-sm font-bold text-slate-200">📊 ขั้นที่ 2 — Drift Detection: New Data vs Reference ({reference?.referenceId ?? '—'})</h3>
                      <Badge status={uploadedMetrics.status} />
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 bg-slate-950/30">
                            <th className="text-left py-3 px-4 text-slate-500 font-medium">Metric</th>
                            <th className="text-center py-3 px-4 text-slate-500 font-medium">Baseline (Dev)</th>
                            <th className="text-center py-3 px-4 text-slate-500 font-medium">New Data</th>
                            <th className="text-center py-3 px-4 text-slate-500 font-medium">Δ</th>
                            <th className="text-center py-3 px-4 text-slate-500 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* PSI */}
                          <tr className="border-b border-slate-800/50 hover:bg-slate-800/20">
                            <td className="py-3 px-4 font-semibold text-slate-300">PSI — Score Distribution <span className="text-slate-500 font-normal">(ต่ำกว่า = ดี)</span></td>
                            <td className="py-3 px-4 text-center font-mono text-slate-400">
                              <div>&lt; {psiWarningNum.toFixed(2)}</div>
                              {uploadedMetrics.devPsi !== undefined && uploadedMetrics.devPsi !== null && (
                                <span className="text-[9px] text-slate-500 block font-normal">ตอนพัฒนา: {uploadedMetrics.devPsi.toFixed(4)}</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-center font-mono font-bold text-slate-200">{uploadedMetrics.psi.toFixed(4)}</td>
                            <td className="py-3 px-4 text-center font-mono text-slate-400">—</td>
                            <td className="py-3 px-4 text-center"><Badge status={uploadedMetrics.psiStatus ?? uploadedMetrics.status} /></td>
                          </tr>
                          {/* CSI per feature — from server result (thresholds snapshot used for this run) */}
                          {Object.entries((uploadedCsiDetail ?? {}) as Record<string, any>).map(([feat, detail]) => {
                            const csiVal: number = detail.value;
                            const limit: number = detail.threshold ?? 0.10;
                            const diff = csiVal - limit;
                            const displayName = detail.displayName || feat;
                            const sourceText = detail.source;
                            return (
                              <Fragment key={feat}>
                                <tr className="hover:bg-slate-800/20">
                                  <td className="py-3 px-4">
                                    <p className="font-semibold text-slate-300">CSI — {displayName} <span className="text-slate-500 font-normal">(ต่ำกว่า = ดี)</span></p>
                                    {sourceText && <p className="text-[9px] text-slate-600 mt-0.5 font-mono">{sourceText}</p>}
                                  </td>
                                  <td className="py-3 px-4 text-center font-mono text-rose-400">
                                    <div>&lt; {limit.toFixed(3)}</div>
                                    {detail.devCsi !== undefined && detail.devCsi !== null && (
                                      <span className="text-[9px] text-slate-500 block font-normal">ตอนพัฒนา: {detail.devCsi.toFixed(4)}</span>
                                    )}
                                  </td>
                                  <td className="py-3 px-4 text-center font-mono font-bold text-slate-200">{csiVal.toFixed(4)}</td>
                                  <td className={`py-3 px-4 text-center font-mono font-semibold ${diff <= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(4)}</td>
                                  <td className="py-3 px-4 text-center"><Badge status={detail.status ?? (csiVal < limit ? 'STABLE' : 'WARNING')} /></td>
                                </tr>
                                {detail?.bin_distribution && (
                                <tr className="bg-slate-950/30">
                                    <td colSpan={5} className="px-5 pb-3 pt-1">
                                      <p className="text-[9px] text-slate-500 mb-2">Bin Distribution — Baseline vs New Data</p>
                                      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${detail.bin_distribution.length}, 1fr)` }}>
                                        {detail.bin_distribution.map((bin: any, i: number) => {
                                          const shifted = Math.abs(bin.actual_pct - bin.baseline_pct) > 5;
                                          return (
                                            <div key={i} className={`rounded-lg p-2 border text-center ${shifted ? 'border-rose-500/30 bg-rose-500/5' : 'border-slate-800 bg-slate-900/40'}`}>
                                              <p className="text-[8px] text-slate-500 mb-1">{bin.label}</p>
                                              <div className="space-y-1">
                                                <div className="flex items-center gap-1">
                                                  <span className="text-[7px] text-slate-600 w-5">Base</span>
                                                  <div className="flex-1 h-1.5 bg-slate-700 rounded overflow-hidden">
                                                    <div className="h-full bg-indigo-500/70 rounded" style={{ width: `${Math.min(100, bin.baseline_pct * 3)}%` }} />
                                                  </div>
                                                  <span className="text-[8px] text-indigo-400 w-7 text-right">{bin.baseline_pct}%</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                  <span className="text-[7px] text-slate-600 w-5">New</span>
                                                  <div className="flex-1 h-1.5 bg-slate-700 rounded overflow-hidden">
                                                    <div className={`h-full rounded ${shifted ? 'bg-rose-500/80' : 'bg-emerald-500/70'}`} style={{ width: `${Math.min(100, bin.actual_pct * 3)}%` }} />
                                                  </div>
                                                  <span className={`text-[8px] w-7 text-right ${shifted ? 'text-rose-400' : 'text-emerald-400'}`}>{bin.actual_pct}%</span>
                                                </div>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Preview Table */}
                  {previewCustomers.length > 0 && (
                    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                      <h3 className="text-sm font-bold text-slate-200 mb-3">👤 Scored Records (first 20)</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-[10px]">
                          <thead>
                            <tr className="border-b border-slate-800">
                              <th className="text-left pb-2 px-2 text-slate-500 font-medium">#</th>
                              <th className="text-left pb-2 px-2 text-slate-500 font-medium">ID</th>
                              {csiFeatures.slice(0, 4).map(f => (
                                <th key={f.key} className="text-left pb-2 px-2 text-slate-500 font-medium">{f.label || f.key}</th>
                              ))}
                              <th className="text-left pb-2 px-2 text-slate-500 font-medium">Score</th>
                              <th className="text-left pb-2 px-2 text-slate-500 font-medium">PD</th>
                              <th className="text-left pb-2 px-2 text-slate-500 font-medium">Label</th>
                            </tr>
                          </thead>
                          <tbody>
                            {previewCustomers.slice(0, 20).map((c, i) => (
                              <tr key={i} className="border-b border-slate-800/30 hover:bg-slate-800/20">
                                <td className="py-1.5 px-2 text-slate-500">{c.row ?? i + 1}</td>
                                <td className="py-1.5 px-2 text-slate-300 font-mono">{c.id ?? '—'}</td>
                                {csiFeatures.slice(0, 4).map(f => (
                                  <td key={f.key} className="py-1.5 px-2 font-mono text-slate-300">
                                    {typeof c[f.key] === 'number' ? c[f.key]?.toLocaleString() : (c[f.key] ?? '—')}
                                  </td>
                                ))}
                                <td className="py-1.5 px-2 font-mono font-bold text-indigo-400">{c.score !== null && c.score !== undefined ? Number(c.score).toFixed(2) : '—'}</td>
                                <td className="py-1.5 px-2 font-mono text-rose-400">{typeof c.pd === 'number' && c.pd > 0 ? (c.pd * 100).toFixed(2) + '%' : '—'}</td>
                                <td className="py-1.5 px-2">{c.defaultLabel === 1 ? <span className="text-rose-400 font-bold">BAD</span> : c.defaultLabel === 0 ? <span className="text-emerald-400">good</span> : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ── คำแนะนำการใช้แบบจำลอง (อิงจาก PSI/CSI เท่านั้น) ── */}
                  {uploadedMetrics && (() => {
                    const psi      = uploadedMetrics.psi;
                    const psiWarn  = parseFloat(thresholds.psi_warning)  || 0.10;
                    const psiCrit  = parseFloat(thresholds.psi_critical) || 0.25;
                    const csiEntries: [string, number][] = Object.entries(uploadedMetrics.csi || {});
                    const worstCsi = csiEntries.reduce<{ feat: string; val: number; limit: number } | null>((worst, [feat, val]) => {
                      const limit = (uploadedCsiDetail as any)?.[feat]?.threshold ?? 0.10;
                      const ratio = val / limit;
                      if (!worst || ratio > worst.val / worst.limit) return { feat, val, limit };
                      return worst;
                    }, null);
                    const worstCsiBreached = worstCsi ? worstCsi.val >= worstCsi.limit : false;

                    const psiWarn_ = psi >= psiWarn && psi < psiCrit;
                    const psiCrit_ = psi >= psiCrit;

                    let recTitle  = '';
                    let recDetail = '';
                    let recColor  = '';

                    if (psiCrit_) {
                      recTitle  = '🔴 แนะนำ: ทบทวน/พัฒนาแบบจำลองใหม่';
                      recColor  = 'border-rose-500/40 bg-rose-500/5';
                      recDetail = `PSI = ${psi.toFixed(3)} สูงเกินเกณฑ์ Critical (${psiCrit}) บ่งชี้ว่า Distribution ของ Population เปลี่ยนแปลงอย่างรุนแรง `;
                      recDetail += `แนะนำ: (1) ตรวจสอบ Population Shift จาก CSI ต่อตัวแปร (2) Retrain ด้วยข้อมูลที่เป็น Out-of-Time `;
                      recDetail += `(3) พิจารณา Champion-Challenger Testing`;
                    } else if (psiWarn_ || worstCsiBreached) {
                      recTitle  = '🟡 แนะนำ: ปรับ Cut-off คะแนน หรือ Monitor เพิ่มเติม';
                      recColor  = 'border-amber-500/40 bg-amber-500/5';
                      recDetail = `PSI = ${psi.toFixed(3)} อยู่ในระดับ${psiWarn_ ? ` Warning (${psiWarn}–${psiCrit})` : 'ปกติ'}${worstCsiBreached && worstCsi ? ` และ CSI ของ ${csiFeatures.find(f => f.key === worstCsi.feat)?.label || worstCsi.feat} เกินเกณฑ์ (${worstCsi.val.toFixed(3)} ≥ ${worstCsi.limit.toFixed(2)})` : ''} บ่งชี้ว่า Distribution เปลี่ยนแปลงบ้าง แต่ยังไม่รุนแรง `;
                      recDetail += `แนะนำ: (1) ตรวจ CSI ต่อตัวแปร ว่าตัวแปรใดเปลี่ยนมากที่สุด `;
                      recDetail += `(2) Back-test Cut-off ปัจจุบัน vs Approval Rate/Bad Rate `;
                      recDetail += `(3) พิจารณาขยาย Cut-off 5–10 points หากต้องการลด Bad Rate `;
                      recDetail += `(4) วาง monitoring cycle ถี่ขึ้นเป็นรายเดือน`;
                    } else {
                      recTitle  = '🟢 แบบจำลองยังใช้งานได้ — ติดตามต่อเนื่อง';
                      recColor  = 'border-emerald-500/40 bg-emerald-500/5';
                      recDetail = `PSI = ${psi.toFixed(3)} อยู่ในเกณฑ์ปกติ (< ${psiWarn}) และ CSI ทุกตัวแปรอยู่ในเกณฑ์ Distribution ของ Population ไม่เปลี่ยนแปลงอย่างมีนัยสำคัญ `;
                      recDetail += `แนะนำ: ติดตาม PSI/CSI ตาม monitoring cycle ปกติ (รายไตรมาส หรือรายเดือนหาก portfolio เติบโตเร็ว)`;
                    }

                    return (
                      <div className={`border rounded-2xl p-5 ${recColor}`}>
                        <div className="flex items-start justify-between mb-3">
                          <h3 className="text-sm font-bold text-slate-200">{recTitle}</h3>
                          <Badge status={uploadedMetrics.status} />
                        </div>
                        <p className="text-[11px] text-slate-300 leading-relaxed">{recDetail}</p>

                        {/* Summary metrics strip */}
                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <div className="bg-slate-950/40 rounded-xl p-3 text-center">
                            <p className="text-[9px] text-slate-500 uppercase mb-1">PSI</p>
                            <p className={`text-lg font-bold font-mono ${psiCrit_ ? 'text-rose-400' : psiWarn_ ? 'text-amber-400' : 'text-emerald-400'}`}>{psi.toFixed(4)}</p>
                            <p className="text-[9px] text-slate-600 mt-0.5">{psiCrit_ ? 'Critical' : psiWarn_ ? 'Warning' : 'Stable'}</p>
                          </div>
                          <div className="bg-slate-950/40 rounded-xl p-3 text-center">
                            <p className="text-[9px] text-slate-500 uppercase mb-1">Worst CSI</p>
                            <p className={`text-lg font-bold font-mono ${worstCsiBreached ? 'text-rose-400' : 'text-emerald-400'}`}>{worstCsi ? worstCsi.val.toFixed(4) : '—'}</p>
                            <p className="text-[9px] text-slate-600 mt-0.5">{worstCsi ? (csiFeatures.find(f => f.key === worstCsi.feat)?.label || worstCsi.feat) : '—'}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── ผลของการใช้แบบจำลอง — Risk Grade Distribution ── */}
                  {uploadedRiskGrades.length > 0 && (() => {
                    const total = uploadedRiskGrades.reduce((s, g) => s + g.count, 0);
                    const isLetterGrades = uploadedRiskGrades.some(g =>
                      ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-'].includes(g.grade)
                    );
                    const igGrades = uploadedRiskGrades.filter(g => ['AAA','AA+','AA','AA-','A+','A','A-'].includes(g.grade));
                    const bbbGrades = uploadedRiskGrades.filter(g => ['BBB+','BBB','BBB-'].includes(g.grade));
                    const igPct  = igGrades.reduce((s, g) => s + g.pct, 0);
                    const bbbPct = bbbGrades.reduce((s, g) => s + g.pct, 0);
                    const highestBucket = [...uploadedRiskGrades].sort((a, b) => b.count - a.count)[0];
                    const scoreDir = (activeVer?.scoreDirection || displayVer?.scoreDirection || (model as any)?.scoreDirection || 'higher_is_safer') as 'higher_is_safer' | 'higher_is_riskier';

                    const N = uploadedRiskGrades.length;
                    const k1 = Math.max(1, Math.floor(N * 0.2));
                    const k2 = Math.max(k1 + 1, Math.floor(N * 0.4));
                    const k3 = Math.max(k2 + 1, Math.floor(N * 0.7));

                    const tier1Items = uploadedRiskGrades.slice(0, k1);
                    const tier2Items = uploadedRiskGrades.slice(k1, k2);
                    const tier3Items = uploadedRiskGrades.slice(k2, k3);
                    const tier4Items = uploadedRiskGrades.slice(k3);

                    const tier1Names = tier1Items.map(g => g.grade).join('–');
                    const tier2Names = tier2Items.map(g => g.grade).join('–');
                    const tier3Names = tier3Items.map(g => g.grade).join('–');
                    const tier4Names = tier4Items.map(g => g.grade).join('–');

                    const safeDecilePct = +tier1Items.reduce((s, g) => s + g.pct, 0).toFixed(1);
                    const riskDecilePct = +tier4Items.reduce((s, g) => s + g.pct, 0).toFixed(1);

                    const gradeColor = (g: string) => {
                      if (isLetterGrades) {
                        return g.startsWith('AAA') || g.startsWith('AA') ? '#22d3ee'
                          : g.startsWith('A')  ? '#6366f1'
                          : g.startsWith('BBB+') || g === 'BBB' ? '#f59e0b'
                          : '#f87171';
                      }
                      const idx = uploadedRiskGrades.findIndex(item => item.grade === g);
                      if (idx < k1) return '#22d3ee';
                      if (idx < k2) return '#6366f1';
                      if (idx < k3) return '#3b82f6';
                      if (idx < N - 1) return '#f59e0b';
                      return '#f87171';
                    };

                    return (
                      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                        <h3 className="text-sm font-bold text-slate-200 mb-1">📊 ผลของการใช้แบบจำลอง — การกระจายระดับความเสี่ยง</h3>
                        <p className="text-[9px] text-slate-500 mb-4">
                          {isLetterGrades
                            ? `คะแนน A-Score แปลงเป็น Risk Grade ตาม KS Decile bounds จาก ascore_model_report.xlsx (n = ${total.toLocaleString()})`
                            : `คะแนนแปลงเป็น Risk Grade ตาม KS Decile bounds จาก Reference Profile (n = ${total.toLocaleString()})`}
                        </p>

                        {/* Summary bullets */}
                        <div className="mb-4 space-y-1.5 text-[11px] text-slate-300">
                          {isLetterGrades ? (
                            <>
                              <p>● แบบจำลองมีการกระจายตัวของระดับความเสี่ยงที่{' '}
                                <span className={igPct > 50 ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                                  {igPct > 70 ? 'เหมาะสม' : igPct > 40 ? 'พอใช้ได้' : 'ต้องตรวจสอบ'}
                                </span>{' '}
                                — ลูกค้าในระดับ AAA–A รวม{' '}
                                <span className="text-cyan-400 font-bold">{igPct.toFixed(1)}%</span>
                              </p>
                              <p>● กลุ่มที่มีลูกค้ามากที่สุดคือระดับ{' '}
                                <span className="text-indigo-400 font-bold">{highestBucket?.grade}</span>{' '}
                                ({highestBucket?.count.toLocaleString()} ราย · {highestBucket?.pct}%)
                              </p>
                              <p>● ลูกค้าระดับ BBB+–BBB- รวม{' '}
                                <span className="text-amber-400 font-bold">{bbbPct.toFixed(1)}%</span>{' '}
                                — ระดับความเสี่ยงค่อนข้างสูง ควรติดตาม NPL Rate อย่างใกล้ชิด
                              </p>
                            </>
                          ) : (
                            <>
                              <p>● การกระจายตัวตามกลุ่มความเสี่ยง ({N} ระดับ): ลูกค้ากลุ่มความเสี่ยงต่ำสุด ({tier1Names}) รวม{' '}
                                <span className="text-cyan-400 font-bold">{safeDecilePct}%</span>
                              </p>
                              <p>● กลุ่มที่มีลูกค้าหนาแน่นที่สุดคือระดับ{' '}
                                <span className="text-indigo-400 font-bold">{highestBucket?.grade}</span>{' '}
                                ({highestBucket?.count.toLocaleString()} ราย · {highestBucket?.pct}%)
                              </p>
                              <p>● ลูกค้ากลุ่มความเสี่ยงสูงสุด ({tier4Names}) รวม{' '}
                                <span className="text-amber-400 font-bold">{riskDecilePct}%</span>{' '}
                                — ระดับความเสี่ยงสูง ควรติดตาม NPL Rate และการผิดนัดชำระอย่างใกล้ชิด
                              </p>
                              <p className="text-[10px] text-slate-400">
                                ● ทิศทางคะแนน ({scoreDir}): {scoreDir === 'higher_is_riskier' ? 'คะแนนยิ่งสูงยิ่งเสี่ยง (Higher is Riskier)' : 'คะแนนยิ่งสูงยิ่งปลอดภัย (Higher is Safer)'} — ระบบจัดระดับให้ D1 คือกลุ่มเสี่ยงต่ำสุด ({scoreDir === 'higher_is_riskier' ? 'คะแนนต่ำ' : 'คะแนนสูง'}) เรียงไปถึง D{N} คือกลุ่มเสี่ยงสูงสุด ({scoreDir === 'higher_is_riskier' ? 'คะแนนสูง' : 'คะแนนต่ำ'})
                              </p>
                            </>
                          )}
                        </div>

                        {/* Grade bar chart */}
                        <div className="space-y-1.5">
                          {uploadedRiskGrades.filter(g => g.count > 0).map(g => {
                            const barW = Math.max(g.pct * 2, 2);
                            return (
                              <div key={g.grade} className="flex items-center gap-3">
                                <span className="text-[10px] font-mono text-slate-400 w-10 text-right">{g.grade}</span>
                                <div className="flex-1 h-4 bg-slate-800 rounded overflow-hidden">
                                  <div
                                    className="h-full rounded transition-all duration-500"
                                    style={{ width: `${barW}%`, backgroundColor: gradeColor(g.grade) }}
                                  />
                                </div>
                                <span className="text-[10px] font-mono text-slate-400 w-16 text-right">
                                  {g.count.toLocaleString()} ({g.pct}%)
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {/* Grade legend */}
                        <div className="mt-4 pt-3 border-t border-slate-800/60 grid grid-cols-2 gap-1 text-[9px] text-slate-600">
                          {isLetterGrades ? (
                            <>
                              <span style={{ color: '#22d3ee' }}>■ AAA–AA-  : ความเสี่ยงต่ำมาก</span>
                              <span style={{ color: '#6366f1' }}>■ A+–A-   : ความเสี่ยงต่ำ</span>
                              <span style={{ color: '#f59e0b' }}>■ BBB+–BBB : ความเสี่ยงปานกลาง</span>
                              <span style={{ color: '#f87171' }}>■ BBB-    : ความเสี่ยงสูง</span>
                            </>
                          ) : (
                            <>
                              <span style={{ color: '#22d3ee' }}>■ {tier1Names} : ความเสี่ยงต่ำสุด (Safest)</span>
                              <span style={{ color: '#6366f1' }}>■ {tier2Names} : ความเสี่ยงต่ำ</span>
                              <span style={{ color: '#3b82f6' }}>■ {tier3Names} : ความเสี่ยงปานกลาง</span>
                              <span style={{ color: '#f87171' }}>■ {tier4Names} : ความเสี่ยงสูงสุด (Highest risk)</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── ติดตาม Label Drift & Bad Rate คาดหมายตามช่วงคะแนน ── */}
                  {uploadedMetrics.driftReport?.label && uploadedMetrics.driftReport.label.status !== 'NOT_AVAILABLE' && uploadedMetrics.driftReport.label.metrics && (() => {
                    const lm = uploadedMetrics.driftReport.label.metrics;
                    const adj = lm.scoreAdjusted;
                    const isCrit = uploadedMetrics.driftReport.label.status === 'CRITICAL';
                    const isWarn = uploadedMetrics.driftReport.label.status === 'WARNING';
                    const borderColor = isCrit ? 'border-rose-500/40 bg-rose-500/5' : isWarn ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-800 bg-slate-900/60';

                    return (
                      <div className={`border rounded-2xl p-5 ${borderColor}`}>
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-sm font-bold text-slate-200">🎯 การติดตามอัตราผิดนัดชำระหนี้ (Label Drift & Expected Bad Rate)</h3>
                          <Badge status={uploadedMetrics.driftReport.label.status} />
                        </div>
                        <p className="text-[11px] text-slate-300 mb-4">{uploadedMetrics.driftReport.label.reason}</p>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                          <MetricCard small label="Baseline Bad Rate" value={`${(lm.referenceBadRate * 100).toFixed(2)}%`} color="text-slate-300" />
                          <MetricCard small label="Actual Bad Rate" value={`${(lm.actualBadRate * 100).toFixed(2)}%`} color={isCrit ? 'text-rose-400' : isWarn ? 'text-amber-400' : 'text-emerald-400'} />
                          {adj && (
                            <>
                              <MetricCard small label="Expected Bad Rate (ช่วงคะแนน)" value={`${(adj.expectedBadRate * 100).toFixed(2)}%`} color="text-cyan-400" />
                              <MetricCard small label="ผลต่างเทียบค่าคาด" value={`${adj.diffFromExpected >= 0 ? '+' : ''}${(adj.diffFromExpected * 100).toFixed(2)}%pts`} color={adj.explainableByScoreShift ? 'text-emerald-400' : 'text-amber-400'} />
                            </>
                          )}
                        </div>

                        {/* ── การทดสอบสมมติฐานทางสถิติ (Statistical Hypothesis Tests) ── */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                          {/* Test 1: เทียบ Reference Baseline (ตัวที่ Trigger ใช้ตัดสิน) */}
                          <div className="bg-slate-950/60 border border-indigo-500/30 rounded-xl p-3">
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <span className="text-[10px] font-bold text-indigo-300 uppercase tracking-wider">
                                1. ทดสอบเทียบ Reference Baseline
                              </span>
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                                🎯 ใช้ตัดสิน Trigger (R5/R8)
                              </span>
                            </div>
                            <div className="flex items-baseline justify-between mb-1.5">
                              <span className="text-[11px] text-slate-400 font-medium">p-value (Unadjusted):</span>
                              <span className={`font-mono font-bold text-sm ${lm.pValue !== null && lm.pValue < 0.05 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                {lm.pValue !== null && lm.pValue !== undefined ? lm.pValue.toFixed(4) : '—'}
                              </span>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-snug">
                              ทดสอบว่า Actual Bad Rate ({(lm.actualBadRate * 100).toFixed(2)}%) ต่างจาก Reference Baseline ({(lm.referenceBadRate * 100).toFixed(2)}%) อย่างมีนัยสำคัญหรือไม่ โดยระบบ Trigger (กฎ R5/R8) ใช้ผลทดสอบนี้ในการตัดสินสถานะ Label Drift และการแจ้งเตือน
                            </p>
                          </div>

                          {/* Test 2: เทียบค่าคาดตามช่วงคะแนน Score-Adjusted (ตัวช่วยวิเคราะห์สาเหตุ) */}
                          <div className="bg-slate-950/60 border border-cyan-500/30 rounded-xl p-3">
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <span className="text-[10px] font-bold text-cyan-300 uppercase tracking-wider">
                                2. ทดสอบเทียบค่าคาดตามช่วงคะแนน
                              </span>
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                                🔍 วิเคราะห์สาเหตุ (Explainability)
                              </span>
                            </div>
                            <div className="flex items-baseline justify-between mb-1.5">
                              <span className="text-[11px] text-slate-400 font-medium">p-value (Score-Adjusted):</span>
                              <span className={`font-mono font-bold text-sm ${adj?.pValue !== null && adj?.pValue !== undefined ? (adj.pValue < 0.05 ? 'text-amber-400' : 'text-emerald-400') : 'text-slate-400'}`}>
                                {adj?.pValue !== null && adj?.pValue !== undefined ? adj.pValue.toFixed(4) : '—'}
                              </span>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-snug">
                              ทดสอบเทียบ Actual Bad Rate กับ Expected ({adj ? (adj.expectedBadRate * 100).toFixed(2) : '—'}%) ที่ปรับตามการกระจายคะแนน เพื่อดูว่าความต่างเกิดจากการเปลี่ยนของคุณภาพลูกค้า (Score Shift, p ≥ 0.05) หรือโมเดลเสื่อมจริง
                            </p>
                          </div>
                        </div>

                        {adj && (
                          <div className={`text-[11px] rounded-xl px-3 py-2 border ${adj.explainableByScoreShift ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-300'}`}>
                            {adj.explainableByScoreShift ? '💡 ' : '⚠️ '}{adj.reason}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                </div>
              )}

              {/* Monitor Log Table */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-bold text-slate-200">🗂️ Monitoring Log</h3>
                    {selectedLogIds.size > 0 && (
                      <button
                        onClick={() => {
                          setConfirmDelete({
                            type: 'multiple',
                            ids: Array.from(selectedLogIds),
                            displayInfo: `เลือกไว้ทั้งหมด ${selectedLogIds.size} รายการ`,
                          });
                        }}
                        className="px-2.5 py-1 text-xs rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 font-medium transition-colors flex items-center gap-1.5"
                      >
                        🗑️ ลบที่เลือก ({selectedLogIds.size})
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer">
                      <input id="log-only-current-version" type="checkbox" checked={onlyCurrentVersion} onChange={e => setOnlyCurrentVersion(e.target.checked)} className="accent-indigo-500" />
                      เฉพาะ config v{currentVersion ?? '—'}
                    </label>
                    <span className="text-[10px] text-slate-500">{visibleLogs.length}/{monitorLogs.length} sessions</span>
                  </div>
                </div>
                {storage && !storage.persistent && (
                  <p className="px-5 py-2 text-[10px] text-amber-300 bg-amber-500/5 border-b border-amber-500/20">
                    ⚠️ ยังไม่ได้เชื่อมฐานข้อมูล (ตั้ง KV_REST_API_URL / KV_REST_API_TOKEN บน Vercel) — Log จะหายเมื่อ server restart
                  </p>
                )}
                {visibleLogs.length === 0 ? (
                  <div className="text-center text-slate-600 py-10 text-sm">ยังไม่มี log — อัปโหลด CSV เพื่อเริ่ม Monitor</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 bg-slate-950/30">
                          <th className="py-2.5 px-3 w-8">
                            <input
                              type="checkbox"
                              className="accent-indigo-500 rounded cursor-pointer"
                              checked={visibleLogs.length > 0 && selectedLogIds.size === visibleLogs.length}
                              onChange={e => {
                                if (e.target.checked) {
                                  setSelectedLogIds(new Set(visibleLogs.map(l => l.logId)));
                                } else {
                                  setSelectedLogIds(new Set());
                                }
                              }}
                            />
                          </th>
                          {/* Headers — dynamic CSI columns */}
                          {['วันที่', 'ไฟล์', 'Config', 'Valid / Rows', 'PSI',
                            ...csiFeatures.map(f => `CSI — ${f.label || f.key}`),
                            'Verdict'
                          ].map(h => (
                            <th key={h} className="text-left py-2.5 px-3 text-slate-500 font-medium whitespace-nowrap">{h}</th>
                          ))}
                          <th className="py-2.5 px-3 w-10 text-right"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleLogs.map(log => {
                          const psi = log.results?.psi;
                          const psiColor = psi === undefined ? 'text-slate-600' : psi < psiWarningNum ? 'text-emerald-400' : psi < psiCriticalNum ? 'text-amber-400' : 'text-rose-400';
                          const isSelected = selectedLog?.logId === log.logId || viewingHistoricalRun?.runId === log.logId;
                          const csiStatus = (log.results as any)?.csiStatus as Record<string, string> | undefined;
                          return (
                            <Fragment key={log.logId}>
                            <tr
                              className={`border-b border-slate-800/40 hover:bg-slate-800/20 cursor-pointer ${isSelected ? 'bg-indigo-950/20' : ''}`}
                              onClick={() => handleSelectLog(log)}
                            >
                              <td className="py-2.5 px-3" onClick={e => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  className="accent-indigo-500 rounded cursor-pointer"
                                  checked={selectedLogIds.has(log.logId)}
                                  onChange={e => {
                                    const next = new Set(selectedLogIds);
                                    if (e.target.checked) next.add(log.logId);
                                    else next.delete(log.logId);
                                    setSelectedLogIds(next);
                                  }}
                                />
                              </td>
                              <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">{formatAppDateTime(log.uploadedAt)}</td>
                              <td className="py-2.5 px-3 text-slate-300 max-w-xs" title={log.fileName}>
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="truncate">{log.fileName}</span>
                                  {log.hasDetail && (
                                    <span className="shrink-0 text-[9px] px-1 rounded bg-indigo-500/20 text-indigo-400 font-mono" title="มีรายละเอียดการรัน">
                                      detail
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 font-mono text-[10px] text-slate-500">{log.configVersion ? `v${log.configVersion}` : '—'}</td>
                              <td className="py-2.5 px-3 font-mono text-slate-400">{(log.processedRows ?? log.rowCount).toLocaleString()} / {log.rowCount.toLocaleString()}</td>
                              <td className={`py-2.5 px-3 font-mono font-bold ${psiColor}`}>{psi !== undefined ? psi.toFixed(4) : '—'}</td>
                          {/* CSI columns — dynamic from csiFeatures */}
                          {csiFeatures.map(featCfg => {
                            const csiVal = log.results?.csi?.[featCfg.key];
                            const st = csiStatus?.[featCfg.key];
                            const ok = st ? st === 'STABLE' : csiVal !== undefined && csiVal < (parseFloat(featCfg.threshold) || 0.10);
                            return (
                              <td key={featCfg.key} className={`py-2.5 px-3 font-mono ${csiVal === undefined ? 'text-slate-600' : ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {csiVal !== undefined ? csiVal.toFixed(4) : '—'}
                              </td>
                            );
                          })}
                              <td className="py-2.5 px-3"><Badge status={log.verdict} /></td>
                              <td className="py-2.5 px-3 text-right" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-end gap-1.5">
                                  <a
                                    href={`/dashboard/report/${encodeURIComponent(log.logId)}?modelId=${encodeURIComponent(selectedModelId || currentModelId)}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[11px] px-2 py-1 rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 border border-indigo-500/30 flex items-center gap-1 transition-colors font-medium whitespace-nowrap"
                                    title="เปิดรายงานฉบับเต็มของรอบนี้"
                                  >
                                    <span>📄</span>
                                    <span>รายงาน</span>
                                  </a>
                                  <button
                                    onClick={() => {
                                      setConfirmDelete({
                                        type: 'single',
                                        ids: [log.logId],
                                        displayInfo: `${log.fileName} (${formatAppDateTime(log.uploadedAt)})`,
                                      });
                                    }}
                                    title="ลบรายการนี้"
                                    className="text-slate-500 hover:text-rose-400 p-1 rounded hover:bg-slate-800 transition-colors"
                                  >
                                    🗑️
                                  </button>
                                </div>
                              </td>
                            </tr>
                            {isSelected && !viewingHistoricalRun?.hasDetail && (
                              <tr key={`${log.logId}-detail`} className="bg-slate-950/40">
                                <td colSpan={8 + csiFeatures.length} className="px-4 py-3">
                                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                    <div>
                                      <p className="text-[9px] font-bold text-cyan-400 uppercase tracking-wider mb-2">🗓️ ช่วงเวลาของไฟล์นี้</p>
                                      {log.uploadSummary?.periods?.length ? (
                                        <div className="space-y-1">
                                          {log.uploadSummary.periods.map(p => (
                                            <div key={p.period} className="flex justify-between text-[10px]">
                                              <span className={p.period === 'ไม่ระบุวันที่' ? 'text-slate-600 italic' : 'text-slate-300'}>{p.period}</span>
                                              <span className="text-slate-400 font-mono">{p.count.toLocaleString()} ราย ({p.pct}%)</span>
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <p className="text-[10px] text-slate-600 italic">ไม่มีข้อมูลบันทึกไว้ในไฟล์นี้ (log เก่ากว่าฟีเจอร์นี้)</p>
                                      )}
                                    </div>
                                    <div>
                                      <p className="text-[9px] font-bold text-amber-400 uppercase tracking-wider mb-2">⚠️ ข้อมูลขาดหายต่อคอลัมน์</p>
                                      {log.uploadSummary?.missingData?.length ? (
                                        <div className="space-y-1">
                                          {log.uploadSummary.missingData.map(m => (
                                            <div key={m.column} className="flex justify-between text-[10px]">
                                              <span className="text-slate-300">{m.label}</span>
                                              <span className={`font-mono ${m.missingPct > 5 ? 'text-rose-400 font-bold' : 'text-slate-400'}`}>{m.missingCount.toLocaleString()} ({m.missingPct}%)</span>
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <p className="text-[10px] text-slate-600 italic">ไม่มีข้อมูลบันทึกไว้ในไฟล์นี้ (log เก่ากว่าฟีเจอร์นี้)</p>
                                      )}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* PSI Trend from log (drift runs of the selected config version only) */}
              {driftLogs.length > 0 && (() => {
                const activeThresholdMode: 'fixed' | 'calibrated' =
                  (displayVer?.driftConfig?.thresholdMode as 'fixed' | 'calibrated') ||
                  ((model as any)?.driftConfig?.thresholdMode as 'fixed' | 'calibrated') ||
                  ((model as any)?.thresholdMode as 'fixed' | 'calibrated') ||
                  'fixed';

                let effectivePsiWarning = psiWarningNum;
                let effectivePsiCritical = psiCriticalNum;

                if (activeThresholdMode === 'calibrated') {
                  const calBySizes = displayVer?.calibratedThresholds?.bySize || (model as any)?.calibratedThresholds?.bySize;
                  if (calBySizes) {
                    const sizes = Object.keys(calBySizes).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
                    if (sizes.length > 0) {
                      const midSize = sizes[Math.floor(sizes.length / 2)];
                      const calPsi = calBySizes[midSize]?.psi;
                      if (calPsi?.warning) effectivePsiWarning = calPsi.warning;
                      if (calPsi?.critical) effectivePsiCritical = calPsi.critical;
                    }
                  }
                }

                // Sort logs chronologically by detected period or upload timestamp
                const sortedLogs = [...driftLogs].sort((a, b) => {
                  const pA = getLogPeriodInfo(a);
                  const pB = getLogPeriodInfo(b);
                  if (pA.sortKey && pB.sortKey && pA.sortKey !== pB.sortKey) {
                    return pA.sortKey.localeCompare(pB.sortKey);
                  }
                  return new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime();
                });

                // Group rounds per period for round numbering and latest-filtering
                const periodGroups = new Map<string, MonitorLog[]>();
                for (const l of sortedLogs) {
                  const key = getLogPeriodInfo(l).periodLabel || 'UNKNOWN';
                  const list = periodGroups.get(key) || [];
                  list.push(l);
                  periodGroups.set(key, list);
                }

                // If latestOnlyPerPeriod is checked, pick the last upload in each period
                let candidateLogs = sortedLogs;
                if (latestOnlyPerPeriod) {
                  const latestMap = new Map<string, MonitorLog>();
                  for (const l of sortedLogs) {
                    const key = getLogPeriodInfo(l).periodLabel || 'UNKNOWN';
                    latestMap.set(key, l);
                  }
                  candidateLogs = Array.from(latestMap.values());
                }

                const displayLogs = showOot ? candidateLogs : candidateLogs.filter(l => !getLogPeriodInfo(l).isOot);

                const chartData = displayLogs.map(l => {
                  const pInfo = getLogPeriodInfo(l);
                  const periodKey = pInfo.periodLabel || 'UNKNOWN';
                  const fullGroup = periodGroups.get(periodKey) || [l];
                  const uploadRound = fullGroup.findIndex(item => (item.logId ? item.logId === l.logId : item.uploadedAt === l.uploadedAt)) + 1;
                  const totalRoundsInPeriod = fullGroup.length;
                  const isLatestInPeriod = uploadRound === totalRoundsInPeriod;
                  const psiVal = l.results ? parseFloat(l.results.psi.toFixed(4)) : null;
                  const verdictReason = deriveVerdictReason(
                    l,
                    effectivePsiWarning,
                    effectivePsiCritical,
                    csiFeatures,
                    activeThresholdMode
                  );
                  const triggerDecision = deriveTriggerExplanation(l);
                  const csiItems = csiFeatures.map(f => {
                    const val = l.results?.csi?.[f.key];
                    const thr = parseFloat(f.threshold) || 0.10;
                    return {
                      key: f.key,
                      label: f.label || f.key,
                      value: val !== undefined ? parseFloat(val.toFixed(4)) : null,
                      isWarning: val !== undefined && val >= thr && val < Math.max(effectivePsiCritical, thr),
                      isCritical: val !== undefined && val >= Math.max(effectivePsiCritical, thr),
                    };
                  });

                  return {
                    date: pInfo.periodLabel,
                    fileName: l.fileName,
                    period: pInfo.periodLabel,
                    isOot: pInfo.isOot,
                    psi: psiVal,
                    verdict: l.verdict,
                    verdictReason,
                    triggerDecision,
                    uploadRound,
                    totalRoundsInPeriod,
                    isLatestInPeriod,
                    csiItems,
                    'PSI (รายเดือน)': !pInfo.isOot ? psiVal : null,
                    'PSI (OOT / อื่นๆ)': pInfo.isOot ? psiVal : null,
                    ...Object.fromEntries(csiFeatures.map(f => [
                      `CSI — ${f.label || f.key}`,
                      l.results?.csi?.[f.key] !== undefined ? parseFloat(l.results.csi[f.key].toFixed(4)) : null,
                    ])),
                  };
                });

                // Compute dynamic regular Y-axis ticks
                const allMetricValues: number[] = [effectivePsiCritical, effectivePsiWarning];
                for (const d of chartData) {
                  if (d.psi !== null) allMetricValues.push(d.psi);
                  for (const c of d.csiItems) {
                    if (c.value !== null) allMetricValues.push(c.value);
                  }
                }
                const maxMetricVal = Math.max(...allMetricValues, 0.25);
                const targetYMax = Math.max(0.3, maxMetricVal * 1.15);
                let yStep = 0.05;
                if (targetYMax > 0.6) yStep = 0.1;
                if (targetYMax > 1.2) yStep = 0.2;
                if (targetYMax > 2.5) yStep = 0.5;
                const yTickCount = Math.ceil(targetYMax / yStep);
                const yMax = +(yTickCount * yStep).toFixed(2);
                const yTicks: number[] = [];
                for (let i = 0; i <= yTickCount; i++) {
                  yTicks.push(+(i * yStep).toFixed(2));
                }

                return (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-slate-200">📈 PSI / CSI Trend (จากประวัติการอัปโหลด)</h3>
                        <p className="text-[11px] text-slate-400">
                          แกน X แสดงช่วงเวลาของข้อมูล (Period) เชื่อมโยงด้วยเส้นตรง (Linear) ไม่ extrapolate ค่ากลาง
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        {/* Threshold mode badge */}
                        <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-medium border ${
                          activeThresholdMode === 'calibrated'
                            ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
                            : 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                        }`}>
                          {activeThresholdMode === 'calibrated' ? '⚖️ โหมดเกณฑ์: Calibrated (ปรับตามขนาดข้อมูล)' : '🎯 โหมดเกณฑ์: Fixed (มาตรฐาน)'}
                        </span>

                        {/* Latest only per period toggle checkbox */}
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-700/60 hover:bg-slate-800">
                          <input
                            type="checkbox"
                            checked={latestOnlyPerPeriod}
                            onChange={e => setLatestOnlyPerPeriod(e.target.checked)}
                            className="accent-indigo-500 rounded"
                          />
                          <span>ใช้รอบล่าสุดต่อ period</span>
                        </label>

                        {/* OOT toggle checkbox */}
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-700/60 hover:bg-slate-800">
                          <input
                            type="checkbox"
                            checked={showOot}
                            onChange={e => setShowOot(e.target.checked)}
                            className="accent-indigo-500 rounded"
                          />
                          <span>แสดงชุดข้อมูล OOT / อื่นๆ</span>
                        </label>
                      </div>
                    </div>

                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 10, fill: '#64748b' }}
                          tickFormatter={(val, idx) => {
                            if (idx > 0 && chartData[idx - 1]?.date === val) return '';
                            return val;
                          }}
                        />
                        <YAxis domain={[0, yMax]} ticks={yTicks} tick={{ fontSize: 10, fill: '#64748b' }} tickFormatter={v => v.toFixed(2)} />
                        <Tooltip content={<TrendTooltip />} wrapperStyle={{ zIndex: 50, outline: 'none' }} allowEscapeViewBox={{ x: false, y: false }} />
                        <Legend wrapperStyle={{ fontSize: 11, paddingTop: '16px', position: 'relative', zIndex: 10 }} />
                        <ReferenceLine
                          y={effectivePsiWarning}
                          stroke="#f59e0b"
                          strokeDasharray="4 4"
                          label={{ value: `เตือน: ${effectivePsiWarning.toFixed(2)}`, fill: '#f59e0b', fontSize: 10, position: 'insideTopLeft' }}
                        />
                        <ReferenceLine
                          y={effectivePsiCritical}
                          stroke="#ef4444"
                          strokeDasharray="4 4"
                          label={{ value: `วิกฤต: ${effectivePsiCritical.toFixed(2)}`, fill: '#ef4444', fontSize: 10, position: 'insideTopLeft' }}
                        />

                        {/* Line 1: PSI Monthly (Solid Indigo) */}
                        <Line
                          type="linear"
                          dataKey="PSI (รายเดือน)"
                          stroke="#6366f1"
                          strokeWidth={2}
                          dot={{ r: 4, fill: '#6366f1' }}
                          connectNulls
                        />

                        {/* Line 2: PSI OOT / Other (Dashed Purple) */}
                        {showOot && (
                          <Line
                            type="linear"
                            dataKey="PSI (OOT / อื่นๆ)"
                            stroke="#c084fc"
                            strokeWidth={2}
                            strokeDasharray="5 5"
                            dot={{ r: 5, fill: '#a855f7', stroke: '#e9d5ff', strokeWidth: 1.5 }}
                            connectNulls
                          />
                        )}

                        {/* Dynamic CSI lines */}
                        {csiFeatures.map((f, i) => {
                          const colors = ['#facc15', '#22d3ee', '#f472b6', '#34d399', '#fb923c', '#a78bfa'];
                          const key = `CSI — ${f.label || f.key}`;
                          return (
                            <Line
                              key={key}
                              type="linear"
                              dataKey={key}
                              stroke={colors[i % colors.length]}
                              strokeWidth={1.5}
                              dot={{ r: 2 }}
                              connectNulls
                            />
                          );
                        })}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                );
              })()}
            </div>
          )
        )}
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 text-lg">
                ⚠️
              </div>
              <div>
                <h4 className="text-sm font-bold text-slate-100">ยืนยันการลบประวัติการรัน</h4>
                <p className="text-xs text-slate-400 mt-0.5">การลบนี้จะลบรายละเอียดและบันทึกประวัติ Audit Log</p>
              </div>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 text-xs text-slate-300 font-mono">
              {confirmDelete.displayInfo}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={isDeletingLog}
                className="px-4 py-2 text-xs rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition-colors"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleDeleteConfirmed}
                disabled={isDeletingLog}
                className="px-4 py-2 text-xs rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold transition-colors flex items-center gap-1.5"
              >
                {isDeletingLog ? 'กำลังลบ...' : 'ยืนยันการลบ'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}