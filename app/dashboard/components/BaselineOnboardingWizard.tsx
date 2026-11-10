'use client';
/**
 * BaselineOnboardingWizard (Step 10c.B)
 *
 * 5-Step interactive wizard for onboarding new models / baseline versions:
 *   Step 1: Upload dataset (CSV / .xlsx) + Mode Selection (Scorecard vs External Score)
 *   Step 2: Column Role Mapping (id, date, label, score, feature, ignore) + Heuristic Confidence
 *   Step 3: Model Information & Score Direction (AUC-guided detection) + Scorecard Import
 *   Step 4: Feature Settings (Min/Max, Missing Strategy, Categorical Rare Threshold)
 *   Step 5: Validate Baseline & Activate (Summary, Deciles, Performance AUC/KS, Rules)
 */
import { useState } from 'react';
import type {
  ColumnRole,
  ColumnSuggestion,
  DatasetProfile,
  FeatureSettingSuggestion,
  ScoreDirectionSuggestion,
} from '@/lib/suggest/types';
import type {
  BaselineMode,
  BaselineValidationReport,
  FeatureDataType,
  FeatureDefinition,
  ScoreDirection,
  ScoringConfig,
} from '@/lib/types';

interface WizardInitialData {
  modelId?: string;
  name?: string;
  description?: string;
  mode?: BaselineMode;
  version?: string;
  scoreDirection?: ScoreDirection;
  featureRegistry?: Record<string, FeatureDefinition>;
  scoring?: ScoringConfig | null;
}

interface BaselineOnboardingWizardProps {
  onClose: () => void;
  onSuccess: (modelId: string, version: string, shouldMonitor?: boolean) => void;
  initialData?: WizardInitialData;
}

const ROLES: { role: ColumnRole; label: string; desc: string }[] = [
  { role: 'id', label: 'ID (รหัสแถว)', desc: 'รหัสอ้างอิงของแต่ละแถว (ต้องไม่ซ้ำ)' },
  { role: 'date', label: 'Date (วันที่)', desc: 'วันที่เพื่อติดตามแนวโน้มตามกาลเวลา' },
  { role: 'label', label: 'Label (สถานะเป้าหมาย)', desc: 'ผลลัพธ์จริง (0 = ดี, 1 = หนี้เสีย) สำหรับวัด Performance' },
  { role: 'score', label: 'Score (คะแนน)', desc: 'คะแนนจากโมเดลภายนอก (โหมด External Score)' },
  { role: 'feature', label: 'Feature (ตัวแปร)', desc: 'ตัวแปรที่ใช้ติดตาม Drift และความผิดปกติ' },
  { role: 'ignore', label: 'Ignore (ไม่ใช้)', desc: 'ข้ามคอลัมน์นี้ ไม่นำมาวิเคราะห์' },
];

