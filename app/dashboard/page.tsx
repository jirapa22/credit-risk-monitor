'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
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
  scoring: {
    base_points: number;
    features: string[];
    scorecard: Record<string, { bins: number[]; bin_labels: string[]; count?: number[]; woe: number[]; points: number[]; bad_rate: number[] }>;
  };
  baseline: {
    lockedAt: string;
    sample_size: number;
    bad_rate: number;
    performance: { train?: { auc: number; gini: number; ks: number }; test?: { auc: number; gini: number; ks: number } };
    feature_stats: Record<string, { mean: number; std: number; min: number; p25: number; p50: number; p75: number; max: number }>;
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

interface HistoryEntry {
  month: string;
  timestamp: string;
  source: string;
  psi: number;
  csi: Record<string, number>;
  auc: number | null;
  gini: number | null;
  ks: number | null;
  lift: number | null;
  status: string;
  fileName?: string;
  rowCount?: number;
}

interface MonitorLog {
  logId: string;
  modelId: string;
  modelName: string;
  uploadedAt: string;
  fileName: string;
  rowCount: number;
  results: { psi: number; csi: Record<string, number>; auc: number | null; gini: number | null; ks: number | null; lift: number | null; status: string };
  verdict: string;
}

type ActiveTab = 'sandbox' | 'monitor';
type CsiFeatureItem = { key: string; label: string; source: string; threshold: string; bins: string[] };

// ─── CSV Parser ──────────────────────────────────────────────────────────────
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ''; });
    return row;
  }).filter(r => Object.values(r).some(v => v));
}

