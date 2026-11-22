'use client';

import React, { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';

interface RuleSetConfig {
  psi_warning: number;
  psi_critical: number;
  csi_warning: number;
  csi_critical: number;
  auc_min: number;
  gini_min: number;
  ks_min: number;
  dataIssueThresholdRate: number;
  labelPValueThreshold: number;
  decileAlertThresholdPctPoints: number;
  enabledRules: {
    R1b: boolean;
    R5: boolean;
    R8: boolean;
    R5b: boolean;
  };
}

interface RuleSetRevision {
  revision: number;
  config: RuleSetConfig;
  createdAt: string;
  author: string;
  reason: string;
}

interface RuleSet {
  id: string;
  name: string;
  description: string;
  modelId: string;
  modelVersion: string;
  templateId?: string;
  currentRevision: number;
  activeRevision?: number;
  isActive: boolean;
  revisions: RuleSetRevision[];
  createdAt: string;
  updatedAt: string;
}

interface RuleSetAuditDiff {
  field: string;
  label: string;
  oldValue: unknown;
  newValue: unknown;
}

interface RuleSetAuditEntry {
  id: string;
  timestamp: string;
  modelId: string;
  modelVersion: string;
  setId: string;
  setName: string;
  revision: number;
  action: 'CREATE' | 'UPDATE' | 'ACTIVATE' | 'REVERT';
  author: string;
  reason: string;
  diffs: RuleSetAuditDiff[];
}

interface SimulationItem {
  runId: string;
  period: string | null;
  fileName: string;
  actualAction: string;
  actualRuleId: string | null;
  simulatedAction: string;
  simulatedRuleId: string | null;
  changed: boolean;
  simulatedReasons: string[];
}

export default function RulesPage() {
  const [modelId, setModelId] = useState<string>('model_vmc5k');
  const [modelVersion, setModelVersion] = useState<string>('1.0.0');
  const [availableModels, setAvailableModels] = useState<Array<{ modelId: string; name: string }>>([]);
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [activeRuleSet, setActiveRuleSet] = useState<{ setId: string; name: string; revision: number } | null>(null);
  const [selectedSetId, setSelectedSetId] = useState<string>('');
  const [auditLogs, setAuditLogs] = useState<RuleSetAuditEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Form states
  const [formConfig, setFormConfig] = useState<RuleSetConfig | null>(null);
  const [targetRevisionForRevert, setTargetRevisionForRevert] = useState<number>(1);

  // Action Dialogs
  const [dialogAction, setDialogAction] = useState<'save_revision' | 'activate' | 'revert' | 'create_set' | null>(null);
  const [dialogAuthor, setDialogAuthor] = useState<string>('');
  const [dialogReason, setDialogReason] = useState<string>('');
  const [newSetName, setNewSetName] = useState<string>('');
  const [newSetDesc, setNewSetDesc] = useState<string>('');

  // Simulation states
  const [simResults, setSimResults] = useState<SimulationItem[] | null>(null);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [, startTransition] = useTransition();

  const loadData = async (mId = modelId, v = modelVersion) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      // 1. Load registered models
      const regRes = await fetch('/api/registry/models');
      if (regRes.ok) {
        const regData = await regRes.json();
        if (Array.isArray(regData.models) && regData.models.length > 0) {
          setAvailableModels(regData.models.map((m: any) => ({ modelId: m.modelId, name: m.name })));
        }
      }

      // 2. Load rule sets
      const rsRes = await fetch(`/api/registry/rules?modelId=${encodeURIComponent(mId)}&version=${encodeURIComponent(v)}`);
      if (!rsRes.ok) throw new Error('ไม่สามารถโหลดข้อมูลชุดกฎได้');
      const rsData = await rsRes.json();
      setRuleSets(rsData.ruleSets || []);
      setActiveRuleSet(rsData.activeRuleSet || null);

      // Select active or first set
      const initialId = rsData.activeRuleSet?.setId || rsData.ruleSets?.[0]?.id || '';
      setSelectedSetId(initialId);
      const chosen = rsData.ruleSets?.find((s: RuleSet) => s.id === initialId) || rsData.ruleSets?.[0];
      if (chosen && chosen.revisions?.length > 0) {
        const activeRevNum = chosen.activeRevision || chosen.currentRevision;
        const rev = chosen.revisions.find((r: any) => r.revision === activeRevNum) || chosen.revisions[chosen.revisions.length - 1];
        setFormConfig(structuredClone(rev.config));
        setTargetRevisionForRevert(chosen.revisions[0]?.revision || 1);
      }

      // 3. Load audit logs
      const auditRes = await fetch(`/api/registry/rules/audit?modelId=${encodeURIComponent(mId)}&version=${encodeURIComponent(v)}`);
      if (auditRes.ok) {
        const auditData = await auditRes.json();
        setAuditLogs(auditData.auditLogs || []);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'เกิดข้อผิดพลาดในการโหลดข้อมูล');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSelectRuleSet = (setId: string) => {
    setSelectedSetId(setId);
    setSimResults(null);
    const chosen = ruleSets.find(s => s.id === setId);
    if (chosen && chosen.revisions?.length > 0) {
      const activeRevNum = chosen.activeRevision || chosen.currentRevision;
      const rev = chosen.revisions.find(r => r.revision === activeRevNum) || chosen.revisions[chosen.revisions.length - 1];
      setFormConfig(structuredClone(rev.config));
      setTargetRevisionForRevert(chosen.revisions[0]?.revision || 1);
    }
  };

  const handleApplyTemplatePreset = (template: 'standard' | 'strict' | 'relaxed' | 'population_adjusted') => {
    if (!formConfig) return;
    let nextConfig: RuleSetConfig;
    if (template === 'strict') {
      nextConfig = {
        psi_warning: 0.05,
        psi_critical: 0.15,
        csi_warning: 0.05,
        csi_critical: 0.15,
        auc_min: 0.60,
        gini_min: 0.20,
        ks_min: 0.15,
        dataIssueThresholdRate: 0.5,
        labelPValueThreshold: 0.10,
        decileAlertThresholdPctPoints: 3.0,
        enabledRules: { R1b: true, R5: true, R8: true, R5b: false },
      };
    } else if (template === 'relaxed') {
      nextConfig = {
        psi_warning: 0.15,
        psi_critical: 0.30,
        csi_warning: 0.15,
        csi_critical: 0.30,
        auc_min: 0.50,
        gini_min: 0.05,
        ks_min: 0.05,
        dataIssueThresholdRate: 2.0,
        labelPValueThreshold: 0.01,
        decileAlertThresholdPctPoints: 8.0,
        enabledRules: { R1b: true, R5: true, R8: true, R5b: false },
      };
    } else if (template === 'population_adjusted') {
      nextConfig = {
        psi_warning: 0.10,
        psi_critical: 0.25,
        csi_warning: 0.10,
        csi_critical: 0.25,
        auc_min: 0.55,
        gini_min: 0.10,
        ks_min: 0.10,
        dataIssueThresholdRate: 1.0,
        labelPValueThreshold: 0.05,
        decileAlertThresholdPctPoints: 5.0,
        enabledRules: { R1b: true, R5: true, R8: true, R5b: true },
      };
    } else {
      nextConfig = {
        psi_warning: 0.10,
        psi_critical: 0.25,
        csi_warning: 0.10,
        csi_critical: 0.25,
        auc_min: 0.55,
        gini_min: 0.10,
        ks_min: 0.10,
        dataIssueThresholdRate: 1.0,
        labelPValueThreshold: 0.05,
        decileAlertThresholdPctPoints: 5.0,
        enabledRules: { R1b: true, R5: true, R8: true, R5b: false },
      };
    }
    setFormConfig(nextConfig);
    setSuccessMsg(`นำเข้าค่าจากเทมเพลต "${template}" ลงในฟอร์มเรียบร้อย (กรุณากดบันทึก Revision ใหม่เพื่อยืนยัน)`);
  };

  const executeConfirmedAction = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    const author = dialogAuthor.trim();
    const reason = dialogReason.trim();

    if (!author) {
      setErrorMsg('กรุณากรอกชื่อผู้ดำเนินการ');
      return;
    }
    if (!reason) {
      setErrorMsg('กรุณากรอกเหตุผลในการดำเนินการ');
      return;
    }

    try {
      if (dialogAction === 'create_set') {
        const res = await fetch('/api/registry/rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelId,
            version: modelVersion,
            name: newSetName.trim(),
            description: newSetDesc.trim(),
            config: formConfig,
            author,
            reason,
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'สร้างชุดกฎไม่สำเร็จ');
        setSuccessMsg(`สร้างชุดกฎ "${newSetName}" สำเร็จ`);
        setDialogAction(null);
        await loadData();
      } else if (dialogAction === 'save_revision') {
        const res = await fetch(`/api/registry/rules/${encodeURIComponent(selectedSetId)}/revisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelId,
            version: modelVersion,
            config: formConfig,
            author,
            reason,
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'บันทึก Revision ไม่สำเร็จ');
        setSuccessMsg(`บันทึก Revision ${d.newRevision?.revision} สำเร็จ`);
        setDialogAction(null);
        await loadData();
      } else if (dialogAction === 'activate') {
        const chosen = ruleSets.find(s => s.id === selectedSetId);
        const revNum = chosen?.currentRevision || 1;
        const res = await fetch(`/api/registry/rules/${encodeURIComponent(selectedSetId)}/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelId,
            version: modelVersion,
            revision: revNum,
            author,
            reason,
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'เปิดใช้งานชุดกฎไม่สำเร็จ');
        setSuccessMsg(`เปิดใช้งานชุดกฎ "${chosen?.name}" Revision ${revNum} เรียบร้อยแล้ว`);
        setDialogAction(null);
        await loadData();
      } else if (dialogAction === 'revert') {
        const res = await fetch(`/api/registry/rules/${encodeURIComponent(selectedSetId)}/revert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelId,
            version: modelVersion,
            targetRevision: targetRevisionForRevert,
            author,
            reason,
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'ย้อนกลับ Revision ไม่สำเร็จ');
        setSuccessMsg(`ย้อนกลับไปยัง Revision ${targetRevisionForRevert} เรียบร้อยแล้ว`);
        setDialogAction(null);
        await loadData();
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'เกิดข้อผิดพลาดในการทำรายการ');
    }
  };

  const handleSimulate = async () => {
    if (!formConfig) return;
    setIsSimulating(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/registry/rules/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          version: modelVersion,
          config: formConfig,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'การจำลองไม่สำเร็จ');
      startTransition(() => {
        setSimResults(d.simulation || []);
      });
      if (!d.simulation || d.simulation.length === 0) {
        setSuccessMsg(d.message || 'ไม่พบประวัติรอบที่ผ่านมาสำหรับโมเดลนี้');
      } else {
        setSuccessMsg(`จำลองสำเร็จกับประวัติ ${d.totalRuns} รอบ (ผล Trigger เปลี่ยนไป ${d.changedCount} รอบ)`);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'การจำลองล้มเหลว');
    } finally {
      setIsSimulating(false);
    }
  };

  const selectedRuleSet = ruleSets.find(s => s.id === selectedSetId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6" style={{ fontFamily: "'Inter', sans-serif" }}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Top Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard"
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 transition"
            >
              ← กลับสู่แดชบอร์ดหลัก
            </Link>
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2">
                <span>⚖️</span>
                <span>ชุดกฎและเกณฑ์การตรวจวัด (Rule Set Management)</span>
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">
                ปรับเปลี่ยนเกณฑ์การตัดสินใจ ตรวจสอบย้อนกลับด้วย Audit Trail และประเมินผลกระทบจำลอง
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400">โมเดล:</span>
              <select
                value={modelId}
                onChange={e => {
                  const m = e.target.value;
                  setModelId(m);
                  loadData(m, modelVersion);
                }}
                className="bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500"
              >
                {availableModels.map(m => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.modelId} — {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400">เวอร์ชัน:</span>
              <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 font-mono text-slate-300">
                v{modelVersion}
              </span>
            </div>
          </div>
        </div>

        {/* Regulatory Disclaimer Banner (Strictly no Basel mention) */}
        <div className="bg-slate-900/80 border border-indigo-500/20 rounded-xl p-3.5 flex items-start gap-3 text-xs text-indigo-300">
          <span className="text-base">ℹ️</span>
          <div>
            <span className="font-semibold text-indigo-200">ข้อกำหนดเชิงปฏิบัติ: </span>
            <span>
              เกณฑ์ในเทมเพลตมาตรฐานเป็นค่าเริ่มต้นเชิงปฏิบัติของผู้พัฒนาระบบ ไม่ใช่ข้อบังคับของหน่วยงานกำกับดูแล
              ผู้ใช้งานและทีมบริหารความเสี่ยงสามารถปรับเปลี่ยนเกณฑ์ให้สอดคล้องกับนโยบาย Risk Appetite และลักษณะพอร์ตสินเชื่อขององค์กรได้
            </span>
          </div>
        </div>

        {/* Notifications */}
        {errorMsg && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-xs text-rose-300 flex items-center justify-between">
            <span>⚠️ {errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} className="text-rose-400 hover:text-white">✕</button>
          </div>
        )}
        {successMsg && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 text-xs text-emerald-300 flex items-center justify-between">
            <span>✅ {successMsg}</span>
            <button onClick={() => setSuccessMsg(null)} className="text-emerald-400 hover:text-white">✕</button>
          </div>
        )}

        {/* Main Grid: Left List + Right Form */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Rule Sets List (4 cols) */}
          <div className="lg:col-span-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                ชุดกฎทั้งหมด ({ruleSets.length})
              </h2>
              <button
                onClick={() => {
                  setNewSetName('');
                  setNewSetDesc('');
                  setDialogAuthor('');
                  setDialogReason('');
                  setDialogAction('create_set');
                }}
                className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium transition"
              >
                + สร้างชุดกฎใหม่
              </button>
            </div>

            <div className="space-y-2">
              {ruleSets.map(s => {
                const isSelected = s.id === selectedSetId;
                const isCurrentActive = activeRuleSet?.setId === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => handleSelectRuleSet(s.id)}
                    className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-slate-900 border-indigo-500 ring-1 ring-indigo-500/40 shadow-sm'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-sm text-slate-200 flex items-center gap-2">
                        <span>{s.name}</span>
                        {isCurrentActive && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            🟢 ACTIVE
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] font-mono text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
                        rev {s.currentRevision}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                      {s.description}
                    </p>
                    <div className="mt-2.5 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-500">
                      <span>เทมเพลต: {s.templateId || 'custom'}</span>
                      <span>แก้ไข {s.revisions?.length || 1} ครั้ง</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Rule Set Editor (8 cols) */}
          <div className="lg:col-span-8 space-y-5">
            {selectedRuleSet && formConfig ? (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-6">
                {/* Editor Header */}
                <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-base font-bold text-white">{selectedRuleSet.name}</h2>
                      {activeRuleSet?.setId === selectedRuleSet.id ? (
                        <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                          🟢 กำลังใช้งาน (Active rev {activeRuleSet.revision})
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                          ⚪ ยังไม่เปิดใช้งาน
                        </span>
                      )}
                      <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                        Revision ปัจจุบัน: {selectedRuleSet.currentRevision}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{selectedRuleSet.description}</p>
                  </div>

                  {/* Quick Preset Buttons */}
                  <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
                    <span className="text-[11px] text-slate-400 px-2">เทมเพลต:</span>
                    <button
                      onClick={() => handleApplyTemplatePreset('standard')}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px]"
                    >
                      มาตรฐาน
                    </button>
                    <button
                      onClick={() => handleApplyTemplatePreset('strict')}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px]"
                    >
                      เข้มงวด
                    </button>
                    <button
                      onClick={() => handleApplyTemplatePreset('relaxed')}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px]"
                    >
                      ผ่อนปรน
                    </button>
                    <button
                      onClick={() => handleApplyTemplatePreset('population_adjusted')}
                      className="px-2 py-1 rounded bg-indigo-900/60 hover:bg-indigo-800 text-indigo-200 text-[11px] border border-indigo-700/50"
                    >
                      ปรับตามประชากร
                    </button>
                  </div>
                </div>

                {/* Form Sections */}
                <div className="space-y-6">
                  {/* Section 1: PSI & CSI */}
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-3 flex items-center gap-2">
                      <span>📊</span>
                      <span>1. เกณฑ์การเลื่อนของการกระจายตัว (Covariate & Population Drift)</span>
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">PSI ระดับเตือน (Warning)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max="2"
                          value={formConfig.psi_warning}
                          onChange={e => setFormConfig({ ...formConfig, psi_warning: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">PSI ระดับวิกฤต (Critical)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max="2"
                          value={formConfig.psi_critical}
                          onChange={e => setFormConfig({ ...formConfig, psi_critical: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">CSI ระดับเตือน (Warning)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max="2"
                          value={formConfig.csi_warning}
                          onChange={e => setFormConfig({ ...formConfig, csi_warning: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">CSI ระดับวิกฤต (Critical)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max="2"
                          value={formConfig.csi_critical}
                          onChange={e => setFormConfig({ ...formConfig, csi_critical: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Section 2: Model Performance */}
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-3 flex items-center gap-2">
                      <span>🎯</span>
                      <span>2. เกณฑ์ขั้นต่ำประสิทธิภาพแบบจำลอง (Concept Drift & Discrimination)</span>
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">AUC ขั้นต่ำ</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={formConfig.auc_min}
                          onChange={e => setFormConfig({ ...formConfig, auc_min: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">Gini ขั้นต่ำ</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={formConfig.gini_min}
                          onChange={e => setFormConfig({ ...formConfig, gini_min: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">KS ขั้นต่ำ</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={formConfig.ks_min}
                          onChange={e => setFormConfig({ ...formConfig, ks_min: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Section 3: Data Quality & Sensitivity */}
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-3 flex items-center gap-2">
                      <span>🛡️</span>
                      <span>3. คุณภาพข้อมูลและความมีนัยสำคัญ (Data Quality & Significance)</span>
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">เกณฑ์ปัญหาข้อมูล R1b (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={formConfig.dataIssueThresholdRate}
                          onChange={e => setFormConfig({ ...formConfig, dataIssueThresholdRate: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-1 block">สัดส่วนแถวที่ถูกตัดหรือเตือนที่เริ่มทริกเกอร์ R1b</span>
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">ระดับนัยสำคัญ Label Drift (p-value)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.001"
                          max="1"
                          value={formConfig.labelPValueThreshold}
                          onChange={e => setFormConfig({ ...formConfig, labelPValueThreshold: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-1 block">p-value เกณฑ์ตัดสินนัยสำคัญของการเปลี่ยน Bad Rate</span>
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">เตือนเดไซล์เสี่ยงสูงสุด (%pts)</label>
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          max="100"
                          value={formConfig.decileAlertThresholdPctPoints}
                          onChange={e => setFormConfig({ ...formConfig, decileAlertThresholdPctPoints: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-indigo-500 outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-1 block">ส่วนต่างสัดส่วนกลุ่มความเสี่ยงสูงสุดเทียบ Reference</span>
                      </div>
                    </div>
                  </div>

                  {/* Section 4: Trigger Rule Toggles */}
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-3 flex items-center gap-2">
                      <span>⚙️</span>
                      <span>4. เปิด/ปิดกฎการตัดสินใจ (Trigger Rules Toggle)</span>
                    </h3>
                    <div className="space-y-3 bg-slate-950 p-4 rounded-xl border border-slate-800">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formConfig.enabledRules?.R1b ?? true}
                          onChange={e => setFormConfig({
                            ...formConfig,
                            enabledRules: { ...formConfig.enabledRules, R1b: e.target.checked },
                          })}
                          className="mt-0.5 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-0"
                        />
                        <div>
                          <span className="text-xs font-semibold text-slate-200">กฎ R1b — ตรวจสอบคุณภาพข้อมูล (INVESTIGATE_DATA)</span>
                          <p className="text-[11px] text-slate-400">
                            เตือนเมื่อพบปัญหาข้อมูลหรือการตัดแถวเกินเกณฑ์สัดส่วนที่กำหนด เพื่อให้ตรวจสอบระบบต้นทางก่อนใช้ผล
                          </p>
                        </div>
                      </label>

                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formConfig.enabledRules?.R5 ?? true}
                          onChange={e => setFormConfig({
                            ...formConfig,
                            enabledRules: { ...formConfig.enabledRules, R5: e.target.checked },
                          })}
                          className="mt-0.5 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-0"
                        />
                        <div>
                          <span className="text-xs font-semibold text-slate-200">กฎ R5 — ปรับเทียบแบบจำลอง (RECALIBRATE)</span>
                          <p className="text-[11px] text-slate-400">
                            แนะนำปรับเทียบ (Recalibrate) เมื่ออัตราหนี้เสียเปลี่ยนแต่ความสามารถจัดอันดับของโมเดลยังคงดี
                          </p>
                        </div>
                      </label>

                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formConfig.enabledRules?.R8 ?? true}
                          onChange={e => setFormConfig({
                            ...formConfig,
                            enabledRules: { ...formConfig.enabledRules, R8: e.target.checked },
                          })}
                          className="mt-0.5 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-0"
                        />
                        <div>
                          <span className="text-xs font-semibold text-slate-200">กฎ R8 — เฝ้าระวังอย่างใกล้ชิด (MONITOR_CLOSELY)</span>
                          <p className="text-[11px] text-slate-400">
                            แนะนำติดตามผลในรอบถัดไปอย่างใกล้ชิดเมื่อพบสัญญาณเตือนระดับเฝ้าระวัง (Warning)
                          </p>
                        </div>
                      </label>

                      <label className="flex items-start gap-3 cursor-pointer p-2.5 rounded-lg bg-indigo-950/30 border border-indigo-500/30">
                        <input
                          type="checkbox"
                          checked={formConfig.enabledRules?.R5b ?? false}
                          onChange={e => setFormConfig({
                            ...formConfig,
                            enabledRules: { ...formConfig.enabledRules, R5b: e.target.checked },
                          })}
                          className="mt-0.5 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-0"
                        />
                        <div>
                          <span className="text-xs font-bold text-indigo-300">
                            กฎ R5b — ปรับตามประชากร (MONITOR_CLOSELY: Population Shift)
                          </span>
                          <p className="text-[11px] text-indigo-200/80 mt-0.5">
                            เมื่อ Bad Rate เปลี่ยนแปลง แต่ยังสอดคล้องกับค่าคาดหมายตามช่วงคะแนนของโมเดล (Score Adjusted p-value ≥ เกณฑ์)
                            ระบบจะแนะนำ MONITOR_CLOSELY แทนการ RECALIBRATE เนื่องจากเป็นการเปลี่ยนแปลงของกลุ่มประชากรลูกค้า ไม่ใช่ความสัมพันธ์ของโมเดลเสื่อมถอย
                          </p>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Form Action Buttons */}
                <div className="pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setDialogAuthor('');
                        setDialogReason('');
                        setDialogAction('save_revision');
                      }}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1.5"
                    >
                      <span>💾</span>
                      <span>บันทึกเป็น Revision ใหม่</span>
                    </button>

                    {activeRuleSet?.setId !== selectedRuleSet.id && (
                      <button
                        onClick={() => {
                          setDialogAuthor('');
                          setDialogReason('');
                          setDialogAction('activate');
                        }}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1.5"
                      >
                        <span>⚡</span>
                        <span>เปิดใช้งานชุดกฎนี้ (Activate)</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSimulate}
                      disabled={isSimulating}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-indigo-500/30 rounded-lg text-xs font-medium transition flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <span>🔬</span>
                      <span>{isSimulating ? 'กำลังจำลอง...' : 'ลองกฎนี้กับรอบที่ผ่านมา (Simulation)'}</span>
                    </button>

                    {selectedRuleSet.revisions?.length > 1 && (
                      <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
                        <select
                          value={targetRevisionForRevert}
                          onChange={e => setTargetRevisionForRevert(parseInt(e.target.value, 10))}
                          className="bg-transparent text-slate-300 text-xs outline-none px-1"
                        >
                          {selectedRuleSet.revisions.map(r => (
                            <option key={r.revision} value={r.revision} className="bg-slate-900">
                              rev {r.revision} ({new Date(r.createdAt).toLocaleDateString('th-TH')})
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => {
                            setDialogAuthor('');
                            setDialogReason('');
                            setDialogAction('revert');
                          }}
                          className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs font-medium"
                        >
                          ↩️ ย้อนกลับ
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Simulation Result Drawer / Table */}
                {simResults && (
                  <div className="mt-6 pt-6 border-t border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                        <span>🧪</span>
                        <span>ผลการจำลองกฎกับรอบข้อมูลในอดีต ({simResults.length} รอบ)</span>
                      </h3>
                      <button
                        onClick={() => setSimResults(null)}
                        className="text-xs text-slate-400 hover:text-white"
                      >
                        ปิดหน้าต่างจำลอง ✕
                      </button>
                    </div>

                    <div className="border border-slate-800 rounded-xl overflow-hidden text-xs">
                      <table className="w-full text-left">
                        <thead className="bg-slate-950 text-slate-400 font-mono text-[11px] border-b border-slate-800">
                          <tr>
                            <th className="p-2.5">งวด/ไฟล์</th>
                            <th className="p-2.5">Action เดิม</th>
                            <th className="p-2.5">Action จำลอง</th>
                            <th className="p-2.5">กฎเดิม → จำลอง</th>
                            <th className="p-2.5">สถานะ</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60 bg-slate-900/40 font-mono text-[11px]">
                          {simResults.map(item => (
                            <tr key={item.runId} className={item.changed ? 'bg-indigo-950/20' : ''}>
                              <td className="p-2.5">
                                <div className="text-slate-200 font-sans font-medium">{item.period || 'ไม่ระบุงวด'}</div>
                                <div className="text-[10px] text-slate-400 truncate max-w-[200px]" title={item.fileName}>
                                  {item.fileName}
                                </div>
                              </td>
                              <td className="p-2.5 text-slate-300">{item.actualAction}</td>
                              <td className="p-2.5 font-bold text-indigo-300">{item.simulatedAction}</td>
                              <td className="p-2.5">
                                <span className="text-slate-400">{item.actualRuleId || '-'}</span>
                                <span className="text-slate-500 mx-1">→</span>
                                <span className="text-indigo-400 font-bold">{item.simulatedRuleId || '-'}</span>
                              </td>
                              <td className="p-2.5">
                                {item.changed ? (
                                  <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                    ⚡ ผลเปลี่ยน
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400">
                                    เหมือนเดิม
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center text-slate-400">
                กรุณาเลือกชุดกฎทางซ้ายมือเพื่อดูหรือแก้ไข
              </div>
            )}

            {/* Audit History Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <span>📜</span>
                    <span>ประวัติการเปลี่ยนแปลงและการตรวจสอบ (Audit Trail)</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    บันทึกประวัติการสร้าง แก้ไข เปิดใช้งาน และย้อนกลับ พร้อม Diff รายฟิลด์
                  </p>
                </div>
                <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                  {auditLogs.length} รายการ
                </span>
              </div>

              {auditLogs.length === 0 ? (
                <div className="text-center py-6 text-xs text-slate-500">
                  ยังไม่มีประวัติการเปลี่ยนแปลง
                </div>
              ) : (
                <div className="border border-slate-800 rounded-xl overflow-hidden text-xs">
                  <table className="w-full text-left">
                    <thead className="bg-slate-950 text-slate-400 font-mono text-[11px] border-b border-slate-800">
                      <tr>
                        <th className="p-3">วันเวลา</th>
                        <th className="p-3">ผู้ดำเนินการ</th>
                        <th className="p-3">การกระทำ</th>
                        <th className="p-3">ชุดกฎ / Rev</th>
                        <th className="p-3">เหตุผล</th>
                        <th className="p-3">การเปลี่ยนแปลง (Diffs)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 bg-slate-900/40 text-xs">
                      {auditLogs.map(log => {
                        let actionBadge = 'bg-slate-800 text-slate-300';
                        if (log.action === 'CREATE') actionBadge = 'bg-blue-500/20 text-blue-300 border border-blue-500/30';
                        if (log.action === 'UPDATE') actionBadge = 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30';
                        if (log.action === 'ACTIVATE') actionBadge = 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
                        if (log.action === 'REVERT') actionBadge = 'bg-amber-500/20 text-amber-300 border border-amber-500/30';

                        return (
                          <tr key={log.id} className="hover:bg-slate-800/30">
                            <td className="p-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                              {new Date(log.timestamp).toLocaleString('th-TH')}
                            </td>
                            <td className="p-3 font-semibold text-slate-200 whitespace-nowrap">
                              {log.author}
                            </td>
                            <td className="p-3 whitespace-nowrap">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${actionBadge}`}>
                                {log.action}
                              </span>
                            </td>
                            <td className="p-3 whitespace-nowrap">
                              <span className="text-slate-200">{log.setName}</span>
                              <span className="text-slate-400 font-mono text-[11px] ml-1.5">r{log.revision}</span>
                            </td>
                            <td className="p-3 text-slate-300 max-w-xs break-words">
                              {log.reason}
                            </td>
                            <td className="p-3 text-[11px] text-slate-400">
                              {log.diffs && log.diffs.length > 0 ? (
                                <ul className="space-y-1">
                                  {log.diffs.map((d, i) => (
                                    <li key={i} className="font-mono text-[11px]">
                                      <span className="text-slate-300 font-sans">{d.label}: </span>
                                      <span className="text-rose-400 line-through mr-1">{String(d.oldValue ?? 'None')}</span>
                                      <span className="text-slate-500">→</span>
                                      <span className="text-emerald-400 ml-1">{String(d.newValue)}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <span className="text-slate-600">-</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Modal for Author & Reason */}
      {dialogAction && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <span>✍️</span>
              <span>
                {dialogAction === 'create_set' && 'สร้างชุดกฎใหม่'}
                {dialogAction === 'save_revision' && 'บันทึกเป็น Revision ใหม่'}
                {dialogAction === 'activate' && 'เปิดใช้งานชุดกฎ (Activate)'}
                {dialogAction === 'revert' && `ย้อนกลับไปยัง Revision ${targetRevisionForRevert}`}
              </span>
            </h3>

            {dialogAction === 'create_set' && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-300 block mb-1">ชื่อชุดกฎ *</label>
                  <input
                    type="text"
                    value={newSetName}
                    onChange={e => setNewSetName(e.target.value)}
                    placeholder="เช่น เกณฑ์เฉพาะแคมเปญใหม่"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-white outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-300 block mb-1">คำอธิบาย</label>
                  <textarea
                    rows={2}
                    value={newSetDesc}
                    onChange={e => setNewSetDesc(e.target.value)}
                    placeholder="คำอธิบายวัตถุประสงค์ของชุดกฎนี้..."
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-white outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-300 block mb-1">
                  ชื่อผู้ดำเนินการ (Required) *
                </label>
                <input
                  type="text"
                  value={dialogAuthor}
                  onChange={e => setDialogAuthor(e.target.value)}
                  placeholder="กรอกชื่อ-นามสกุล หรือ รหัสพนักงาน"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-white outline-none focus:border-indigo-500"
                />
                <span className="text-[10px] text-slate-500 mt-0.5 block">
                  เนื่องจากระบบยังไม่มีระบบ Login แยก ระบบจึงบันทึกชื่อตามที่กรอกลง Audit Trail
                </span>
              </div>

              <div>
                <label className="text-xs text-slate-300 block mb-1">
                  เหตุผลในการดำเนินการ (Required) *
                </label>
                <textarea
                  rows={3}
                  value={dialogReason}
                  onChange={e => setDialogReason(e.target.value)}
                  placeholder="ระบุเหตุผล เช่น ทบทวนเกณฑ์ประจำไตรมาส, ปรับเกณฑ์เตือนตามมติคณะกรรมการความเสี่ยง..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-white outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                onClick={() => setDialogAction(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium"
              >
                ยกเลิก
              </button>
              <button
                onClick={executeConfirmedAction}
                disabled={!dialogAuthor.trim() || !dialogReason.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold disabled:opacity-40"
              >
                ยืนยันการบันทึก
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
