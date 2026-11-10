'use client';
/**
 * BaselineRegistryPanel (Step 10c.C)
 *
 * Tab: 🗂 Baseline Registry
 *   - Overview of models and baseline versions
 *   - Status lifecycle badges: DRAFT -> VALIDATED -> ACTIVE -> ARCHIVED
 *   - Action buttons: Validate, Activate, Archive, Export JSON, Export Scorecard CSV
 *   - Status history audit timeline
 *   - Launch Onboarding Wizard (+ New Model / + New Version)
 */
import { useCallback, useEffect, useState } from 'react';
import type { BaselineMode, BaselineStatus, BaselineVersion } from '@/lib/types';
import BaselineOnboardingWizard from './BaselineOnboardingWizard';

interface ModelRegistryEntry {
  id: string;
  modelId: string;
  name: string;
  description: string;
  mode: BaselineMode;
  activeVersion?: string;
  versions?: BaselineVersion[];
}

interface BaselineRegistryPanelProps {
  selectedModelId: string;
  onSelectModel: (modelId: string) => void;
  onModelActivated?: (modelId: string, version: string, openMonitoring?: boolean) => void;
}

const STATUS_STYLE: Record<BaselineStatus, string> = {
  ACTIVE: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10',
  VALIDATED: 'border-blue-500/40 text-blue-400 bg-blue-500/10',
  DRAFT: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  ARCHIVED: 'border-slate-700 text-slate-500 bg-slate-900',
};

