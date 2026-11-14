'use client';
import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import AnomalyExperimentPanel from './components/AnomalyExperimentPanel';
import BaselineRegistryPanel from './components/BaselineRegistryPanel';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Legend } from 'recharts';

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
}

interface ValidationIssueGroup { type: string; severity: 'error' | 'warning'; column?: string; count: number; sampleRows: number[]; message: string }
interface ValidationIssue { type: string; severity: 'error' | 'warning'; column?: string; row?: number; value?: string; message: string }
interface ValidationResult {
  ok: boolean; totalRows: number; validRows: number; rejectedRows: number; rejectedPct: number;
  blockingErrors: ValidationIssue[]; warnings: ValidationIssue[]; groups: ValidationIssueGroup[]; issues: ValidationIssue[];
}
interface ReferenceMeta { referenceId: string; version: string; rowCount: number; badRate: number; periodStart: string; periodEnd: string; sha256: string; source: string }
interface StorageInfo { kind: 'upstash' | 'file' | 'memory'; persistent: boolean; error?: string }

const ISSUE_LABEL: Record<string, string> = {
  EMPTY_FILE: 'ไฟล์/ข้อมูลไม่พอ', MISSING_COLUMN: 'ไม่พบคอลัมน์', DUPLICATE_COLUMN: 'คอลัมน์ซ้ำ', MISSING_VALUE: 'ค่าว่าง',
  INVALID_TYPE: 'ชนิดข้อมูลผิด', OUT_OF_RANGE: 'ค่านอกช่วง', INVALID_DATE: 'วันที่ผิดรูปแบบ', INVALID_BINARY: 'ต้องเป็น 0/1',
  DUPLICATE_ID: 'รหัสลูกค้าซ้ำ', MALFORMED_ROW: 'แถวผิดรูปแบบ',
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

// ─── Main Dashboard ──────────────────────────────────────────────────────────
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('sandbox');
  const [sandboxSubTab, setSandboxSubTab] = useState<'reference' | 'experiment'>('reference');
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [monitorLogs, setMonitorLogs] = useState<MonitorLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [registeredModels, setRegisteredModels] = useState<any[]>([]);

  // Sandbox state
  const [thresholds, setThresholds] = useState({
    psi_warning: '0.10', psi_critical: '0.25',
    gini_min: '0.10', auc_min: '0.55', ks_min: '0.10',
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
  const [selectedLog, setSelectedLog] = useState<MonitorLog | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [reference, setReference] = useState<ReferenceMeta | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [onlyCurrentVersion, setOnlyCurrentVersion] = useState(true);
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
            psi_warning:  String(t.psi_warning  ?? 0.10),
            psi_critical: String(t.psi_critical ?? 0.25),
            gini_min:     String(t.gini_min     ?? 0.10),
            auc_min:      String(t.auc_min      ?? 0.55),
            ks_min:       String(t.ks_min       ?? 0.10),
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
          throw new Error(data.error || data.detail || 'เกิดข้อผิดพลาดในการประมวลผล');
        }
        setUploadedMetrics(data);
        setUploadedCsiDetail(data.csiDetail || null);
        setUploadedRiskGrades(data.riskGradeDist || []);
        setPreviewCustomers(data.scoredCustomers || []);
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


  const psiWarningNum = parseFloat(thresholds.psi_warning) || 0.10;
  const psiCriticalNum = parseFloat(thresholds.psi_critical) || 0.25;

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
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Model Active
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
                  <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded">📈 B. Baseline Performance (Train / Test / OOT)</span>
                  {(() => {
                    const devPerf = (model as any)?.developmentStats?.reported || (model as any)?.developmentStats?.computed;
                    const testPerf = devPerf?.test || model?.baseline?.performance?.test;
                    const trainPerf = devPerf?.train || model?.baseline?.performance?.train;
                    const ootPerf = devPerf?.oot;
                    const hasDevData = Boolean(
                      (testPerf && (testPerf.auc !== undefined || testPerf.gini !== undefined || testPerf.ks !== undefined)) ||
                      (trainPerf && (trainPerf.auc !== undefined || trainPerf.gini !== undefined || trainPerf.ks !== undefined)) ||
                      (ootPerf && (ootPerf.auc !== undefined || ootPerf.gini !== undefined || ootPerf.ks !== undefined))
                    );

                    if (!hasDevData) {
                      return (
                        <div className="bg-slate-950/40 border border-slate-800/60 rounded-xl p-4 text-center">
                          <p className="text-xs text-slate-500 italic">ไม่มีข้อมูลสถิติตอนพัฒนา (Train/Test/OOT)</p>
                        </div>
                      );
                    }

                    return (
                      <div className="space-y-3 mt-2">
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
                      </div>
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
                    {((model as any)?.modelTable?.base_points !== undefined || model?.scoring?.base_points !== undefined) && (
                      <span className="text-[10px] font-mono font-bold text-indigo-400 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800">
                        Base Points = {(model as any)?.modelTable?.base_points ?? model?.scoring?.base_points}
                      </span>
                    )}
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
                                <span className="text-[10px] font-mono text-slate-500 bg-slate-950/60 px-2 py-0.5 rounded border border-slate-800">
                                  {pRows.length} pools
                                </span>
                              </div>
                              <div className="overflow-x-auto">
                                <table className="w-full text-[10px]">
                                  <thead>
                                    <tr className="border-b border-slate-800">
                                      <th className="text-left pb-1 text-slate-500 font-medium">Pool ID</th>
                                      <th className="text-left pb-1 text-slate-500 font-medium">Range / Categories</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">Points</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">WOE</th>
                                      <th className="text-right pb-1 text-slate-500 font-medium">Count</th>
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
                                          <td className="py-1 text-right font-mono text-slate-500">
                                            {typeof r.woe === 'number' ? r.woe.toFixed(4) : '—'}
                                          </td>
                                          <td className="py-1 text-right font-mono text-slate-500">
                                            {r.count !== undefined && r.count !== null ? r.count : '—'}
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

                {/* IV Summary — ทุกตัวแปรที่พิจารณา (จาก ascore_model_report.xlsx) */}
                {(model as any)?.ivSummary && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                    <h2 className="text-sm font-bold text-slate-200 mb-1">📊 Information Value (IV) Summary</h2>
                    <p className="text-[9px] text-slate-500 mb-4">จาก ascore_model_report.xlsx · Sheet: IV Summary — ครอบคลุมทุกตัวแปรที่พิจารณา</p>
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
                        <p><span className="text-slate-500">ช่วง:</span> {reference.periodStart} → {reference.periodEnd}</p>
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
                  <p className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider mb-3">📤 Upload New Data for Monitoring</p>
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-xl p-6 cursor-pointer transition-all text-center group"
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
                        <p className="text-[10px] text-slate-500 mt-1">
                          ต้องการคอลัมน์: {csiFeatures.map(f => f.key || '?').join(', ')}{model?.columns?.labelColumn ? ` (${model.columns.labelColumn} ถ้ามีสำหรับวัด Performance)` : ''}
                        </p>
                      </div>
                    )}
                  </div>
                  <input type="file" accept=".csv" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                  {uploadError && <p className="text-xs text-rose-400 mt-2">❌ {uploadError}</p>}
                </div>
              </div>

              {/* ── [1] Data Validation report (separate from drift) ── */}
              {validation && (
                <div className={`border rounded-2xl p-4 ${validation.ok ? 'border-slate-800 bg-slate-900/60' : 'border-fuchsia-500/40 bg-fuchsia-500/5'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <p className="text-[10px] font-bold text-fuchsia-300 uppercase tracking-wider">🧾 ขั้นที่ 1 — ตรวจสอบความถูกต้องของข้อมูล (Data Validation)</p>
                    <Badge status={validation.ok ? 'PASS' : 'FAIL'} />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                    <MetricCard small label="แถวทั้งหมด" value={validation.totalRows.toLocaleString()} />
                    <MetricCard small label="ผ่าน (ใช้คำนวณ)" value={validation.validRows.toLocaleString()} color="text-emerald-400" />
                    <MetricCard small label="ตัดออก" value={validation.rejectedRows.toLocaleString()} color={validation.rejectedRows ? 'text-rose-400' : 'text-slate-400'} />
                    <MetricCard small label="% ตัดออก" value={`${validation.rejectedPct}%`} color={validation.rejectedPct > 5 ? 'text-rose-400' : 'text-slate-400'} />
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
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-500">
                            <th className="text-left py-1.5 px-2 font-medium">ประเภท</th>
                            <th className="text-left py-1.5 px-2 font-medium">คอลัมน์</th>
                            <th className="text-right py-1.5 px-2 font-medium">จำนวน</th>
                            <th className="text-left py-1.5 px-2 font-medium">ผล</th>
                            <th className="text-left py-1.5 px-2 font-medium">ตัวอย่างแถว</th>
                            <th className="text-left py-1.5 px-2 font-medium">รายละเอียด (ตัวอย่าง)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {validation.groups.map((g, i) => (
                            <tr key={i} className="border-b border-slate-800/40">
                              <td className={`py-1.5 px-2 font-semibold ${g.severity === 'error' ? 'text-rose-400' : 'text-amber-300'}`}>{ISSUE_LABEL[g.type] ?? g.type}</td>
                              <td className="py-1.5 px-2 font-mono text-slate-300">{g.column ?? '—'}</td>
                              <td className="py-1.5 px-2 text-right font-mono text-slate-300">{g.count.toLocaleString()}</td>
                              <td className="py-1.5 px-2 text-slate-400">{g.severity === 'error' ? 'ตัดแถวออก' : 'ใช้ได้ (แจ้งเตือน)'}</td>
                              <td className="py-1.5 px-2 font-mono text-slate-500">{g.sampleRows.join(', ')}{g.count > g.sampleRows.length ? ', …' : ''}</td>
                              <td className="py-1.5 px-2 text-slate-400">{g.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="text-[9px] text-slate-600 mt-2">เลขแถวนับจากแถวข้อมูลแรก = 1 (ไม่นับ header) — แถวที่ถูกตัดออกจะไม่ถูกนำไปคำนวณ PSI/CSI จึงไม่ปะปนกับการเปลี่ยนแปลงของการกระจายตัว</p>
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
                            <td className="py-3 px-4 text-center font-mono text-slate-400">&lt; {psiWarningNum.toFixed(2)}</td>
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
                                  <td className="py-3 px-4 text-center font-mono text-rose-400">&lt; {limit.toFixed(3)}</td>
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
                    const total   = uploadedRiskGrades.reduce((s, g) => s + g.count, 0);
                    const igGrades = uploadedRiskGrades.filter(g => ['AAA','AA+','AA','AA-','A+','A','A-'].includes(g.grade));
                    const bbbGrades = uploadedRiskGrades.filter(g => ['BBB+','BBB','BBB-'].includes(g.grade));
                    const igPct  = igGrades.reduce((s, g) => s + g.pct, 0);
                    const bbbPct = bbbGrades.reduce((s, g) => s + g.pct, 0);
                    const topGrade = uploadedRiskGrades.find(g => g.count > 0)?.grade ?? '—';
                    const highestBucket = [...uploadedRiskGrades].sort((a, b) => b.count - a.count)[0];

                    const gradeColor = (g: string) =>
                      g.startsWith('AAA') || g.startsWith('AA') ? '#22d3ee'
                      : g.startsWith('A')  ? '#6366f1'
                      : g.startsWith('BBB+') || g === 'BBB' ? '#f59e0b'
                      : '#f87171';

                    return (
                      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                        <h3 className="text-sm font-bold text-slate-200 mb-1">📊 ผลของการใช้แบบจำลอง — การกระจายระดับความเสี่ยง</h3>
                        <p className="text-[9px] text-slate-500 mb-4">
                          คะแนน A-Score แปลงเป็น Risk Grade ตาม KS Decile bounds จาก ascore_model_report.xlsx (n = {total.toLocaleString()})
                        </p>

                        {/* Summary bullets */}
                        <div className="mb-4 space-y-1.5 text-[11px] text-slate-300">
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
                          <span style={{ color: '#22d3ee' }}>■ AAA–AA-  : ความเสี่ยงต่ำมาก</span>
                          <span style={{ color: '#6366f1' }}>■ A+–A-   : ความเสี่ยงต่ำ</span>
                          <span style={{ color: '#f59e0b' }}>■ BBB+–BBB : ความเสี่ยงปานกลาง</span>
                          <span style={{ color: '#f87171' }}>■ BBB-    : ความเสี่ยงสูง</span>
                        </div>
                      </div>
                    );
                  })()}

                </div>
              )}

              {/* Monitor Log Table */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-200">🗂️ Monitoring Log</h3>
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
                          {/* Headers — dynamic CSI columns */}
                          {['วันที่', 'ไฟล์', 'Config', 'Valid / Rows', 'PSI',
                            ...csiFeatures.map(f => `CSI — ${f.label || f.key}`),
                            'Verdict'
                          ].map(h => (
                            <th key={h} className="text-left py-2.5 px-3 text-slate-500 font-medium whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleLogs.map(log => {
                          const psi = log.results?.psi;
                          const psiColor = psi === undefined ? 'text-slate-600' : psi < psiWarningNum ? 'text-emerald-400' : psi < psiCriticalNum ? 'text-amber-400' : 'text-rose-400';
                          const isSelected = selectedLog?.logId === log.logId;
                          const csiStatus = (log.results as any)?.csiStatus as Record<string, string> | undefined;
                          return (
                            <Fragment key={log.logId}>
                            <tr className="border-b border-slate-800/40 hover:bg-slate-800/20 cursor-pointer"
                              onClick={() => setSelectedLog(isSelected ? null : log)}>
                              <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">{new Date(log.uploadedAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</td>
                              <td className="py-2.5 px-3 text-slate-300 max-w-32 truncate">{log.fileName}</td>
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
                            </tr>
                            {isSelected && (
                              <tr key={`${log.logId}-detail`} className="bg-slate-950/40">
                                <td colSpan={6 + csiFeatures.length} className="px-4 py-3">
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
              {driftLogs.length > 1 && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                  <h3 className="text-sm font-bold text-slate-200 mb-4">📈 PSI / CSI Trend (from Upload History)</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={[...driftLogs].reverse().map(l => ({
                      date: new Date(l.uploadedAt).toLocaleDateString('th-TH', { day: '2-digit', month: 'short' }),
                      PSI: parseFloat(l.results!.psi.toFixed(4)),
                      ...Object.fromEntries(csiFeatures.map(f => [
                        `CSI — ${f.label || f.key}`,
                        l.results!.csi?.[f.key] !== undefined ? parseFloat(l.results!.csi[f.key].toFixed(4)) : null,
                      ])),
                    }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} />
                      <YAxis domain={[0, 0.5]} tick={{ fontSize: 10, fill: '#64748b' }} />
                      <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <ReferenceLine y={psiWarningNum} stroke="#f59e0b" strokeDasharray="4 4" />
                      <ReferenceLine y={psiCriticalNum} stroke="#ef4444" strokeDasharray="4 4" />
                      {/* Trend lines — dynamic from csiFeatures */}
                      <Line type="monotone" dataKey="PSI" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} />
                      {csiFeatures.map((f, i) => {
                        const colors = ['#facc15', '#22d3ee', '#f472b6', '#34d399', '#fb923c', '#a78bfa'];
                        const key = `CSI — ${f.label || f.key}`;
                        return <Line key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]} strokeWidth={1.5} dot={{ r: 2 }} />;
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}