// ─── Helper Components ───────────────────────────────────────────────────────
function Badge({ status }: { status: string }) {
  const map: Record<string, string> = {
    STABLE: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    WARNING: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    CRITICAL: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    PASS: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    FAIL: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  };
  const icons: Record<string, string> = { STABLE: '✅', WARNING: '⚠️', CRITICAL: '🚨', PASS: '✅', FAIL: '❌' };
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
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [monitorLogs, setMonitorLogs] = useState<MonitorLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Sandbox state
  const [driftLevel, setDriftLevel] = useState(0.05);
  const [liveMetrics, setLiveMetrics] = useState<any>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [thresholds, setThresholds] = useState({
    psi_warning: '0.10', psi_critical: '0.25',
    gini_min: '0.10', auc_min: '0.55', ks_min: '0.10',
  });
  const defaultCsiFeatures: CsiFeatureItem[] = [
    { key: 'monthly_income', label: 'Monthly Income', source: 'WOE-transformed — รายได้ต่อเดือนจากใบสมัคร (salary/wage)', threshold: '0.10', bins: ['17800', '22300', '27520', '36360'] },
    { key: 'loan_amount',    label: 'Loan Amount',    source: 'WOE-transformed — วงเงินกู้ที่ขอจากใบสมัคร', threshold: '0.10', bins: ['46000', '63000', '81000', '112000'] },
    { key: 'dti_ratio',      label: 'DTI Ratio',      source: 'WOE-transformed — อัตราส่วนหนี้ต่อรายได้ (existing_monthly_debt / monthly_income)', threshold: '0.10', bins: ['0.264', '0.36', '0.47', '0.606'] },
  ];
  const [csiFeatures, setCsiFeatures] = useState<CsiFeatureItem[]>(defaultCsiFeatures);
  const csiFeatureMap = Object.fromEntries(csiFeatures.map(f => [f.key, f]));
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isAppending, setIsAppending] = useState(false);

  // Monitor state
  const [fileName, setFileName] = useState('');
  const [rowCount, setRowCount] = useState(0);
  const [uploadedMetrics, setUploadedMetrics] = useState<any>(null);
  const [uploadedCsiDetail, setUploadedCsiDetail] = useState<Record<string, any> | null>(null);
  const [uploadedRiskGrades, setUploadedRiskGrades] = useState<any[]>([]);
  const [previewCustomers, setPreviewCustomers] = useState<any[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [selectedLog, setSelectedLog] = useState<MonitorLog | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── localStorage keys ──
  const LS_HISTORY = 'ascore_psi_history';
  const LS_LOGS    = 'ascore_monitor_logs';

  // ── Load data (stateless: config from API, history/logs from localStorage) ──
  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      const psiRes = await fetch('/api/get-latest-psi', { cache: 'no-store' });
      const psiData = await psiRes.json();

      // History from localStorage
      try {
        const storedHistory = localStorage.getItem(LS_HISTORY);
        if (storedHistory) setHistory(JSON.parse(storedHistory));
      } catch {}

      // Monitor logs from localStorage
      try {
        const storedLogs = localStorage.getItem(LS_LOGS);
        if (storedLogs) setMonitorLogs(JSON.parse(storedLogs).reverse());
      } catch {}

      if (psiData.config) {
        setConfig(psiData.config);
        const activeId = psiData.config.activeModelId;
        const model = psiData.config.models[activeId];
        if (model?.thresholds) {
          const t = model.thresholds;
          setThresholds({
            psi_warning:  String(t.psi_warning  ?? 0.10),
            psi_critical: String(t.psi_critical ?? 0.25),
            gini_min:     String(t.gini_min     ?? 0.10),
            auc_min:      String(t.auc_min      ?? 0.55),
            ks_min:       String(t.ks_min       ?? 0.10),
          });
          if (t.csi_features) {
            const loaded: CsiFeatureItem[] = [];
            for (const [feat, cfg] of Object.entries(t.csi_features as Record<string, any>)) {
              loaded.push({
                key: feat, label: cfg.label || feat, source: cfg.source || '',
                threshold: String(cfg.threshold ?? 0.10),
                bins: Array.isArray(cfg.bins) ? cfg.bins.map(String) : [],
              });
            }
            if (loaded.length > 0) setCsiFeatures(loaded);
          }
        }
      }
    } catch (err) {
      console.error('loadData error:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Simulate metrics ──
  const runSimulation = useCallback(async () => {
    setIsSimulating(true);
    try {
      const res = await fetch(`/api/risk-score?drift=${driftLevel}`, { cache: 'no-store' });
      const data = await res.json();
      setLiveMetrics(data);
    } catch (err) { console.error(err); }
    finally { setIsSimulating(false); }
  }, [driftLevel]);

  useEffect(() => { runSimulation(); }, [runSimulation]);

  // ── Save config ──
  const saveConfig = async () => {
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
      await fetch('/api/save-model-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thresholds: {
            psi_warning: parseFloat(thresholds.psi_warning),
            psi_critical: parseFloat(thresholds.psi_critical),
            gini_min: parseFloat(thresholds.gini_min),
            auc_min: parseFloat(thresholds.auc_min),
            ks_min: parseFloat(thresholds.ks_min),
            csi_features: csiPayload,
          },
        }),
      });
      alert('✅ บันทึก Feature Config เรียบร้อยแล้ว');
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

  // ── Append to history (localStorage) ──
  const appendToHistory = async () => {
    setIsAppending(true);
    try {
      const res = await fetch('/api/risk-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drift: driftLevel, source: 'simulation' }),
      });
      const newEntry = await res.json();
      setHistory(prev => {
        const updated = [...prev, newEntry];
        try { localStorage.setItem(LS_HISTORY, JSON.stringify(updated)); } catch {}
        return updated;
      });
    } catch (err) { console.error(err); }
    finally { setIsAppending(false); }
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
    setIsUploading(true);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = parseCSV(text);
        if (parsed.length === 0) throw new Error('ไฟล์ CSV ว่างเปล่า หรือ header ไม่ถูกต้อง');
        setRowCount(parsed.length);

        const res = await fetch('/api/monitor-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customers: parsed, fileName: file.name }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || err.detail || 'เกิดข้อผิดพลาดในการประมวลผล');
        }
        const data = await res.json();
        setUploadedMetrics(data);
        setUploadedCsiDetail(data.csiDetail || null);
        setUploadedRiskGrades(data.riskGradeDist || []);
        setPreviewCustomers(data.scoredCustomers || []);

        // Persist log entry to localStorage
        if (data.logEntry) {
          try {
            const stored = localStorage.getItem(LS_LOGS);
            const logs: any[] = stored ? JSON.parse(stored) : [];
            logs.push(data.logEntry);
            localStorage.setItem(LS_LOGS, JSON.stringify(logs));
            setMonitorLogs([...logs].reverse());
          } catch {}
        }
        // Persist PSI history entry to localStorage
        try {
          const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          const now = new Date();
          const histEntry = {
            month: months[now.getMonth()],
            timestamp: now.toISOString(),
            source: 'upload',
            fileName: file.name,
            rowCount: parsed.length,
            psi: data.psi, csi: data.csi,
            auc: data.auc, gini: data.gini, ks: data.ks, lift: data.lift,
            status: data.status,
          };
          const storedH = localStorage.getItem(LS_HISTORY);
          const histArr: any[] = storedH ? JSON.parse(storedH) : [];
          histArr.push(histEntry);
          localStorage.setItem(LS_HISTORY, JSON.stringify(histArr));
          setHistory(histArr);
        } catch {}
      } catch (err: any) {
        setUploadError(err.message || 'เกิดข้อผิดพลาด');
      } finally {
        setIsUploading(false);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const model = config ? config.models[config.activeModelId] : null;
  const scorecard = model?.scoring?.scorecard || {};
  // featLabels: generated dynamically from csiFeatures (so scorecard table uses correct labels)
  const featLabels: Record<string, string> = Object.fromEntries(
    csiFeatures.map(f => [f.key, f.label || f.key])
  );


  const psiWarningNum = parseFloat(thresholds.psi_warning) || 0.10;
  const psiCriticalNum = parseFloat(thresholds.psi_critical) || 0.25;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-sm font-bold">A</div>
            <div>
              <p className="text-sm font-bold text-slate-100">A-Score Monitor</p>
              <p className="text-[10px] text-slate-500">Personal Loan — {model?.name || 'Loading...'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 bg-slate-800/60 rounded-xl p-1">
            {(['sandbox', 'monitor'] as ActiveTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${activeTab === tab ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {tab === 'sandbox' ? '🔬 Model Sandbox' : '📊 Monitoring'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
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
             TAB: SANDBOX
          ════════════════════════════════════════════════════════ */
          activeTab === 'sandbox' ? (
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
                      ['Model ID', model?.id],
                      ['Type', 'Logistic Regression + WOE'],
                      ['Features', model?.scoring?.features?.join(', ')],
                      ['Base Points', String(model?.scoring?.base_points ?? '—')],
                      ['Dev Sample', `${model?.baseline?.sample_size ?? '—'} obs`],
                      ['Bad Rate', `${((model?.baseline?.bad_rate ?? 0) * 100).toFixed(1)}%`],
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
                  <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider bg-emerald-500/10 px-2 py-0.5 rounded">📈 B. Baseline Performance (Test)</span>
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    {[
                      { k: 'AUC', v: model?.baseline?.performance?.test?.auc },
                      { k: 'Gini', v: model?.baseline?.performance?.test?.gini },
                      { k: 'KS', v: model?.baseline?.performance?.test?.ks },
                    ].map(({ k, v }) => (
                      <div key={k} className="bg-slate-950/50 rounded-xl p-2 text-center">
                        <p className="text-[9px] text-slate-500 uppercase mb-1">{k}</p>
                        <p className="text-sm font-bold font-mono text-emerald-400">{v?.toFixed(3) ?? '—'}</p>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-slate-800 pt-2">
                    <p className="text-[9px] text-slate-500 mb-1">Train Performance</p>
                    <div className="flex gap-3 text-[10px] font-mono">
                      <span className="text-slate-400">AUC: <span className="text-blue-400">{model?.baseline?.performance?.train?.auc?.toFixed(3)}</span></span>
                      <span className="text-slate-400">Gini: <span className="text-blue-400">{model?.baseline?.performance?.train?.gini?.toFixed(3)}</span></span>
                      <span className="text-slate-400">KS: <span className="text-blue-400">{model?.baseline?.performance?.train?.ks?.toFixed(3)}</span></span>
                    </div>
                  </div>
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
                                  placeholder="e.g. dti_ratio"
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
                {/* Drift Simulator */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-bold text-slate-200">🎚️ Drift Simulator</h2>
                    <button onClick={appendToHistory} disabled={isAppending}
                      className="px-4 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg text-xs font-bold transition hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50">
                      {isAppending ? '...' : '+ Add to History'}
                    </button>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center gap-4">
                      <span className="text-[11px] text-slate-400 w-24">Drift Level:</span>
                      <input type="range" min="0" max="1" step="0.01" value={driftLevel}
                        onChange={e => setDriftLevel(parseFloat(e.target.value))}
                        className="flex-1 accent-indigo-500" />
                      <span className="text-sm font-mono text-indigo-400 w-10">{driftLevel.toFixed(2)}</span>
                    </div>
                    <p className="text-[10px] text-slate-500">
                      Drift 0 = Baseline population | 0.5 = Moderate shift (income↓ DTI↑) | 1.0 = Severe drift
                    </p>
                  </div>

                  {/* Live Metrics */}
                  {isSimulating ? (
                    <div className="mt-4 text-center text-slate-500 text-xs animate-pulse">Simulating...</div>
                  ) : liveMetrics && (
                    <div className="mt-4 space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <MetricCard label="PSI (Score)" value={liveMetrics.psi} color={liveMetrics.psi < psiWarningNum ? 'text-emerald-400' : liveMetrics.psi < psiCriticalNum ? 'text-amber-400' : 'text-rose-400'} />
                        <MetricCard label="AUC" value={liveMetrics.auc} color="text-blue-400" />
                        <MetricCard label="Gini" value={liveMetrics.gini} color="text-purple-400" />
                        <MetricCard label="KS" value={liveMetrics.ks} color="text-cyan-400" />
                      </div>
                      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(3, Object.keys(liveMetrics.csi || {}).length)}, 1fr)` }}>
                        {Object.entries(liveMetrics.csi || {}).map(([feat, val]) => {
                          const cfg = csiFeatureMap[feat];
                          const limit = parseFloat(cfg?.threshold || '0.10') || 0.10;
                          return (
                            <MetricCard key={feat} label={`CSI — ${cfg?.label || feat}`} value={val as number}
                              color={(val as number) > limit ? 'text-rose-400' : 'text-emerald-400'}
                              small />
                          );
                        })}
                      </div>
                      <div className="flex justify-end">
                        <Badge status={liveMetrics.status} />
                      </div>
                    </div>
                  )}
                </div>

                {/* Scorecard Table — with IV per feature */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                  <h2 className="text-sm font-bold text-slate-200 mb-4">📋 Scorecard Reference</h2>
                  <div className="space-y-5">
                    {(['monthly_income', 'loan_amount', 'dti_ratio'] as const).map(feat => {
                      const sc = scorecard[feat];
                      const ivEntry = (model as any)?.ivSummary?.[feat];
                      if (!sc) return null;
                      // IV strength colour
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
                            <p className="text-[11px] font-bold text-slate-300">{featLabels[feat]}</p>
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
                </div>

                {/* PSI / CSI Summary Panel */}
                {liveMetrics && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-sm font-bold text-slate-200">📉 PSI / CSI — Drift Summary</h2>
                      <Badge status={liveMetrics.status} />
                    </div>

                    {/* PSI row */}
                    <div className="mb-4">
                      <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-2">Population Stability Index (Score Distribution)</p>
                      <div className="flex items-center gap-3">
                        <span className={`text-2xl font-bold font-mono ${
                          liveMetrics.psi < psiWarningNum ? 'text-emerald-400'
                          : liveMetrics.psi < psiCriticalNum ? 'text-amber-400'
                          : 'text-rose-400'
                        }`}>{liveMetrics.psi?.toFixed(4)}</span>
                        <div className="flex-1">
                          <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${
                                liveMetrics.psi < psiWarningNum ? 'bg-emerald-500'
                                : liveMetrics.psi < psiCriticalNum ? 'bg-amber-500'
                                : 'bg-rose-500'
                              }`}
                              style={{ width: `${Math.min(liveMetrics.psi / psiCriticalNum * 100, 100)}%` }}
                            />
                          </div>
                          <div className="flex justify-between text-[9px] text-slate-600 mt-1">
                            <span>0</span>
                            <span className="text-amber-600">Warn {psiWarningNum}</span>
                            <span className="text-rose-600">Critical {psiCriticalNum}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* CSI per feature */}
                    <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-2">Characteristic Stability Index (per Feature)</p>
                    <div className="space-y-2">
                      {Object.entries(liveMetrics.csi || {}).map(([feat, val]) => {
                        const cfg = csiFeatureMap[feat];
                        const limit = parseFloat(cfg?.threshold || '0.10') || 0.10;
                        const csiVal = val as number;
                        const pct = Math.min(csiVal / limit * 100, 100);
                        const barColor = csiVal > limit ? 'bg-rose-500' : 'bg-indigo-500';
                        const textColor = csiVal > limit ? 'text-rose-400' : 'text-emerald-400';
                        return (
                          <div key={feat}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] text-slate-400">{cfg?.label || feat}</span>
                              <div className="flex items-center gap-2">
                                <span className={`text-[10px] font-mono font-bold ${textColor}`}>{csiVal.toFixed(4)}</span>
                                <span className="text-[9px] text-slate-600">limit {limit.toFixed(2)}</span>
                              </div>
                            </div>
                            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

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
                    {(['monthly_income', 'loan_amount', 'dti_ratio'] as const).map(feat => {
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

                {/* History Chart */}
                {history.length > 0 && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                    <h2 className="text-sm font-bold text-slate-200 mb-4">📈 PSI Trend (Simulation History)</h2>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={history}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} />
                        <YAxis domain={[0, 0.4]} tick={{ fontSize: 11, fill: '#64748b' }} />
                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 11 }} />
                        <ReferenceLine y={psiWarningNum} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: 'Warning', fill: '#f59e0b', fontSize: 10 }} />
                        <ReferenceLine y={psiCriticalNum} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'Critical', fill: '#ef4444', fontSize: 10 }} />
                        <Line type="monotone" dataKey="psi" stroke="#6366f1" strokeWidth={2} dot={{ fill: '#6366f1', r: 4 }} name="PSI" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
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
                  <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider mb-3">Active Model Baseline</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      <span className="text-xs font-bold text-slate-200">{model?.name}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-2">
                      {[
                        { k: 'AUC', v: model?.baseline?.performance?.test?.auc?.toFixed(3) },
                        { k: 'Gini', v: model?.baseline?.performance?.test?.gini?.toFixed(3) },
                        { k: 'KS', v: model?.baseline?.performance?.test?.ks?.toFixed(3) },
                      ].map(({ k, v }) => (
                        <div key={k} className="bg-slate-950/50 rounded-lg p-2 text-center">
                          <p className="text-[9px] text-slate-500">{k}</p>
                          <p className="text-xs font-bold font-mono text-emerald-400">{v ?? '—'}</p>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2">
                      Dev: {model?.baseline?.sample_size} obs | Bad rate: {((model?.baseline?.bad_rate ?? 0) * 100).toFixed(1)}%
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
                          ต้องการคอลัมน์: {csiFeatures.map(f => f.key || '?').join(', ')}, (default_flag ถ้ามี)
                        </p>
                      </div>
                    )}
                  </div>
                  <input type="file" accept=".csv" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                  {uploadError && <p className="text-xs text-rose-400 mt-2">❌ {uploadError}</p>}
                </div>
              </div>

              {/* Results after upload */}
              {uploadedMetrics && (
                <div className="space-y-5">
                  {/* KPI Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    {[
                      { label: 'PSI', value: uploadedMetrics.psi, color: uploadedMetrics.psi < psiWarningNum ? 'text-emerald-400' : uploadedMetrics.psi < psiCriticalNum ? 'text-amber-400' : 'text-rose-400' },
                      { label: 'AUC', value: uploadedMetrics.auc, color: uploadedMetrics.auc !== null && uploadedMetrics.auc >= (parseFloat(thresholds.auc_min) || 0.55) ? 'text-emerald-400' : 'text-rose-400' },
                      { label: 'Gini', value: uploadedMetrics.gini, color: uploadedMetrics.gini !== null && uploadedMetrics.gini >= (parseFloat(thresholds.gini_min) || 0.10) ? 'text-emerald-400' : 'text-rose-400' },
                      { label: 'KS', value: uploadedMetrics.ks, color: uploadedMetrics.ks !== null && uploadedMetrics.ks >= (parseFloat(thresholds.ks_min) || 0.10) ? 'text-emerald-400' : 'text-rose-400' },
                      { label: 'Lift (Top10%)', value: uploadedMetrics.lift, color: 'text-purple-400' },
                      { label: 'N Customers', value: rowCount.toLocaleString(), color: 'text-slate-200' },
                    ].map(({ label, value, color }) => (
                      <MetricCard key={label} label={label} value={typeof value === 'number' ? value : null} color={color} />
                    ))}
                  </div>

                  {/* Comparison Table */}
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
                    <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
                      <h3 className="text-sm font-bold text-slate-200">📊 Comparison: New Data vs Baseline</h3>
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
                            <td className="py-3 px-4 text-center"><Badge status={uploadedMetrics.status} /></td>
                          </tr>
                          {/* AUC */}
                          {[
                            { k: 'AUC', val: uploadedMetrics.auc, base: model?.baseline?.performance?.test?.auc, thres: parseFloat(thresholds.auc_min) || 0.55, dir: 'higher' },
                            { k: 'Gini', val: uploadedMetrics.gini, base: model?.baseline?.performance?.test?.gini, thres: parseFloat(thresholds.gini_min) || 0.10, dir: 'higher' },
                            { k: 'KS', val: uploadedMetrics.ks, base: model?.baseline?.performance?.test?.ks, thres: parseFloat(thresholds.ks_min) || 0.10, dir: 'higher' },
                          ].map(({ k, val, base, thres, dir }) => {
                            if (val === null) return (
                              <tr key={k} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                                <td className="py-3 px-4 font-semibold text-slate-300">{k} <span className="text-slate-500 font-normal">(ต้องการ default_flag)</span></td>
                                <td colSpan={4} className="py-3 px-4 text-center text-slate-600 italic text-xs">ไม่มีข้อมูล default_flag ในไฟล์</td>
                              </tr>
                            );
                            const pass = val >= thres;
                            const diff = val - (base ?? thres);
                            return (
                              <tr key={k} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                                <td className="py-3 px-4 font-semibold text-slate-300">{k} <span className="text-slate-500 font-normal">(สูงกว่า = ดี)</span></td>
                                <td className="py-3 px-4 text-center font-mono text-emerald-400">{base?.toFixed(3) ?? '—'}</td>
                                <td className="py-3 px-4 text-center font-mono font-bold text-slate-200">{val.toFixed(4)}</td>
                                <td className={`py-3 px-4 text-center font-mono font-semibold ${diff >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(4)}</td>
                                <td className="py-3 px-4 text-center"><Badge status={pass ? 'PASS' : 'FAIL'} /></td>
                              </tr>
                            );
                          })}
                          {/* CSI per feature — dynamic from csiFeatures config */}
                          {csiFeatures.map(featCfg => {
                            const feat = featCfg.key;
                            const csiVal = uploadedMetrics.csi?.[feat];
                            if (csiVal === undefined) return null;
                            const limit = parseFloat(featCfg.threshold) || 0.10;
                            const pass = csiVal < limit;
                            const diff = csiVal - limit;
                            const detail = uploadedCsiDetail?.[feat];
                            const displayName = featCfg.label || feat;
                            const sourceText = featCfg.source;
                            return (
                              <>
                                <tr key={feat} className="hover:bg-slate-800/20">
                                  <td className="py-3 px-4">
                                    <p className="font-semibold text-slate-300">CSI — {displayName} <span className="text-slate-500 font-normal">(ต่ำกว่า = ดี)</span></p>
                                    {sourceText && <p className="text-[9px] text-slate-600 mt-0.5 font-mono">{sourceText}</p>}
                                  </td>
                                  <td className="py-3 px-4 text-center font-mono text-rose-400">&lt; {limit.toFixed(3)}</td>
                                  <td className="py-3 px-4 text-center font-mono font-bold text-slate-200">{csiVal.toFixed(4)}</td>
                                  <td className={`py-3 px-4 text-center font-mono font-semibold ${diff <= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(4)}</td>
                                  <td className="py-3 px-4 text-center"><Badge status={pass ? 'PASS' : 'FAIL'} /></td>
                                </tr>
                                {detail?.bin_distribution && (
                                  <tr key={`${feat}-bins`} className="bg-slate-950/30">
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
                              </>
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
                              {['#', 'Customer', 'Monthly Income', 'Loan Amount', 'DTI Ratio', 'A-Score', 'PD', 'Default'].map(h => (
                                <th key={h} className="text-left pb-2 px-2 text-slate-500 font-medium">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {previewCustomers.slice(0, 20).map((c, i) => (
                              <tr key={i} className="border-b border-slate-800/30 hover:bg-slate-800/20">
                                <td className="py-1.5 px-2 text-slate-500">{c.id}</td>
                                <td className="py-1.5 px-2 text-slate-300">{c.customer_id}</td>
                                <td className="py-1.5 px-2 font-mono text-slate-300">{c.monthly_income?.toLocaleString()}</td>
                                <td className="py-1.5 px-2 font-mono text-slate-300">{c.loan_amount?.toLocaleString()}</td>
                                <td className="py-1.5 px-2 font-mono text-slate-300">{c.dti_ratio?.toFixed(3)}</td>
                                <td className="py-1.5 px-2 font-mono font-bold text-indigo-400">{c.aScore}</td>
                                <td className="py-1.5 px-2 font-mono text-rose-400">{(c.pd * 100).toFixed(2)}%</td>
                                <td className="py-1.5 px-2">{c.defaultLabel === 1 ? <span className="text-rose-400 font-bold">BAD</span> : <span className="text-emerald-400">good</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ── คำแนะนำการใช้แบบจำลอง ── */}
                  {uploadedMetrics && (() => {
                    const psi      = uploadedMetrics.psi;
                    const gini     = uploadedMetrics.gini;
                    const auc      = uploadedMetrics.auc;
                    const psiWarn  = parseFloat(thresholds.psi_warning)  || 0.10;
                    const psiCrit  = parseFloat(thresholds.psi_critical) || 0.25;
                    const giniMin  = parseFloat(thresholds.gini_min)     || 0.10;
                    const aucMin   = parseFloat(thresholds.auc_min)      || 0.55;
                    const baseGini = model?.baseline?.performance?.test?.gini ?? null;
                    const baseAuc  = model?.baseline?.performance?.test?.auc  ?? null;

                    // Determine recommendation level
                    const psiOk   = psi < psiWarn;
                    const psiWarn_ = psi >= psiWarn && psi < psiCrit;
                    const psiCrit_ = psi >= psiCrit;
                    const perfOk  = (auc === null || auc >= aucMin) && (gini === null || gini >= giniMin);
                    const perfDrop = baseGini && gini !== null && (baseGini - gini) > 0.05;

                    let recLevel: 'ok' | 'cutoff' | 'monitor' | 'retrain' = 'ok';
                    let recTitle  = '';
                    let recDetail = '';
                    let recColor  = '';

                    if (psiCrit_ || (perfDrop && !perfOk)) {
                      recLevel  = 'retrain';
                      recTitle  = '🔴 แนะนำ: ทบทวน/พัฒนาแบบจำลองใหม่';
                      recColor  = 'border-rose-500/40 bg-rose-500/5';
                      recDetail = `PSI = ${psi.toFixed(3)} สูงเกินเกณฑ์ Critical (${psiCrit}) หรือ Gini ลดลงอย่างมีนัยสำคัญ `;
                      recDetail += `บ่งชี้ว่า Distribution ของ Population เปลี่ยนแปลงอย่างรุนแรง หรือความสามารถจำแนกดี/ไม่ดีลดลงเกิน Threshold `;
                      recDetail += `แนะนำ: (1) ตรวจสอบ Population Shift จาก CSI ต่อตัวแปร (2) Retrain ด้วยข้อมูลที่เป็น Out-of-Time `;
                      recDetail += `(3) พิจารณา Champion-Challenger Testing`;
                    } else if (psiWarn_) {
                      recLevel  = 'cutoff';
                      recTitle  = '🟡 แนะนำ: ปรับ Cut-off คะแนน หรือ Monitor เพิ่มเติม';
                      recColor  = 'border-amber-500/40 bg-amber-500/5';
                      recDetail = `PSI = ${psi.toFixed(3)} อยู่ในระดับ Warning (${psiWarn}–${psiCrit}) บ่งชี้ว่า Distribution เปลี่ยนแปลงบ้าง แต่ยังไม่รุนแรง `;
                      recDetail += `แนะนำ: (1) ตรวจ CSI ต่อตัวแปร ว่าตัวแปรใดเปลี่ยนมากที่สุด `;
                      recDetail += `(2) Back-test Cut-off ปัจจุบัน vs Approval Rate/Bad Rate `;
                      recDetail += `(3) พิจารณาขยาย Cut-off 5–10 points หากต้องการลด Bad Rate `;
                      recDetail += `(4) วาง monitoring cycle ถี่ขึ้นเป็นรายเดือน`;
                    } else {
                      recLevel  = 'ok';
                      recTitle  = '🟢 แบบจำลองยังใช้งานได้ — ติดตามต่อเนื่อง';
                      recColor  = 'border-emerald-500/40 bg-emerald-500/5';
                      recDetail = `PSI = ${psi.toFixed(3)} อยู่ในเกณฑ์ปกติ (< ${psiWarn}) Distribution ของ Population ไม่เปลี่ยนแปลงอย่างมีนัยสำคัญ `;
                      if (auc !== null) recDetail += `AUC = ${auc.toFixed(3)} ${auc >= aucMin ? 'ผ่านเกณฑ์ขั้นต่ำ' : 'ใกล้เกณฑ์ขั้นต่ำ — ควรติดตาม'}. `;
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
                        <div className="mt-4 grid grid-cols-3 gap-3">
                          {[
                            { label: 'PSI', val: psi.toFixed(4), color: psiCrit_ ? 'text-rose-400' : psiWarn_ ? 'text-amber-400' : 'text-emerald-400', note: psiCrit_ ? 'Critical' : psiWarn_ ? 'Warning' : 'Stable' },
                            { label: 'AUC', val: auc !== null ? auc.toFixed(4) : '—', color: auc !== null && auc >= aucMin ? 'text-emerald-400' : 'text-rose-400', note: auc !== null ? `Min ${aucMin}` : 'ไม่มี label' },
                            { label: 'Gini', val: gini !== null ? gini.toFixed(4) : '—', color: gini !== null && gini >= giniMin ? 'text-emerald-400' : 'text-rose-400', note: gini !== null ? `Min ${giniMin}` : 'ไม่มี label' },
                          ].map(({ label, val, color, note }) => (
                            <div key={label} className="bg-slate-950/40 rounded-xl p-3 text-center">
                              <p className="text-[9px] text-slate-500 uppercase mb-1">{label}</p>
                              <p className={`text-lg font-bold font-mono ${color}`}>{val}</p>
                              <p className="text-[9px] text-slate-600 mt-0.5">{note}</p>
                            </div>
                          ))}
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
                <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-200">🗂️ Monitoring Log</h3>
                  <span className="text-[10px] text-slate-500">{monitorLogs.length} sessions</span>
                </div>
                {monitorLogs.length === 0 ? (
                  <div className="text-center text-slate-600 py-10 text-sm">ยังไม่มี log — อัปโหลด CSV เพื่อเริ่ม Monitor</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 bg-slate-950/30">
                          {/* Headers — dynamic CSI columns */}
                          {['วันที่', 'ไฟล์', 'N Rows', 'PSI', 'AUC', 'Gini', 'KS',
                            ...csiFeatures.map(f => `CSI — ${f.label || f.key}`),
                            'Verdict'
                          ].map(h => (
                            <th key={h} className="text-left py-2.5 px-3 text-slate-500 font-medium whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {monitorLogs.map(log => {
                          const psi = log.results.psi;
                          const psiColor = psi < psiWarningNum ? 'text-emerald-400' : psi < psiCriticalNum ? 'text-amber-400' : 'text-rose-400';
                          return (
                            <tr key={log.logId} className="border-b border-slate-800/40 hover:bg-slate-800/20 cursor-pointer"
                              onClick={() => setSelectedLog(selectedLog?.logId === log.logId ? null : log)}>
                              <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">{new Date(log.uploadedAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</td>
                              <td className="py-2.5 px-3 text-slate-300 max-w-32 truncate">{log.fileName}</td>
                              <td className="py-2.5 px-3 font-mono text-slate-400">{log.rowCount.toLocaleString()}</td>
                              <td className={`py-2.5 px-3 font-mono font-bold ${psiColor}`}>{psi.toFixed(4)}</td>
                              <td className="py-2.5 px-3 font-mono text-slate-300">{log.results.auc?.toFixed(3) ?? '—'}</td>
                              <td className="py-2.5 px-3 font-mono text-slate-300">{log.results.gini?.toFixed(3) ?? '—'}</td>
                              <td className="py-2.5 px-3 font-mono text-slate-300">{log.results.ks?.toFixed(3) ?? '—'}</td>
                          {/* CSI columns — dynamic from csiFeatures */}
                          {csiFeatures.map(featCfg => {
                            const csiVal = log.results.csi?.[featCfg.key];
                            const limit = parseFloat(featCfg.threshold) || 0.10;
                            const ok = csiVal !== undefined && csiVal < limit;
                            return (
                              <td key={featCfg.key} className={`py-2.5 px-3 font-mono ${ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {csiVal !== undefined ? csiVal.toFixed(4) : '—'}
                              </td>
                            );
                          })}
                              <td className="py-2.5 px-3"><Badge status={log.verdict} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* PSI Trend from log */}
              {monitorLogs.length > 1 && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
                  <h3 className="text-sm font-bold text-slate-200 mb-4">📈 PSI Trend (from Upload History)</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={[...monitorLogs].reverse().map(l => ({
                      date: new Date(l.uploadedAt).toLocaleDateString('th-TH', { day: '2-digit', month: 'short' }),
                      PSI: parseFloat(l.results.psi.toFixed(4)),
                      'CSI Income': parseFloat((l.results.csi?.monthly_income ?? 0).toFixed(4)),
                      'CSI Loan': parseFloat((l.results.csi?.loan_amount ?? 0).toFixed(4)),
                      'CSI DTI': parseFloat((l.results.csi?.dti_ratio ?? 0).toFixed(4)),
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