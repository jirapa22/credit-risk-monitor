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
import type { BaselineMode, BaselineStatus, BaselineVersion, DeletionAuditEntry } from '@/lib/types';
import BaselineOnboardingWizard from './BaselineOnboardingWizard';

function isBuiltInModel(id: string): boolean {
  return id === 'ascore_v1';
}

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

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<DeletionAuditEntry[]>([]);
  const [showAuditLogs, setShowAuditLogs] = useState<boolean>(false);

  // Delete version modal state
  const [deleteModelIfEmpty, setDeleteModelIfEmpty] = useState<boolean>(true);
  const [deleteModal, setDeleteModal] = useState<{
    isOpen: boolean;
    version: BaselineVersion | null;
    loading: boolean;
    impact: {
      monitoringRunsCount: number;
      sandboxRunsCount: number;
      eventsCount: number;
      reviewsCount: number;
      totalImpactCount: number;
      canDelete: boolean;
      reason?: string;
    } | null;
    confirmInput: string;
    isProcessing: boolean;
    errorMessage: string;
  }>({
    isOpen: false,
    version: null,
    loading: false,
    impact: null,
    confirmInput: '',
    isProcessing: false,
    errorMessage: '',
  });

  // Delete whole model modal state
  const [deleteModelModal, setDeleteModelModal] = useState<{
    isOpen: boolean;
    model: ModelRegistryEntry | null;
    confirmInput: string;
    isProcessing: boolean;
    errorMessage: string;
  }>({
    isOpen: false,
    model: null,
    confirmInput: '',
    isProcessing: false,
    errorMessage: '',
  });

  // Edit baseline modal state
  const [editModal, setEditModal] = useState<{
    isOpen: boolean;
    version: BaselineVersion | null;
    name: string;
    description: string;
    isProcessing: boolean;
    errorMessage: string;
  }>({
    isOpen: false,
    version: null,
    name: '',
    description: '',
    isProcessing: false,
    errorMessage: '',
  });

  const openDeleteModal = async (v: BaselineVersion) => {
    setDeleteModelIfEmpty(true);
    setDeleteModal({
      isOpen: true,
      version: v,
      loading: true,
      impact: null,
      confirmInput: '',
      isProcessing: false,
      errorMessage: '',
    });

    try {
      const res = await fetch(`/api/registry/models/${v.modelId}/versions/${v.version}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setDeleteModal(prev => ({
          ...prev,
          loading: false,
          impact: data,
        }));
      } else {
        setDeleteModal(prev => ({
          ...prev,
          loading: false,
          errorMessage: data.error || 'ไม่สามารถดึงข้อมูลผลกระทบได้',
        }));
      }
    } catch (err: unknown) {
      setDeleteModal(prev => ({
        ...prev,
        loading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const closeDeleteModal = () => {
    setDeleteModal({
      isOpen: false,
      version: null,
      loading: false,
      impact: null,
      confirmInput: '',
      isProcessing: false,
      errorMessage: '',
    });
  };

  const handleDeleteSubmit = async (action: 'delete' | 'archive') => {
    const v = deleteModal.version;
    if (!v) return;

    setDeleteModal(prev => ({ ...prev, isProcessing: true, errorMessage: '' }));
    try {
      const res = await fetch(`/api/registry/models/${v.modelId}/versions/${v.version}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, deleteModelIfEmpty }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `ดำเนินการ ${action} ไม่สำเร็จ`);
      }

      closeDeleteModal();
      if (selectedVersion?.version === v.version) {
        setSelectedVersion(null);
      }
      await loadRegistry();
      alert(
        action === 'archive'
          ? `📦 เก็บถาวร (Archive) เวอร์ชัน v${v.version} เรียบร้อยแล้ว`
          : `🗑️ ลบ Baseline เวอร์ชัน v${v.version} และข้อมูลที่เกี่ยวข้องสำเร็จ`,
      );
    } catch (err: unknown) {
      setDeleteModal(prev => ({
        ...prev,
        isProcessing: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const openDeleteModelModal = (m: ModelRegistryEntry) => {
    setDeleteModelModal({
      isOpen: true,
      model: m,
      confirmInput: '',
      isProcessing: false,
      errorMessage: '',
    });
  };

  const closeDeleteModelModal = () => {
    setDeleteModelModal({
      isOpen: false,
      model: null,
      confirmInput: '',
      isProcessing: false,
      errorMessage: '',
    });
  };

  const handleDeleteModelSubmit = async () => {
    const m = deleteModelModal.model;
    if (!m) return;

    setDeleteModelModal(prev => ({ ...prev, isProcessing: true, errorMessage: '' }));
    try {
      const res = await fetch(`/api/registry/models/${m.modelId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'ลบโมเดลไม่สำเร็จ');
      }

      closeDeleteModelModal();
      await loadRegistry();
      alert(`🗑️ ลบโมเดล "${m.name}" (${m.modelId}) และข้อมูลทั้งหมดเรียบร้อยแล้ว`);
    } catch (err: unknown) {
      setDeleteModelModal(prev => ({
        ...prev,
        isProcessing: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const openEditModal = (v: BaselineVersion) => {
    setEditModal({
      isOpen: true,
      version: v,
      name: v.name || '',
      description: v.description || '',
      isProcessing: false,
      errorMessage: '',
    });
  };

  const closeEditModal = () => {
    setEditModal({
      isOpen: false,
      version: null,
      name: '',
      description: '',
      isProcessing: false,
      errorMessage: '',
    });
  };

  const handleEditSubmit = async () => {
    const v = editModal.version;
    if (!v) return;

    setEditModal(prev => ({ ...prev, isProcessing: true, errorMessage: '' }));
    try {
      const res = await fetch(`/api/registry/models/${v.modelId}/versions/${v.version}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editModal.name.trim() || v.name,
          description: editModal.description.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'แก้ไข Baseline ไม่สำเร็จ');
      }

      closeEditModal();
      await loadRegistry();
      alert(`✅ แก้ไขข้อมูล Baseline v${v.version} สำเร็จ`);
    } catch (err: unknown) {
      setEditModal(prev => ({
        ...prev,
        isProcessing: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  // Load models and default
  const loadRegistry = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [modelsRes, defRes, auditRes] = await Promise.all([
        fetch('/api/registry/models', { cache: 'no-store' }),
        fetch('/api/registry/default', { cache: 'no-store' }),
        fetch('/api/registry/audit', { cache: 'no-store' }),
      ]);
      const modelsData = await modelsRes.json();
      const defData = await defRes.json();
      const auditData = await auditRes.json();

      if (auditRes.ok && Array.isArray(auditData.logs)) {
        setAuditLogs(auditData.logs);
      }

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

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleSetDefault(activeModel.modelId)}
                        disabled={isSettingDefault || activeModel.modelId === defaultModelId}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition disabled:opacity-40"
                      >
                        {activeModel.modelId === defaultModelId ? '⭐ เป็นค่าเริ่มต้นอยู่แล้ว' : '⭐ ตั้งเป็นค่าเริ่มต้น'}
                      </button>
                      {!isBuiltInModel(activeModel.modelId) && (
                        <button
                          onClick={() => openDeleteModelModal(activeModel)}
                          title="ลบโมเดลทั้งหมดออกจาก Registry"
                          className="px-3 py-1.5 hover:bg-rose-500/20 border border-rose-500/40 text-rose-300 text-xs font-semibold rounded-xl transition"
                        >
                          🗑️ ลบโมเดล
                        </button>
                      )}
                    </div>
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
                                  {!v.builtIn && (
                                    <button
                                      onClick={() => openEditModal(v)}
                                      title="แก้ไขชื่อและคำอธิบาย Baseline"
                                      className="px-2 py-0.5 hover:bg-slate-800 border border-slate-700 text-slate-300 rounded text-[10px] transition"
                                    >
                                      แก้ไข
                                    </button>
                                  )}
                                  {!v.builtIn && (
                                    <button
                                      onClick={() => openDeleteModal(v)}
                                      title="ลบ Baseline"
                                      className="px-2 py-0.5 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 rounded text-[10px] transition"
                                    >
                                      ลบ
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

      {/* Delete Confirmation Modal */}
      {deleteModal.isOpen && deleteModal.version && (() => {
        const v = deleteModal.version;
        const impact = deleteModal.impact;
        const isActive = v.status === 'ACTIVE';
        const expectedConfirm = (v.name || v.version).trim();
        const isMatch =
          deleteModal.confirmInput.trim() === expectedConfirm ||
          deleteModal.confirmInput.trim() === v.version;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col space-y-4 p-6">
              {/* Header */}
              <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xl">🗑️</span>
                  <div>
                    <h3 className="text-sm font-bold text-slate-100">
                      ยืนยันการลบ Baseline: v{v.version}
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      โมเดล: <span className="font-mono text-indigo-300">{v.modelId}</span> · {v.name}
                    </p>
                  </div>
                </div>
                <button
                  onClick={closeDeleteModal}
                  disabled={deleteModal.isProcessing}
                  className="text-slate-400 hover:text-slate-200 text-lg leading-none"
                >
                  ✕
                </button>
              </div>

              {deleteModal.errorMessage && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                  ❌ {deleteModal.errorMessage}
                </div>
              )}

              {deleteModal.loading ? (
                <div className="py-8 text-center text-slate-400 text-xs animate-pulse">
                  กำลังตรวจสอบประวัติและผลกระทบของ Baseline...
                </div>
              ) : isActive ? (
                /* Rule: ACTIVE cannot be deleted directly */
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs space-y-2">
                    <p className="font-bold text-amber-300 flex items-center gap-1.5">
                      <span>⚠️</span> ไม่สามารถลบเวอร์ชันที่เป็น ACTIVE ได้โดยตรง
                    </p>
                    <p className="text-[11px] text-amber-200/90 leading-relaxed">
                      ตามนโยบาย MLOps Governance: เวอร์ชันที่มีสถานะ ACTIVE กำลังเปิดใช้งานสำหรับติดตามผล (Monitoring) อยู่ในระบบ เพื่อป้องกันระบบขัดข้อง กรุณาเปลี่ยนสถานะเป็น ARCHIVED ก่อน หรือเปิดใช้งานเวอร์ชันอื่นแทนจึงจะสามารถลบได้
                    </p>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                    <button
                      onClick={closeDeleteModal}
                      disabled={deleteModal.isProcessing}
                      className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 rounded-xl text-xs transition"
                    >
                      ปิด
                    </button>
                    <button
                      onClick={() => handleDeleteSubmit('archive')}
                      disabled={deleteModal.isProcessing}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-amber-500/20 transition"
                    >
                      {deleteModal.isProcessing ? 'กำลังบันทึก...' : '📦 เก็บถาวร (Archive) ทันที'}
                    </button>
                  </div>
                </div>
              ) : (
                /* Non-ACTIVE: DRAFT, VALIDATED, ARCHIVED */
                <div className="space-y-4">
                  {impact && impact.totalImpactCount > 0 ? (
                    <div className="space-y-3">
                      <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs space-y-2">
                        <p className="font-bold text-rose-300 flex items-center gap-1.5">
                          <span>⚠️</span> ตรวจพบประวัติที่ผูกกับ Baseline เวอร์ชันนี้ ({impact.totalImpactCount} รายการ)
                        </p>
                        <ul className="list-disc list-inside text-[11px] text-rose-200/90 space-y-1">
                          <li>ประวัติการรัน Monitoring: {impact.monitoringRunsCount} รายการ</li>
                          <li>ประวัติการทดลอง Sandbox: {impact.sandboxRunsCount} รายการ</li>
                          <li>รายการ Trigger Alert & Event: {impact.eventsCount} รายการ (มีบันทึกตรวจทาน {impact.reviewsCount} รายการ)</li>
                          {v.referenceDatasetId && (
                            <li>ไฟล์ Reference Dataset ใน Blob Storage: {v.referenceDatasetId}</li>
                          )}
                        </ul>
                      </div>

                      <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs space-y-2">
                        <p className="font-semibold text-slate-300 text-[11px]">ทางเลือกการจัดการ:</p>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div className="p-2.5 rounded-lg border border-slate-700 bg-slate-900/60 space-y-1">
                            <p className="font-bold text-slate-200">1. เก็บถาวร (Archive)</p>
                            <p className="text-[10px] text-slate-400">
                              หยุดการใช้งาน แต่ยังคงเก็บประวัติและ audit trail ไว้ตรวจสอบย้อนหลังได้
                            </p>
                          </div>
                          <div className="p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/5 space-y-1">
                            <p className="font-bold text-rose-300">2. ลบถาวร (Delete)</p>
                            <p className="text-[10px] text-slate-400">
                              ลบทั้งข้อมูลใน KV และไฟล์ Reference ใน Blob ออกโดยสมบูรณ์
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 text-xs space-y-1.5">
                      <p className="text-[11px] text-slate-300">
                        ไม่พบประวัติการรันที่ผูกอยู่ ระบบจะลบเวอร์ชันนี้และไฟล์ Reference ใน Blob Storage (หากไม่ได้ถูกใช้งานโดยเวอร์ชันอื่น)
                      </p>
                    </div>
                  )}

                  {/* Confirmation text input */}
                  <div className="space-y-1.5 pt-1">
                    <label className="text-xs text-slate-300 font-semibold block">
                      พิมพ์ชื่อ Baseline <span className="font-mono text-amber-300 font-bold select-all">"{expectedConfirm}"</span> เพื่อยืนยันการลบ:
                    </label>
                    <input
                      type="text"
                      value={deleteModal.confirmInput}
                      onChange={e => setDeleteModal(prev => ({ ...prev, confirmInput: e.target.value }))}
                      placeholder={`พิมพ์ "${expectedConfirm}"`}
                      disabled={deleteModal.isProcessing}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 outline-none focus:border-rose-500"
                    />
                  </div>

                  {activeModel && activeModel.versions?.length === 1 && !isBuiltInModel(activeModel.modelId) && (
                    <label className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/10 p-2.5 rounded-xl border border-amber-500/20 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={deleteModelIfEmpty}
                        onChange={e => setDeleteModelIfEmpty(e.target.checked)}
                        className="rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-0"
                      />
                      <span>ลบโมเดล <strong>{activeModel.name} ({activeModel.modelId})</strong> ออกด้วยเนื่องจากเป็นเวอร์ชันสุดท้าย</span>
                    </label>
                  )}

                  {/* Modal Action buttons */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-800">
                    <button
                      onClick={closeDeleteModal}
                      disabled={deleteModal.isProcessing}
                      className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 rounded-xl text-xs transition"
                    >
                      ยกเลิก
                    </button>
                    <div className="flex items-center gap-2">
                      {impact && impact.totalImpactCount > 0 && v.status !== 'ARCHIVED' && (
                        <button
                          onClick={() => handleDeleteSubmit('archive')}
                          disabled={deleteModal.isProcessing}
                          className="px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition"
                        >
                          📦 เก็บถาวร (Archive)
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteSubmit('delete')}
                        disabled={!isMatch || deleteModal.isProcessing}
                        className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:hover:bg-rose-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-rose-500/20 transition"
                      >
                        {deleteModal.isProcessing ? 'กำลังลบ...' : '🗑️ ยืนยันลบถาวร'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
      {/* Edit Baseline Modal */}
      {editModal.isOpen && editModal.version && (() => {
        const v = editModal.version;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4">
              <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-100">
                    แก้ไขข้อมูล Baseline v{v.version}
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    โมเดล: <span className="font-mono text-indigo-300">{v.modelId}</span> · สถานะ: {v.status}
                  </p>
                </div>
                <button
                  onClick={closeEditModal}
                  disabled={editModal.isProcessing}
                  className="text-slate-400 hover:text-slate-200 text-lg leading-none"
                >
                  ✕
                </button>
              </div>

              {editModal.errorMessage && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                  ❌ {editModal.errorMessage}
                </div>
              )}

              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs text-slate-300 font-semibold block">
                    ชื่อ Baseline (Display Name)
                  </label>
                  <input
                    type="text"
                    value={editModal.name}
                    onChange={e => setEditModal(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="เช่น โมเดลสินเชื่อบุคคลภายนอก v1"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-300 font-semibold block">
                    คำอธิบาย (Description)
                  </label>
                  <textarea
                    rows={3}
                    value={editModal.description}
                    onChange={e => setEditModal(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="คำอธิบายโมเดลและรายละเอียดเพิ่มเติม"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500 resize-none"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  onClick={closeEditModal}
                  disabled={editModal.isProcessing}
                  className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 rounded-xl text-xs transition"
                >
                  ยกเลิก
                </button>
                <button
                  onClick={handleEditSubmit}
                  disabled={editModal.isProcessing}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-indigo-500/20 transition"
                >
                  {editModal.isProcessing ? 'กำลังบันทึก...' : '💾 บันทึกการแก้ไข'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete Model Modal */}
      {deleteModelModal.isOpen && deleteModelModal.model && (() => {
        const m = deleteModelModal.model;
        const isBuiltIn = isBuiltInModel(m.modelId);
        const isDefault = m.modelId === defaultModelId;
        const activeVer = m.versions?.find(v => v.status === 'ACTIVE');
        const canDelete = !isBuiltIn && !isDefault && !activeVer;
        const isMatch = deleteModelModal.confirmInput.trim() === m.modelId;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl p-6 space-y-4">
              <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xl">⚠️</span>
                  <div>
                    <h3 className="text-sm font-bold text-slate-100">
                      ยืนยันการลบโมเดล: {m.name} ({m.modelId})
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      การลบโมเดลจะลบประวัติการรันและเวอร์ชัน Baseline ทั้งหมด ({m.versions?.length ?? 0} เวอร์ชัน)
                    </p>
                  </div>
                </div>
                <button
                  onClick={closeDeleteModelModal}
                  disabled={deleteModelModal.isProcessing}
                  className="text-slate-400 hover:text-slate-200 text-lg leading-none"
                >
                  ✕
                </button>
              </div>

              {deleteModelModal.errorMessage && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                  ❌ {deleteModelModal.errorMessage}
                </div>
              )}

              {isBuiltIn ? (
                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
                  ⚠️ ไม่สามารถลบโมเดลมาตรฐาน (Built-in) ของระบบได้
                </div>
              ) : isDefault ? (
                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs space-y-1">
                  <p className="font-bold">⚠️ โมเดลนี้ถูกตั้งเป็นค่าเริ่มต้น (Default) ของระบบ</p>
                  <p className="text-[11px] text-amber-200/80">
                    กรุณาเลือกโมเดลอื่นและคลิก "⭐ ตั้งเป็นค่าเริ่มต้น" ก่อน จึงจะสามารถลบโมเดลนี้ได้
                  </p>
                </div>
              ) : activeVer ? (
                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs space-y-1">
                  <p className="font-bold">⚠️ โมเดลนี้ยังมีเวอร์ชัน ACTIVE อยู่ (v{activeVer.version})</p>
                  <p className="text-[11px] text-amber-200/80">
                    ตามนโยบาย MLOps Governance: ต้อง Archive หรือเปลี่ยนสถานะเวอร์ชัน ACTIVE ก่อนจึงจะลบโมเดลได้
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs space-y-2">
                    <p className="font-bold text-rose-300">
                      การดำเนินการนี้ไม่สามารถย้อนกลับได้:
                    </p>
                    <ul className="list-disc list-inside text-[11px] text-rose-200/90 space-y-0.5">
                      <li>เวอร์ชัน Baseline ทั้งหมด {m.versions?.length ?? 0} เวอร์ชันจะถูกลบถาวร</li>
                      <li>ประวัติการรัน Monitoring, Sandbox และ Event ใน KV จะถูกลบออก</li>
                      <li>ไฟล์ Reference ใน Blob Storage ที่ไม่ได้ถูกใช้ร่วมกับโมเดลอื่นจะถูกลบออก</li>
                    </ul>
                  </div>

                  <div className="space-y-1.5 pt-1">
                    <label className="text-xs text-slate-300 font-semibold block">
                      พิมพ์รหัสโมเดล <span className="font-mono text-amber-300 font-bold select-all">"{m.modelId}"</span> เพื่อยืนยันการลบโมเดลทั้งหมด:
                    </label>
                    <input
                      type="text"
                      value={deleteModelModal.confirmInput}
                      onChange={e => setDeleteModelModal(prev => ({ ...prev, confirmInput: e.target.value }))}
                      placeholder={`พิมพ์ "${m.modelId}"`}
                      disabled={deleteModelModal.isProcessing}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 outline-none focus:border-rose-500"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  onClick={closeDeleteModelModal}
                  disabled={deleteModelModal.isProcessing}
                  className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 rounded-xl text-xs transition"
                >
                  ยกเลิก
                </button>
                {canDelete && (
                  <button
                    onClick={handleDeleteModelSubmit}
                    disabled={!isMatch || deleteModelModal.isProcessing}
                    className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:hover:bg-rose-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-rose-500/20 transition"
                  >
                    {deleteModelModal.isProcessing ? 'กำลังลบ...' : '🗑️ ยืนยันลบโมเดลถาวร'}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Deletion Audit Logs Section */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm">📋</span>
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
              ประวัติการลบและเก็บถาวร (Deletion Audit Logs)
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.2 rounded bg-slate-800 text-slate-400">
              {auditLogs.length} รายการ
            </span>
          </div>
          <button
            onClick={() => setShowAuditLogs(!showAuditLogs)}
            className="px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg text-xs transition"
          >
            {showAuditLogs ? '▲ ซ่อนประวัติ' : '▼ แสดงประวัติ'}
          </button>
        </div>

        {showAuditLogs && (
          <div className="pt-2">
            {auditLogs.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">ยังไม่มีประวัติการลบหรือเก็บถาวร</p>
            ) : (
              <div className="border border-slate-800 rounded-xl overflow-x-auto bg-slate-950/40">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 bg-slate-900/60 text-[11px]">
                      <th className="py-2 px-3">วันที่ / เวลา</th>
                      <th className="py-2 px-3">การกระทำ</th>
                      <th className="py-2 px-3">โมเดล</th>
                      <th className="py-2 px-3">เวอร์ชัน</th>
                      <th className="py-2 px-3">ผู้ดำเนินการ</th>
                      <th className="py-2 px-3">รายการที่ลบ</th>
                      <th className="py-2 px-3">หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map(log => (
                      <tr key={log.id} className="border-b border-slate-800/40 hover:bg-slate-900/40">
                        <td className="py-2 px-3 font-mono text-[10px] text-slate-400 whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleString('th-TH')}
                        </td>
                        <td className="py-2 px-3">
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                              log.action === 'delete_version' || log.action === 'delete_model'
                                ? 'border-rose-500/40 text-rose-300 bg-rose-500/10'
                                : 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                            }`}
                          >
                            {log.action}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-mono text-slate-200">{log.modelId}</td>
                        <td className="py-2 px-3 font-mono text-slate-400">{log.version ? `v${log.version}` : '—'}</td>
                        <td className="py-2 px-3 text-slate-400">{log.actor}</td>
                        <td className="py-2 px-3 text-[11px] text-slate-300">
                          {log.clearedCounts.total > 0 ? (
                            <span>{log.clearedCounts.total} รายการ (Runs/Events)</span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                          {log.blobDeleted && <span className="ml-1 text-emerald-400">(Blob)</span>}
                        </td>
                        <td className="py-2 px-3 text-[11px] text-slate-400 truncate max-w-xs">{log.note || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