export default function BaselineOnboardingWizard({
  onClose,
  onSuccess,
  initialData,
}: BaselineOnboardingWizardProps) {
  const [step, setStep] = useState<number>(1);
  const [mode, setMode] = useState<BaselineMode>(initialData?.mode ?? 'score_column');

  // File & Upload state
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [filePreview, setFilePreview] = useState<{ headers: string[]; rows: string[][] }>({ headers: [], rows: [] });
  const [referenceId, setReferenceId] = useState<string>('');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string>('');

  // Suggestions state
  const [isSuggesting, setIsSuggesting] = useState<boolean>(false);
  const [columnSuggestions, setColumnSuggestions] = useState<ColumnSuggestion[]>([]);
  const [scoreDirSuggestion, setScoreDirSuggestion] = useState<ScoreDirectionSuggestion | null>(null);
  const [datasetProfile, setDatasetProfile] = useState<DatasetProfile | null>(null);

  // Column mapping state: map column name -> role & type
  const [columnMapping, setColumnMapping] = useState<Record<string, { role: ColumnRole; type: FeatureDataType }>>({});

  // Model info state
  const [modelId, setModelId] = useState<string>(initialData?.modelId ?? '');
  const [modelName, setModelName] = useState<string>(initialData?.name ?? '');
  const [description, setDescription] = useState<string>(initialData?.description ?? '');
  const [version, setVersion] = useState<string>(initialData?.version ?? '1.0.0');
  const [scoreDirection, setScoreDirection] = useState<ScoreDirection>(initialData?.scoreDirection ?? 'higher_is_safer');

  // Scorecard state (for scorecard mode)
  const [scorecardConfig, setScorecardConfig] = useState<ScoringConfig | null>(initialData?.scoring ?? null);
  const [scorecardFileName, setScorecardFileName] = useState<string>('');
  const [scorecardImportReport, setScorecardImportReport] = useState<string>('');
  const [isImportingScorecard, setIsImportingScorecard] = useState<boolean>(false);

  // Feature settings state
  const [featureDefs, setFeatureDefs] = useState<Record<string, {
    displayName: string;
    dataType: FeatureDataType;
    minValue?: number;
    maxValue?: number;
    missingStrategy: 'reject' | 'mean' | 'median' | 'mode';
    allowedCategories: string[];
    rareCategoryThreshold: number;
    anomalyTransform?: 'none' | 'log1p';
  }>>({});

  // Step 5: Validation state
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [validationReport, setValidationReport] = useState<BaselineValidationReport | null>(null);
  const [validationError, setValidationError] = useState<string>('');
  const [isActivating, setIsActivating] = useState<boolean>(false);
  const [openMonitoringImmediately, setOpenMonitoringImmediately] = useState<boolean>(true);

  // ── Step 1: File selection and initial parsing ──
  const handleFileChange = async (selected: File) => {
    setFile(selected);
    setFileName(selected.name);
    setUploadError('');

    // Quick client-side preview of the first few rows (if CSV)
    if (selected.name.toLowerCase().endsWith('.csv')) {
      try {
        const text = await selected.text();
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length > 0) {
          const headers = lines[0].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
          const rows = lines.slice(1, 6).map(l => l.split(',').map(s => s.trim().replace(/^"|"$/g, '')));
          setFilePreview({ headers, rows });
        }
      } catch {
        // Fallback for non-text
      }
    } else {
      setFilePreview({ headers: ['(.xlsx file selected — full preview after upload)'], rows: [] });
    }
  };

  // Upload reference & generate suggestions
  const analyzeAndSuggest = async () => {
    if (!file) {
      setUploadError('กรุณาเลือกไฟล์ข้อมูลพัฒนาก่อน');
      return;
    }
    setIsUploading(true);
    setIsSuggesting(true);
    setUploadError('');

    try {
      const tempId = modelId.trim() || 'model_' + Math.random().toString(36).slice(2, 7);
      const generatedRefId = `ref_${tempId}_${Date.now()}`;

      // 1. Upload to /api/registry/references
      const form = new FormData();
      form.append('referenceId', generatedRefId);
      form.append('modelId', tempId);
      form.append('version', version.trim() || '1.0.0');
      form.append('description', `Baseline reference for ${tempId}`);
      form.append('file', file);

      const refRes = await fetch('/api/registry/references', {
        method: 'POST',
        body: form,
      });
      const refData = await refRes.json();
      if (!refRes.ok) {
        throw new Error(refData.error || 'อัปโหลดไฟล์ไม่สำเร็จ');
      }

      setReferenceId(generatedRefId);

      // 2. Request suggestions from /api/registry/suggest
      const sugRes = await fetch('/api/registry/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId: generatedRefId }),
      });
      const sugData = await sugRes.json();
      if (!sugRes.ok) {
        throw new Error(sugData.error || 'ไม่สามารถวิเคราะห์ข้อมูลได้');
      }

      const cols: ColumnSuggestion[] = sugData.columns ?? [];
      setColumnSuggestions(cols);
      setScoreDirSuggestion(sugData.scoreDirection ?? null);
      setDatasetProfile(sugData.profile ?? null);

      if (sugData.scoreDirection?.direction) {
        setScoreDirection(sugData.scoreDirection.direction);
      }

      // Initialize mapping from suggestions
      const initMap: Record<string, { role: ColumnRole; type: FeatureDataType }> = {};
      for (const c of cols) {
        initMap[c.column] = { role: c.role, type: c.type };
      }
      setColumnMapping(initMap);

      // Initialize feature settings from suggestions
      const fDefs: typeof featureDefs = {};
      for (const fs of (sugData.featureSettings as FeatureSettingSuggestion[] ?? [])) {
        fDefs[fs.feature] = {
          displayName: fs.feature,
          dataType: fs.dataType,
          minValue: fs.minValue ?? undefined,
          maxValue: fs.maxValue ?? undefined,
          missingStrategy: (fs.missingStrategy === 'fillMean' ? 'mean' : fs.missingStrategy === 'fillMedian' ? 'median' : fs.missingStrategy === 'fillMode' ? 'mode' : 'reject'),
          allowedCategories: fs.categories ?? [],
          rareCategoryThreshold: 0.01,
          anomalyTransform: fs.anomalyTransform,
        };
      }
      setFeatureDefs(fDefs);

      // Auto-set suggested model name if empty
      if (!modelName) {
        setModelName(`โมเดล ${tempId}`);
      }
      if (!modelId) {
        setModelId(tempId);
      }

      // Advance to step 2
      setStep(2);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
      setIsSuggesting(false);
    }
  };

  // ── Step 2 helpers: column conflicts ──
  const mappedRoles = Object.values(columnMapping).map(m => m.role);
  const idCount = mappedRoles.filter(r => r === 'id').length;
  const scoreCount = mappedRoles.filter(r => r === 'score').length;
  const labelCount = mappedRoles.filter(r => r === 'label').length;
  const featureCount = mappedRoles.filter(r => r === 'feature').length;

  const mappingWarnings: string[] = [];
  if (idCount === 0) mappingWarnings.push('ยังไม่ได้กำหนดคอลัมน์ ID (รหัสแถว) — ระบบจะใช้แถวเป็น ID');
  if (idCount > 1) mappingWarnings.push(`พบคอลัมน์ ID มากกว่า 1 คอลัมน์ (${idCount} คอลัมน์) — ควรมีเพียง 1 ตัว`);
  if (featureCount === 0) mappingWarnings.push('ต้องมีอย่างน้อย 1 คอลัมน์ที่เป็น Feature เพื่อใช้ติดตาม Drift');
  if (mode === 'score_column' && scoreCount === 0) {
    mappingWarnings.push('โหมด External Score จำเป็นต้องมีคอลัมน์ Score 1 คอลัมน์');
  }

  // Update role of a column
  const setColRole = (col: string, newRole: ColumnRole) => {
    setColumnMapping(prev => ({
      ...prev,
      [col]: { ...prev[col], role: newRole },
    }));

    // If new role is feature and not in featureDefs, add it
    if (newRole === 'feature' && !featureDefs[col]) {
      const summary = datasetProfile?.columns.find(c => c.column === col);
      const isNum = summary?.inferredType === 'numeric';
      setFeatureDefs(prev => ({
        ...prev,
        [col]: {
          displayName: col,
          dataType: isNum ? 'numeric' : 'categorical',
          missingStrategy: 'reject',
          allowedCategories: summary?.categories ? [...summary.categories] : [],
          rareCategoryThreshold: 0.01,
        },
      }));
    }
  };

  // ── Step 3 helpers: Scorecard import ──
  const handleScorecardUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const scFile = e.target.files?.[0];
    if (!scFile) return;
    setScorecardFileName(scFile.name);
    setIsImportingScorecard(true);
    setScorecardImportReport('');

    try {
      const form = new FormData();
      form.append('file', scFile);
      if (referenceId) form.append('referenceId', referenceId);

      const res = await fetch('/api/registry/scorecard/import', {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'นำเข้า Scorecard ไม่สำเร็จ');
      }

      setScorecardConfig(data.scoring);
      const rep: string[] = [`นำเข้าสำเร็จ: ${data.scoring.features.length} ตัวแปร, base points = ${data.scoring.base_points}`];
      if (data.scoreComparison) {
        rep.push(`เทียบกับ Reference: ตรงกัน ${data.scoreComparison.matchWithinHalfPointPct}% (ต่างสูงสุด ${data.scoreComparison.maxAbsDiff} pt)`);
      }
      if (data.warnings?.length) {
        rep.push(`คำเตือน: ${data.warnings.join('; ')}`);
      }
      setScorecardImportReport(rep.join(' | '));
    } catch (err: unknown) {
      setScorecardImportReport(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsImportingScorecard(false);
    }
  };

  // ── Step 5: Validate Baseline ──
  const handleValidate = async () => {
    setIsValidating(true);
    setValidationError('');
    setValidationReport(null);

    try {
      const cleanModelId = modelId.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const cleanVersion = version.trim() || '1.0.0';

      // 1. Ensure Model exists via POST /api/registry/models
      await fetch('/api/registry/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: cleanModelId,
          name: modelName.trim() || cleanModelId,
          description: description.trim(),
          mode,
          scoreDirection,
        }),
      }).catch(() => { /* may already exist */ });

      // Build column resolution
      let idCol: string | undefined;
      let dateCol: string | undefined;
      let labelCol: string | undefined;
      let scoreCol: string | undefined;
      const features: string[] = [];

      for (const [col, m] of Object.entries(columnMapping)) {
        if (m.role === 'id') idCol = col;
        else if (m.role === 'date') dateCol = col;
        else if (m.role === 'label') labelCol = col;
        else if (m.role === 'score') scoreCol = col;
        else if (m.role === 'feature') features.push(col);
      }

      // Build featureRegistry payload
      const registryPayload: Record<string, FeatureDefinition> = {};
      for (const f of features) {
        const def = featureDefs[f];
        if (!def) continue;
        const missingStrat = def.missingStrategy === 'mean' ? 'fillMean' : def.missingStrategy === 'median' ? 'fillMedian' : def.missingStrategy === 'mode' ? 'fillMode' : 'reject';
        registryPayload[f] = {
          columnName: f,
          displayName: def.displayName || f,
          dataType: def.dataType,
          required: def.missingStrategy === 'reject',
          monitoringEnabled: true,
          validation: {
            minValue: def.minValue,
            maxValue: def.maxValue,
            missingStrategy: missingStrat,
          },
          ...(def.dataType === 'categorical' ? {
            allowedCategories: def.allowedCategories,
            rareCategoryThreshold: def.rareCategoryThreshold,
          } : {}),
          ...(def.anomalyTransform ? { anomalyTransform: def.anomalyTransform } : {}),
        };
      }

      // 2. Create DRAFT version via POST /api/registry/models/[modelId]/versions
      const draftRes = await fetch(`/api/registry/models/${cleanModelId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: cleanVersion,
          name: modelName.trim() || cleanModelId,
          description: description.trim(),
          referenceId,
          mode,
          scoreDirection,
          columns: {
            idColumn: idCol,
            dateColumn: dateCol,
            labelColumn: labelCol,
            scoreColumn: scoreCol,
          },
          featureRegistry: registryPayload,
          ...(mode === 'scorecard' && scorecardConfig ? { scoring: scorecardConfig } : {}),
        }),
      });

      const draftData = await draftRes.json();
      if (!draftRes.ok) {
        throw new Error(draftData.error || 'สร้างเวอร์ชัน Baseline ไม่สำเร็จ');
      }

      // 3. Call validate baseline via POST /api/registry/models/[modelId]/versions/[version]/validate
      const valRes = await fetch(`/api/registry/models/${cleanModelId}/versions/${cleanVersion}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'onboarding-wizard' }),
      });
      const valData = await valRes.json();
      if (!valRes.ok) {
        throw new Error(valData.error || 'การตรวจสอบ Baseline ล้มเหลว');
      }

      setValidationReport(valData.validationReport);
    } catch (err: unknown) {
      setValidationError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsValidating(false);
    }
  };

  // ── Step 5: Activate Baseline ──
  const handleActivate = async () => {
    setIsActivating(true);
    setValidationError('');

    try {
      const cleanModelId = modelId.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const cleanVersion = version.trim() || '1.0.0';

      const actRes = await fetch(`/api/registry/models/${cleanModelId}/versions/${cleanVersion}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'onboarding-wizard' }),
      });
      const actData = await actRes.json();
      if (!actRes.ok) {
        throw new Error(actData.error || 'เปิดใช้งาน Baseline ไม่สำเร็จ');
      }

      onSuccess(cleanModelId, cleanVersion, openMonitoringImmediately);
    } catch (err: unknown) {
      setValidationError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsActivating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between bg-slate-900/90">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🗂</span>
              <h2 className="text-sm font-bold text-slate-100">
                ลงทะเบียน Baseline โมเดลใหม่ (Baseline Onboarding Wizard)
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              เตรียมไฟล์ข้อมูลพัฒนาโมเดล + คะแนน → ตรวจสอบการแนะนำ → ยืนยันและเปิดใช้งาน
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-lg p-1 transition"
          >
            ✕
          </button>
        </div>

        {/* Step Bar */}
        <div className="border-b border-slate-800 bg-slate-950/60 px-6 py-3">
          <div className="grid grid-cols-5 gap-2 text-center text-xs">
            {[
              { s: 1, title: '1. อัปโหลดไฟล์' },
              { s: 2, title: '2. แมปคอลัมน์' },
              { s: 3, title: '3. ข้อมูลโมเดล' },
              { s: 4, title: '4. ตั้งค่าตัวแปร' },
              { s: 5, title: '5. ตรวจสอบ & บันทึก' },
            ].map(({ s, title }) => (
              <div
                key={s}
                className={`py-1.5 px-2 rounded-lg border text-xs font-semibold transition-all ${
                  step === s
                    ? 'bg-indigo-600/20 border-indigo-500/60 text-indigo-300'
                    : step > s
                    ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5'
                    : 'border-slate-800 text-slate-500'
                }`}
              >
                {title}
              </div>
            ))}
          </div>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* ══════════════════════════════════════════════════════════
              STEP 1: Upload & Mode
          ══════════════════════════════════════════════════════════ */}
          {step === 1 && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Mode Selector */}
                <div
                  onClick={() => setMode('score_column')}
                  className={`p-4 rounded-xl border cursor-pointer transition ${
                    mode === 'score_column'
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-slate-800 hover:border-slate-700 bg-slate-950/40'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base">📊</span>
                    <h3 className="text-xs font-bold text-slate-200">External Score (มีคอลัมน์คะแนน)</h3>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    โมเดล Machine Learning สมัยใหม่ (GBM, XGBoost, Neural Net) ที่คำนวณคะแนนมาจากภายนอกและมีคอลัมน์คะแนนระบุอยู่ในไฟล์
                  </p>
                </div>

                <div
                  onClick={() => setMode('scorecard')}
                  className={`p-4 rounded-xl border cursor-pointer transition ${
                    mode === 'scorecard'
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-slate-800 hover:border-slate-700 bg-slate-950/40'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base">📋</span>
                    <h3 className="text-xs font-bold text-slate-200">Scorecard (มีตารางคะแนน)</h3>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    โมเดล Credit Scorecard แบบดั้งเดิม (Logistic Regression + WOE bins) ที่ระบบเป็นผู้คำนวณคะแนนเองตามตาราง Scorecard
                  </p>
                </div>
              </div>

              {/* Drag and drop file area */}
              <div
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault();
                  if (e.dataTransfer.files?.[0]) handleFileChange(e.dataTransfer.files[0]);
                }}
                className="border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-2xl p-8 text-center bg-slate-950/30 transition"
              >
                <div className="text-4xl mb-3">📁</div>
                <h4 className="text-sm font-semibold text-slate-200 mb-1">
                  ลากไฟล์ CSV หรือ .xlsx มาวางที่นี่
                </h4>
                <p className="text-xs text-slate-500 mb-4">
                  ขนาดไฟล์ไม่เกิน 4 MB (ระบบแนะนำ: samples/baseline_ext_model.csv)
                </p>
                <label className="inline-block px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl cursor-pointer transition">
                  เลือกไฟล์จากเครื่อง
                  <input
                    type="file"
                    accept=".csv,.xlsx"
                    onChange={e => {
                      if (e.target.files?.[0]) handleFileChange(e.target.files[0]);
                    }}
                    className="hidden"
                  />
                </label>
                {fileName && (
                  <p className="text-xs text-indigo-400 font-mono mt-3">
                    ไฟล์ที่เลือก: {fileName}
                  </p>
                )}
              </div>

              {/* Quick file preview */}
              {filePreview.headers.length > 0 && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-300">ตัวอย่างข้อมูล 5 แถวแรก</span>
                    <span className="text-slate-500 font-mono">
                      {filePreview.headers.length} คอลัมน์
                    </span>
                  </div>
                  <div className="overflow-x-auto max-h-48">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          {filePreview.headers.map((h, i) => (
                            <th key={i} className="pb-1 text-left px-2 font-mono whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filePreview.rows.map((r, ri) => (
                          <tr key={ri} className="border-b border-slate-800/40 text-slate-300">
                            {r.map((cell, ci) => (
                              <td key={ci} className="py-1 px-2 font-mono whitespace-nowrap">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {uploadError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                  ❌ {uploadError}
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button
                  onClick={analyzeAndSuggest}
                  disabled={!file || isUploading || isSuggesting}
                  className="px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-indigo-500/20 transition disabled:opacity-50"
                >
                  {isSuggesting ? '🤖 กำลังวิเคราะห์ข้อมูล...' : '🤖 วิเคราะห์และแนะนำอัตโนมัติ →'}
                </button>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════
              STEP 2: Column Role Mapping
          ══════════════════════════════════════════════════════════ */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-slate-200">ตรวจสอบและยืนยันบทบาทของคอลัมน์</h3>
                  <p className="text-[11px] text-slate-400">
                    ระบบวิเคราะห์ด้วย Heuristic Provider และเดาบทบาทให้ล่วงหน้า สามารถปรับเปลี่ยนได้
                  </p>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-indigo-500/40 text-indigo-300 bg-indigo-500/10">
                  Provider: heuristic (regex + stats + AUC)
                </span>
              </div>

              {/* Warnings / Conflicts */}
              {mappingWarnings.length > 0 && (
                <div className="space-y-1 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
                  {mappingWarnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <span>⚠️</span>
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Column Mapping Table */}
              <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 bg-slate-900/60 text-left">
                      <th className="py-2.5 px-3">ชื่อคอลัมน์</th>
                      <th className="py-2.5 px-3">ชนิดที่ตรวจพบ</th>
                      <th className="py-2.5 px-3">บทบาท (Role)</th>
                      <th className="py-2.5 px-3">ความมั่นใจ & เหตุผล</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(columnMapping).map(([col, mapping]) => {
                      const sug = columnSuggestions.find(s => s.column === col);
                      const conf = sug?.confidence ?? 0.5;
                      const confColor =
                        conf >= 0.8
                          ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
                          : 'border-amber-500/40 text-amber-300 bg-amber-500/10';

                      return (
                        <tr key={col} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-200">{col}</td>
                          <td className="py-2.5 px-3 text-slate-400 font-mono text-[11px]">{mapping.type}</td>
                          <td className="py-2.5 px-3">
                            <select
                              value={mapping.role}
                              onChange={e => setColRole(col, e.target.value as ColumnRole)}
                              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 outline-none"
                            >
                              {ROLES.map(r => (
                                <option key={r.role} value={r.role}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-2">
                              <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${confColor}`}>
                                {(conf * 100).toFixed(0)}%
                              </span>
                              <span className="text-[11px] text-slate-400 truncate max-w-xs" title={sug?.reason}>
                                {sug?.reason || 'กำหนดโดยผู้ใช้'}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-between pt-2">
                <button
                  onClick={() => setStep(1)}
                  className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 font-semibold rounded-xl text-xs transition"
                >
                  ← ย้อนกลับ
                </button>
                <button
                  onClick={() => setStep(3)}
                  disabled={featureCount === 0 || (mode === 'score_column' && scoreCount === 0)}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition disabled:opacity-50"
                >
                  ถัดไป (ข้อมูลโมเดล) →
                </button>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════
              STEP 3: Model Information & Score Direction
          ══════════════════════════════════════════════════════════ */}
          {step === 3 && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold">
                    Model ID (ภาษาอังกฤษ ตัวพิมพ์เล็ก ตัวเลข และขีดล่าง)
                  </label>
                  <input
                    type="text"
                    value={modelId}
                    onChange={e => setModelId(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                    placeholder="เช่น car_loan_v2, ext_risk_gbm"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold">เวอร์ชัน Baseline (Semver)</label>
                  <input
                    type="text"
                    value={version}
                    onChange={e => setVersion(e.target.value)}
                    placeholder="1.0.0"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold">ชื่อโมเดลภาษาไทย</label>
                  <input
                    type="text"
                    value={modelName}
                    onChange={e => setModelName(e.target.value)}
                    placeholder="เช่น โมเดลสินเชื่อบุคคลภายนอก v1"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-semibold">คำอธิบาย</label>
                  <input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="คำอธิบายโมเดลและที่มาของชุดข้อมูลพัฒนา"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Score Direction Card */}
              <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">🎯</span>
                    <h4 className="text-xs font-bold text-slate-200">ทิศทางของคะแนน (Score Direction)</h4>
                  </div>
                  {scoreDirSuggestion && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 bg-emerald-500/10">
                      AUC = {scoreDirSuggestion.auc.toFixed(3)} ({scoreDirSuggestion.auc >= 0.65 ? 'แนะนำ' : 'ควรตรวจ'})
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-slate-400">
                  {scoreDirSuggestion?.reason || 'เลือกทิศทางคะแนนตามธรรมชาติของโมเดล (คะแนนสูง = เสี่ยงต่ำ หรือคะแนนสูง = เสี่ยงสูง)'}
                </p>

                <div className="flex gap-3">
                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="radio"
                      name="scoreDirection"
                      checked={scoreDirection === 'higher_is_safer'}
                      onChange={() => setScoreDirection('higher_is_safer')}
                    />
                    <span>คะแนนสูง = เสี่ยงต่ำ (higher_is_safer) เช่น Credit Score 300–850</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="radio"
                      name="scoreDirection"
                      checked={scoreDirection === 'higher_is_riskier'}
                      onChange={() => setScoreDirection('higher_is_riskier')}
                    />
                    <span>คะแนนสูง = เสี่ยงสูง (higher_is_riskier) เช่น PD 0.0–1.0</span>
                  </label>
                </div>
              </div>

              {/* Scorecard Import (only if mode === 'scorecard') */}
              {mode === 'scorecard' && (
                <div className="p-4 rounded-xl border border-indigo-500/30 bg-indigo-500/5 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">📥</span>
                    <h4 className="text-xs font-bold text-indigo-300">อัปโหลดตารางคะแนน Scorecard (CSV / .xlsx)</h4>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    อัปโหลดไฟล์ Scorecard ที่มีคอลัมน์ variable, upper_bound, points, bin_label
                  </p>
                  <div className="flex items-center gap-3">
                    <label className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold rounded-lg cursor-pointer transition">
                      เลือกไฟล์ Scorecard
                      <input
                        type="file"
                        accept=".csv,.xlsx"
                        onChange={handleScorecardUpload}
                        className="hidden"
                      />
                    </label>
                    {scorecardFileName && (
                      <span className="text-xs font-mono text-slate-300">{scorecardFileName}</span>
                    )}
                    {isImportingScorecard && (
                      <span className="text-xs text-indigo-400 animate-pulse">กำลังตรวจสอบตารางคะแนน...</span>
                    )}
                  </div>
                  {scorecardImportReport && (
                    <div className="text-xs text-slate-300 font-mono bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                      {scorecardImportReport}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-between pt-2">
                <button
                  onClick={() => setStep(2)}
                  className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 font-semibold rounded-xl text-xs transition"
                >
                  ← ย้อนกลับ
                </button>
                <button
                  onClick={() => setStep(4)}
                  disabled={!modelId.trim() || (mode === 'scorecard' && !scorecardConfig)}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition disabled:opacity-50"
                >
                  ถัดไป (ตั้งค่าตัวแปร) →
                </button>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════
              STEP 4: Feature Settings
          ══════════════════════════════════════════════════════════ */}
          {step === 4 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-bold text-slate-200">ตั้งค่าเกณฑ์ตรวจจับรายตัวแปร (Feature Settings)</h3>
                <p className="text-[11px] text-slate-400">
                  ระบบเสนอค่าขอบเขต Min/Max ที่ปัดเศษสวยงาม และกลยุทธ์ค่าว่าง สามารถแก้ไขได้ทุกตัว
                </p>
              </div>

              <div className="space-y-3">
                {Object.entries(featureDefs).map(([col, def]) => (
                  <div key={col} className="p-3.5 rounded-xl border border-slate-800 bg-slate-950/40 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-slate-200">{col}</span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-slate-700 text-slate-400">
                          {def.dataType}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-500">ชื่อแสดงผล:</span>
                        <input
                          type="text"
                          value={def.displayName}
                          onChange={e => {
                            const val = e.target.value;
                            setFeatureDefs(prev => ({
                              ...prev,
                              [col]: { ...prev[col], displayName: val },
                            }));
                          }}
                          className="bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-300 w-36 outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>

                    {/* Numeric fields */}
                    {def.dataType === 'numeric' && (
                      <div className="grid grid-cols-4 gap-3 text-xs">
                        <div>
                          <label className="text-[10px] text-slate-500 block mb-0.5">Min (ขอบล่าง)</label>
                          <input
                            type="number"
                            value={def.minValue ?? ''}
                            onChange={e => {
                              const v = e.target.value === '' ? undefined : Number(e.target.value);
                              setFeatureDefs(prev => ({
                                ...prev,
                                [col]: { ...prev[col], minValue: v },
                              }));
                            }}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-emerald-400 outline-none focus:border-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-500 block mb-0.5">Max (ขอบบน)</label>
                          <input
                            type="number"
                            value={def.maxValue ?? ''}
                            onChange={e => {
                              const v = e.target.value === '' ? undefined : Number(e.target.value);
                              setFeatureDefs(prev => ({
                                ...prev,
                                [col]: { ...prev[col], maxValue: v },
                              }));
                            }}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-emerald-400 outline-none focus:border-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-500 block mb-0.5">Missing Strategy</label>
                          <select
                            value={def.missingStrategy}
                            onChange={e => {
                              const v = e.target.value as 'reject' | 'mean' | 'median' | 'mode';
                              setFeatureDefs(prev => ({
                                ...prev,
                                [col]: { ...prev[col], missingStrategy: v },
                              }));
                            }}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 outline-none focus:border-indigo-500"
                          >
                            <option value="reject">Reject (ห้ามว่าง)</option>
                            <option value="mean">Mean (แทนด้วยค่าเฉลี่ย)</option>
                            <option value="median">Median (แทนด้วยมัธยฐาน)</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-500 block mb-0.5">Transform</label>
                          <select
                            value={def.anomalyTransform ?? 'none'}
                            onChange={e => {
                              const v = e.target.value as 'none' | 'log1p';
                              setFeatureDefs(prev => ({
                                ...prev,
                                [col]: { ...prev[col], anomalyTransform: v },
                              }));
                            }}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 outline-none focus:border-indigo-500"
                          >
                            <option value="none">None (เส้นตรง)</option>
                            <option value="log1p">Log1p (เบ้ขวามาก)</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {/* Categorical fields */}
                    {def.dataType === 'categorical' && (
                      <div className="space-y-2 text-xs">
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500 text-[10px]">เกณฑ์หมวดหายาก (Rare Threshold):</span>
                          <input
                            type="number"
                            step="0.005"
                            value={def.rareCategoryThreshold}
                            onChange={e => {
                              const v = Number(e.target.value);
                              setFeatureDefs(prev => ({
                                ...prev,
                                [col]: { ...prev[col], rareCategoryThreshold: v },
                              }));
                            }}
                            className="w-20 bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono text-slate-200 outline-none focus:border-indigo-500"
                          />
                          <span className="text-slate-500 text-[10px]">
                            (หมวดที่พบน้อยกว่านี้จะรวมเป็น __OTHER__)
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 text-[10px] block mb-1">หมวดหมู่ที่พบใน Reference:</span>
                          <div className="flex flex-wrap gap-1">
                            {def.allowedCategories.map(cat => (
                              <span key={cat} className="text-[10px] font-mono px-2 py-0.5 rounded border border-slate-700 text-slate-300 bg-slate-900">
                                {cat}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex justify-between pt-2">
                <button
                  onClick={() => setStep(3)}
                  className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 font-semibold rounded-xl text-xs transition"
                >
                  ← ย้อนกลับ
                </button>
                <button
                  onClick={() => {
                    setStep(5);
                    handleValidate();
                  }}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition"
                >
                  ถัดไป (ตรวจสอบ & เปิดใช้งาน) →
                </button>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════
              STEP 5: Validate & Activate
          ══════════════════════════════════════════════════════════ */}
          {step === 5 && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-slate-200">ตรวจสอบความถูกต้องของ Baseline (Validation)</h3>
                  <p className="text-[11px] text-slate-400">
                    ทดสอบคำนวณสถิติ, ขอบเขต Decile และประสิทธิภาพบนชุดข้อมูลพัฒนา
                  </p>
                </div>
                <button
                  onClick={handleValidate}
                  disabled={isValidating}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition"
                >
                  {isValidating ? 'กำลังตรวจ...' : '🔍 ตรวจสอบซ้ำ (Re-validate)'}
                </button>
              </div>

              {validationError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                  ❌ {validationError}
                </div>
              )}

              {isValidating && !validationReport && (
                <div className="py-12 text-center text-slate-400 text-xs animate-pulse">
                  กำลังคำนวณสถิติและทดสอบ Baseline กับ Reference...
                </div>
              )}

              {validationReport && (
                <div className="space-y-4">
                  {/* Status Banner */}
                  <div
                    className={`p-3.5 rounded-xl border flex items-center justify-between ${
                      validationReport.ok
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                        : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-base">{validationReport.ok ? '✅' : '❌'}</span>
                      <span className="text-xs font-bold">
                        {validationReport.ok
                          ? 'Baseline ผ่านการตรวจสอบเรียบร้อย (สถานะ: VALIDATED)'
                          : 'พบข้อผิดพลาดในการตรวจสอบ Baseline'}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono">
                      {validationReport.computed.rowCount.toLocaleString()} แถว
                    </span>
                  </div>

                  {/* Errors / Warnings */}
                  {validationReport.errors.length > 0 && (
                    <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs space-y-1">
                      <span className="font-bold block">ข้อผิดพลาดที่ต้องแก้ไข:</span>
                      {validationReport.errors.map((e, i) => (
                        <p key={i}>• {e.message}</p>
                      ))}
                    </div>
                  )}

                  {validationReport.warnings.length > 0 && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs space-y-1">
                      <span className="font-bold block">ข้อสังเกต / คำเตือน:</span>
                      {validationReport.warnings.map((w, i) => (
                        <p key={i}>• {w.message}</p>
                      ))}
                    </div>
                  )}

                  {/* Summary Performance */}
                  {validationReport.computed.performance && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-2">
                      <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                        📈 Baseline Performance (บน Reference)
                      </span>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-slate-900 rounded-lg p-2 text-center">
                          <p className="text-[9px] text-slate-500">AUC</p>
                          <p className="text-sm font-bold font-mono text-emerald-400">
                            {validationReport.computed.performance.auc.toFixed(3)}
                          </p>
                        </div>
                        <div className="bg-slate-900 rounded-lg p-2 text-center">
                          <p className="text-[9px] text-slate-500">KS</p>
                          <p className="text-sm font-bold font-mono text-emerald-400">
                            {validationReport.computed.performance.ks.toFixed(3)}
                          </p>
                        </div>
                        <div className="bg-slate-900 rounded-lg p-2 text-center">
                          <p className="text-[9px] text-slate-500">Gini</p>
                          <p className="text-sm font-bold font-mono text-emerald-400">
                            {validationReport.computed.performance.gini.toFixed(3)}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Score Decile Boundaries */}
                  {validationReport.computed.autoGeneratedBins && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-2">
                      <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">
                        📊 Score Decile Boundaries (10 ช่วง)
                      </span>
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {(validationReport.computed.autoGeneratedBins.score?.boundaries ?? []).map((b, bi) => (
                          <span key={bi} className="text-[10px] font-mono px-2 py-0.5 rounded border border-indigo-500/30 text-indigo-300 bg-indigo-500/10">
                            p{(bi + 1) * 10}: {b.toFixed(2)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Option to monitor immediately */}
                  <label className="flex items-center gap-2 text-xs text-slate-300 pt-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={openMonitoringImmediately}
                      onChange={e => setOpenMonitoringImmediately(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-900"
                    />
                    <span>เปิดแท็บ Monitoring ทันทีหลังเปิดใช้งานโมเดลนี้</span>
                  </label>
                </div>
              )}

              <div className="flex justify-between pt-2">
                <button
                  onClick={() => setStep(4)}
                  className="px-4 py-2 border border-slate-700 hover:bg-slate-800 text-slate-300 font-semibold rounded-xl text-xs transition"
                >
                  ← ย้อนกลับ
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const cleanModelId = modelId.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
                      const cleanVersion = version.trim() || '1.0.0';
                      onSuccess(cleanModelId, cleanVersion, false);
                    }}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-bold rounded-xl text-xs transition"
                  >
                    💾 บันทึกเป็น DRAFT
                  </button>
                  <button
                    onClick={handleActivate}
                    disabled={!validationReport?.ok || isActivating}
                    className="px-6 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-500/20 transition disabled:opacity-40"
                  >
                    {isActivating ? 'กำลังเปิดใช้งาน...' : '🚀 บันทึกและเปิดใช้งาน (Activate)'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