export default function BaselineRegistryPanel({
  selectedModelId,
  onSelectModel,
  onModelActivated,
}: BaselineRegistryPanelProps) {
  const [models, setModels] = useState<ModelRegistryEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [defaultModelId, setDefaultModelId] = useState<string>('');
  const [isSettingDefault, setIsSettingDefault] = useState<boolean>(false);

  // Selected model's versions
  const [activeModel, setActiveModel] = useState<ModelRegistryEntry | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<BaselineVersion | null>(null);

  // Wizard modal state
  const [showWizard, setShowWizard] = useState<boolean>(false);
  const [wizardInitialData, setWizardInitialData] = useState<any>(undefined);

  // Load models and default
  const loadRegistry = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [modelsRes, defRes] = await Promise.all([
        fetch('/api/registry/models', { cache: 'no-store' }),
        fetch('/api/registry/default', { cache: 'no-store' }),
      ]);
      const modelsData = await modelsRes.json();
      const defData = await defRes.json();

      if (modelsRes.ok && Array.isArray(modelsData.models)) {
        setModels(modelsData.models);
        // Find current selected model
        const found = modelsData.models.find((m: any) => m.modelId === selectedModelId) || modelsData.models[0];
        if (found) {
          setActiveModel(found);
          const activeVer = found.versions?.find((v: BaselineVersion) => v.status === 'ACTIVE') || found.versions?.[0];
          setSelectedVersion(activeVer || null);
        }
      }
      if (defRes.ok && defData.defaultModelId) {
        setDefaultModelId(defData.defaultModelId);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedModelId]);

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  // Set default model
  const handleSetDefault = async (mId: string) => {
    setIsSettingDefault(true);
    try {
      const res = await fetch('/api/registry/default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: mId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ตั้งค่าเริ่มต้นไม่สำเร็จ');
      setDefaultModelId(data.defaultModelId);
      alert(`✅ ตั้งโมเดล "${mId}" เป็นค่าเริ่มต้นเรียบร้อย`);
    } catch (err: unknown) {
      alert(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSettingDefault(false);
    }
  };

  // Status transitions
  const handleTransition = async (action: 'validate' | 'activate' | 'archive', ver: BaselineVersion) => {
    if (!confirm(`ยืนยันการเปลี่ยนสถานะ (${action.toUpperCase()}) สำหรับเวอร์ชัน ${ver.version}?`)) return;

    try {
      const res = await fetch(`/api/registry/models/${ver.modelId}/versions/${ver.version}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'web-user' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `ดำเนินการ ${action} ไม่สำเร็จ`);

      await loadRegistry();
      if (action === 'activate') {
        onSelectModel(ver.modelId);
        onModelActivated?.(ver.modelId, ver.version, false);
      }
    } catch (err: unknown) {
      alert(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Export version JSON
  const handleExportJson = (ver: BaselineVersion) => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(ver, null, 2));
    const dl = document.createElement('a');
    dl.setAttribute('href', dataStr);
    dl.setAttribute('download', `${ver.modelId}_v${ver.version}_baseline.json`);
    dl.click();
  };

  // Export Scorecard CSV
  const handleExportScorecardCsv = (ver: BaselineVersion) => {
    window.open(`/api/registry/models/${ver.modelId}/versions/${ver.version}/scorecard.csv`, '_blank');
  };

  // Launch wizard for brand new model
  const openNewModelWizard = () => {
    setWizardInitialData(undefined);
    setShowWizard(true);
  };

  // Launch wizard to create new baseline version of active model
  const openNewVersionWizard = () => {
    if (!activeModel) return;
    const curVer = selectedVersion?.version || '1.0.0';
    const parts = curVer.split('.').map(n => parseInt(n, 10) || 0);
    const bumped = `${parts[0] || 1}.${parts[1] || 0}.${(parts[2] || 0) + 1}`;

    setWizardInitialData({
      modelId: activeModel.modelId,
      name: activeModel.name,
      description: activeModel.description,
      mode: activeModel.mode,
      version: bumped,
      scoreDirection: selectedVersion?.scoreDirection ?? 'higher_is_safer',
      featureRegistry: selectedVersion?.featureRegistry,
      scoring: selectedVersion?.scoring,
    });
    setShowWizard(true);
  };

  const handleWizardSuccess = (mId: string, ver: string, openMonitoring = false) => {
    setShowWizard(false);
    onSelectModel(mId);
    loadRegistry();
    if (onModelActivated) {
      onModelActivated(mId, ver, openMonitoring);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
        <div>
          <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <span>🗂</span> Baseline Model Registry
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            ศูนย์รวมและติดตามเวอร์ชันแบบจำลอง (MLOps Model Registry & Baseline Store)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openNewModelWizard}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-indigo-500/20 transition flex items-center gap-1.5"
          >
            <span>+</span> ลงทะเบียนโมเดลใหม่
          </button>
          {activeModel && (
            <button
              onClick={openNewVersionWizard}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold rounded-xl text-xs transition flex items-center gap-1.5"
            >
              <span>+</span> สร้าง Baseline เวอร์ชันใหม่ของโมเดลนี้
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
          ❌ {error}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-slate-400 text-xs animate-pulse">
          กำลังโหลดรายการแบบจำลองใน Registry...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Model List */}
          <div className="lg:col-span-1 space-y-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1">
              แบบจำลองในระบบ ({models.length})
            </h3>
            <div className="space-y-2">
              {models.map(m => {
                const isSelected = m.modelId === activeModel?.modelId;
                const isDef = m.modelId === defaultModelId;
                const activeVer = m.versions?.find(v => v.status === 'ACTIVE');

                return (
                  <div
                    key={m.modelId}
                    onClick={() => {
                      setActiveModel(m);
                      onSelectModel(m.modelId);
                      const topVer = m.versions?.find(v => v.status === 'ACTIVE') || m.versions?.[0];
                      setSelectedVersion(topVer || null);
                    }}
                    className={`p-3.5 rounded-xl border cursor-pointer transition ${
                      isSelected
                        ? 'border-indigo-500/60 bg-indigo-500/10 shadow-lg shadow-indigo-500/10'
                        : 'border-slate-800 hover:border-slate-700 bg-slate-900/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-bold text-slate-100">{m.modelId}</span>
                          {isDef && (
                            <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              DEFAULT
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-300 mt-0.5">{m.name}</p>
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-slate-700 text-slate-400">
                        {m.mode}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-500 pt-2 border-t border-slate-800/60">
                      <span>{m.versions?.length ?? 0} เวอร์ชัน</span>
                      {activeVer && (
                        <span className="text-emerald-400 font-mono">
                          v{activeVer.version} · ACTIVE
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Selected Model Detail & Version List */}
          <div className="lg:col-span-2 space-y-5">
            {activeModel ? (
              <>
                {/* Model Header Card */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-slate-100">{activeModel.name}</h3>
                        <span className="text-xs font-mono px-2 py-0.5 rounded border border-indigo-500/40 text-indigo-300 bg-indigo-500/10">
                          {activeModel.modelId}
                        </span>
                        <span className="text-xs font-mono px-2 py-0.5 rounded border border-slate-700 text-slate-400">
                          {activeModel.mode}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{activeModel.description || 'ไม่มีคำอธิบาย'}</p>
                    </div>

                    <button
                      onClick={() => handleSetDefault(activeModel.modelId)}
                      disabled={isSettingDefault || activeModel.modelId === defaultModelId}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition disabled:opacity-40"
                    >
                      {activeModel.modelId === defaultModelId ? '⭐ เป็นค่าเริ่มต้นอยู่แล้ว' : '⭐ ตั้งเป็นค่าเริ่มต้น'}
                    </button>
                  </div>
                </div>

                {/* Versions Table */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
                  <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                    เวอร์ชัน Baseline ({activeModel.versions?.length ?? 0})
                  </h4>

                  <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400 bg-slate-900/60 text-left">
                          <th className="py-2.5 px-3">เวอร์ชัน</th>
                          <th className="py-2.5 px-3">สถานะ</th>
                          <th className="py-2.5 px-3">Reference Dataset</th>
                          <th className="py-2.5 px-3">สร้างเมื่อ</th>
                          <th className="py-2.5 px-3 text-right">การกระทำ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(activeModel.versions ?? []).map(v => {
                          const isSelVer = v.version === selectedVersion?.version;
                          return (
                            <tr
                              key={v.version}
                              onClick={() => setSelectedVersion(v)}
                              className={`border-b border-slate-800/40 cursor-pointer transition ${
                                isSelVer ? 'bg-indigo-500/10' : 'hover:bg-slate-800/20'
                              }`}
                            >
                              <td className="py-2.5 px-3 font-mono font-bold text-slate-200">
                                v{v.version}
                              </td>
                              <td className="py-2.5 px-3">
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${STATUS_STYLE[v.status]}`}>
                                  {v.status}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400">
                                {v.referenceDatasetId}
                              </td>
                              <td className="py-2.5 px-3 text-[11px] text-slate-500">
                                {new Date(v.createdAt).toLocaleDateString('th-TH')}
                              </td>
                              <td className="py-2.5 px-3 text-right">
                                <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                                  {v.status === 'DRAFT' && (
                                    <button
                                      onClick={() => handleTransition('validate', v)}
                                      className="px-2 py-0.5 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/40 text-blue-300 rounded text-[10px] font-semibold transition"
                                    >
                                      Validate
                                    </button>
                                  )}
                                  {v.status === 'VALIDATED' && (
                                    <button
                                      onClick={() => handleTransition('activate', v)}
                                      className="px-2 py-0.5 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 rounded text-[10px] font-semibold transition"
                                    >
                                      Activate
                                    </button>
                                  )}
                                  {v.status !== 'ARCHIVED' && (
                                    <button
                                      onClick={() => handleTransition('archive', v)}
                                      className="px-2 py-0.5 hover:bg-slate-800 border border-slate-700 text-slate-400 rounded text-[10px] transition"
                                    >
                                      Archive
                                    </button>
                                  )}
                                  <button
                                    onClick={() => handleExportJson(v)}
                                    title="Export JSON"
                                    className="px-2 py-0.5 hover:bg-slate-800 border border-slate-700 text-slate-300 rounded text-[10px] transition"
                                  >
                                    JSON
                                  </button>
                                  {activeModel.mode === 'scorecard' && (
                                    <button
                                      onClick={() => handleExportScorecardCsv(v)}
                                      title="Export Scorecard CSV"
                                      className="px-2 py-0.5 hover:bg-slate-800 border border-slate-700 text-slate-300 rounded text-[10px] transition"
                                    >
                                      CSV
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Selected Version Detail: Status History Timeline & Columns */}
                {selectedVersion && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div>
                        <h4 className="text-xs font-bold text-slate-200">
                          รายละเอียดเวอร์ชัน v{selectedVersion.version} · {selectedVersion.name}
                        </h4>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          สร้างโดย: {selectedVersion.createdBy} ({new Date(selectedVersion.createdAt).toLocaleString('th-TH')})
                        </p>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${STATUS_STYLE[selectedVersion.status]}`}>
                        {selectedVersion.status}
                      </span>
                    </div>

                    {/* Columns & Features summary */}
                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div className="space-y-1.5 p-3 rounded-xl bg-slate-950/40 border border-slate-800">
                        <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider block mb-1">
                          โครงสร้างคอลัมน์ (Columns)
                        </span>
                        <div className="space-y-1 text-[11px] font-mono">
                          <p><span className="text-slate-500">ID:</span> <span className="text-slate-200">{selectedVersion.columns?.idColumn || '—'}</span></p>
                          <p><span className="text-slate-500">Date:</span> <span className="text-slate-200">{selectedVersion.columns?.dateColumn || '—'}</span></p>
                          <p><span className="text-slate-500">Label:</span> <span className="text-slate-200">{selectedVersion.columns?.labelColumn || '—'}</span></p>
                          <p><span className="text-slate-500">Score:</span> <span className="text-slate-200">{selectedVersion.columns?.scoreColumn || '—'}</span></p>
                        </div>
                      </div>

                      <div className="space-y-1.5 p-3 rounded-xl bg-slate-950/40 border border-slate-800">
                        <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider block mb-1">
                          ตัวแปร (Features: {Object.keys(selectedVersion.featureRegistry ?? {}).length})
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {Object.keys(selectedVersion.featureRegistry ?? {}).map(f => (
                            <span key={f} className="text-[10px] font-mono px-2 py-0.5 rounded border border-slate-800 text-slate-300 bg-slate-900">
                              {f}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Status History Timeline */}
                    <div className="space-y-2 pt-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                        🕒 เส้นเวลาประวัติสถานะ (Status History Timeline)
                      </span>
                      <div className="space-y-2 border-l-2 border-slate-800 pl-3 ml-1">
                        {(selectedVersion.statusHistory ?? []).map((sh, idx) => (
                          <div key={idx} className="text-[11px] space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-300">
                                {sh.from ? `${sh.from} → ${sh.to}` : sh.to}
                              </span>
                              <span className="text-slate-500 font-mono text-[10px]">
                                {new Date(sh.at).toLocaleString('th-TH')}
                              </span>
                              <span className="text-slate-400 text-[10px] px-1.5 py-0.2 rounded bg-slate-800">
                                by {sh.by}
                              </span>
                            </div>
                            {sh.note && <p className="text-slate-400 italic text-[10px]">{sh.note}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="p-12 text-center text-slate-500 text-xs bg-slate-900/40 border border-slate-800 rounded-2xl">
                เลือกแบบจำลองจากฝั่งซ้ายเพื่อดูรายละเอียด
              </div>
            )}
          </div>
        </div>
      )}

      {/* Onboarding Wizard Modal */}
      {showWizard && (
        <BaselineOnboardingWizard
          initialData={wizardInitialData}
          onClose={() => setShowWizard(false)}
          onSuccess={handleWizardSuccess}
        />
      )}
    </div>
  );
}

