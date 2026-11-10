/**
 * Repositories — the single source of truth for KV & Blob storage keys.
 *
 * Includes:
 *   - Baseline Registry & Model Lifecycle (`registry:models`, `registry:model:<id>:versions`, `registry:default`)
 *   - Built-in model protection (`ascore_v1` + `ascore_v1_dev855` are immutable)
 *   - Legacy threshold overrides (`config:<modelId>:override`)
 *   - Monitoring & Sandbox runs (`runs:<kind>:<modelId>`)
 *   - Trigger events & human review (`events:<modelId>`)
 */
import modelConfigJson from '../../app/model-config.json';
import type {
  BaselineMode,
  BaselineStatus,
  BaselineValidationReport,
  BaselineVersion,
  ExperimentRun,
  ModelMetadata,
  ModelVersionRef,
  MonitoringRun,
  MonitoringThresholds,
  StoredRun,
  TriggerEvent,
  TriggerEventStatus,
  TriggerReviewDecision,
} from '../types';
import { getStore } from './store';
import {
  isBuiltInReferenceId,
  loadReferenceDatasetBlob,
  saveReferenceDatasetBlob,
  type ReferenceDatasetBlob,
} from './blob';
import {
  buildReferenceProfileFromData,
  getReferenceProfile,
  registerReferenceDataset,
  type ReferenceProfile,
} from '../reference';
import { DEFAULT_DATE_COLUMN, DEFAULT_ID_COLUMN, DEFAULT_LABEL_COLUMN } from '../defaults';
import { validateBaseline } from '../baselineValidation';
import { computeDistributionStats } from '../driftReport';
import { calculateAUC, calculateGini, calculateKS, type DataPoint } from '../stats';

const MAX_RUNS = 500;
const MAX_EVENTS = 500;
const knownEventModelIds = new Set<string>(Object.keys((modelConfigJson as any).models ?? {}));

// ─── Storage Keys ───────────────────────────────────────────────────────────
const REGISTRY_MODELS_KEY = 'registry:models';
const REGISTRY_DEFAULT_KEY = 'registry:default';
const registryVersionsKey = (modelId: string) => `registry:model:${modelId}:versions`;
const overrideKey = (modelId: string) => `config:${modelId}:override`;
const runsKey = (kind: StoredRun['kind'], modelId: string) => `runs:${kind}:${modelId}`;
const eventsKey = (modelId: string) => `events:${modelId}`;

export class BuiltInProtectedError extends Error {
  status = 403 as const;
  constructor(message = 'ไม่สามารถแก้ไข เขียนทับ หรือ Archive เวอร์ชันมาตรฐาน (Built-in) ได้') {
    super(message);
    this.name = 'BuiltInProtectedError';
  }
}

export class RegistryError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 422 = 400,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

// ─── Built-in Model & Baseline Conversion ───────────────────────────────────
export interface ConfigOverride {
  configVersion: string;
  updatedAt: string;
  thresholds: MonitoringThresholds;
  history: { version: string; updatedAt: string; note: string }[];
}

type BundledConfig = { activeModelId: string; models: Record<string, any> };
const bundled = modelConfigJson as unknown as BundledConfig;

export function isBuiltInModelId(modelId: string): boolean {
  return Boolean(bundled.models[modelId]);
}

export function isBuiltInBaselineVersion(modelId: string, version: string): boolean {
  const b = bundled.models[modelId];
  if (!b) return false;
  return (b.configVersion ?? '1.1.0') === version;
}

function buildBuiltInModelMetadata(modelId: string): ModelMetadata {
  const b = bundled.models[modelId];
  return {
    modelId: b.id ?? modelId,
    name: b.name ?? modelId,
    description: b.description ?? '',
    type: b.type ?? 'scorecard',
    createdAt: b.createdAt ?? '2026-01-15T00:00:00Z',
    builtIn: true,
  };
}

function buildBuiltInBaselineVersion(modelId: string, archivedByNewerActive = false): BaselineVersion {
  const b = structuredClone(bundled.models[modelId]);
  const version: string = b.configVersion ?? '1.1.0';
  const createdAt: string = b.configCreatedAt ?? b.createdAt ?? '2026-01-15T00:00:00Z';
  const status: BaselineStatus = archivedByNewerActive ? 'ARCHIVED' : 'ACTIVE';
  return {
    modelId: b.id ?? modelId,
    version,
    name: b.name ?? modelId,
    description: b.description ?? '',
    status,
    mode: 'scorecard',
    columns: {
      idColumn: b.idColumn ?? DEFAULT_ID_COLUMN,
      dateColumn: b.dateColumn ?? DEFAULT_DATE_COLUMN,
      labelColumn: b.labelColumn ?? DEFAULT_LABEL_COLUMN,
      scoreColumn: b.scoreColumn ?? null,
    },
    scoreDirection: b.scoreDirection === 'higher_is_riskier' ? 'higher_is_riskier' : 'higher_is_safer',
    featureRegistry: b.featureRegistry ?? {},
    scoring: b.scoring,
    thresholds: b.thresholds,
    anomalyConfig: b.anomalyConfig,
    driftConfig: b.driftConfig,
    triggerConfig: b.triggerConfig,
    riskGrades: b.riskGrades,
    experimentConfig: b.experimentConfig,
    referenceDatasetId: b.referenceDatasetId,
    validationReport: null,
    createdAt,
    createdBy: 'system (built-in)',
    statusHistory: [
      {
        from: null,
        to: 'ACTIVE',
        at: createdAt,
        by: 'system',
        note: 'Initial bundled production baseline',
      },
      ...(archivedByNewerActive
        ? [
            {
              from: 'ACTIVE' as const,
              to: 'ARCHIVED' as const,
              at: new Date().toISOString(),
              by: 'system',
              note: 'Archived automatically because a newer version is ACTIVE',
            },
          ]
        : []),
    ],
    builtIn: true,
  };
}

/**
 * Converts a `BaselineVersion` into the runtime model object consumed by
 * `runMonitoring`, `buildDriftReport`, `evaluateTrigger`, and `runAnomalyScreening`.
 */
export function baselineToModelObject(baseline: BaselineVersion): any {
  const rawBuiltIn = bundled.models[baseline.modelId]
    ? structuredClone(bundled.models[baseline.modelId])
    : {};
  const scoring =
    baseline.mode === 'scorecard' && baseline.scoring
      ? baseline.scoring
      : {
          base_points: 0,
          factor: 1,
          offset: 0,
          features: Object.entries(baseline.featureRegistry ?? {})
            .filter(([, d]) => d.dataType === 'numeric' && d.monitoringEnabled !== false)
            .map(([k]) => k),
          scorecard: {},
        };

  let dynamicBaseline = rawBuiltIn.baseline;
  if (!dynamicBaseline && baseline.referenceDatasetId) {
    try {
      const prof = getReferenceProfile(
        baseline.referenceDatasetId,
        baseline.mode === 'scorecard' ? baseline.scoring : null,
        {
          labelColumn: baseline.columns.labelColumn ?? DEFAULT_LABEL_COLUMN,
          scoreColumn:
            baseline.mode === 'score_column'
              ? (baseline.columns.scoreColumn ?? undefined)
              : undefined,
          featureRegistry: baseline.featureRegistry,
        },
      );
      const feature_stats: Record<string, any> = {};
      for (const [k, vals] of Object.entries(prof.features)) {
        const finite = vals.filter(Number.isFinite);
        if (finite.length === 0) continue;
        const sorted = [...finite].sort((a, b) => a - b);
        const st = computeDistributionStats(finite);
        const q = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
        feature_stats[k] = {
          mean: +st.mean.toFixed(2),
          std: +st.sd.toFixed(2),
          p25: +q(0.25).toFixed(2),
          p50: +st.median.toFixed(2),
          p75: +q(0.75).toFixed(2),
        };
      }
      let score_distribution: any = null;
      if (prof.hasScores && prof.scores.length > 0) {
        const sortedS = [...prof.scores].sort((a, b) => a - b);
        const meanS = sortedS.reduce((a, b) => a + b, 0) / sortedS.length;
        score_distribution = {
          mean: +meanS.toFixed(2),
          min: +sortedS[0].toFixed(2),
          max: +sortedS[sortedS.length - 1].toFixed(2),
          decile_bounds: prof.scoreBoundaries,
        };
      }
      let performance: any = null;
      if (prof.hasLabels && prof.hasScores) {
        const pts: DataPoint[] = prof.scores.map((s, i) => ({ score: s, label: prof.labels[i] }));
        const dir = baseline.scoreDirection ?? 'higher_is_safer';
        const auc = calculateAUC(pts, dir);
        const gini = calculateGini(pts, dir);
        const ks = calculateKS(pts);
        performance = {
          test: {
            auc,
            gini,
            ks,
            period:
              prof.meta.periodStart && prof.meta.periodEnd
                ? `${prof.meta.periodStart} – ${prof.meta.periodEnd}`
                : 'Reference',
          },
          train: { auc, gini, ks },
        };
      }
      dynamicBaseline = {
        sample_size: prof.meta.rowCount,
        bad_rate: prof.meta.badRate,
        feature_stats,
        score_distribution,
        performance,
      };
    } catch {
      // Reference profile not registered in memory yet
    }
  }

  return {
    ...rawBuiltIn,
    ...(dynamicBaseline ? { baseline: dynamicBaseline } : {}),
    id: baseline.modelId,
    modelId: baseline.modelId,
    name: baseline.name,
    description: baseline.description,
    type: baseline.mode,
    mode: baseline.mode,
    status: baseline.status === 'ACTIVE' ? 'active' : baseline.status.toLowerCase(),
    configVersion: baseline.version,
    referenceDatasetId: baseline.referenceDatasetId,
    idColumn: baseline.columns.idColumn ?? DEFAULT_ID_COLUMN,
    dateColumn: baseline.columns.dateColumn ?? null,
    labelColumn: baseline.columns.labelColumn ?? DEFAULT_LABEL_COLUMN,
    scoreColumn: baseline.columns.scoreColumn ?? null,
    scoreDirection: baseline.scoreDirection ?? 'higher_is_safer',
    featureRegistry: baseline.featureRegistry ?? {},
    scoring,
    thresholds: baseline.thresholds,
    anomalyConfig: baseline.anomalyConfig,
    driftConfig: baseline.driftConfig,
    triggerConfig: baseline.triggerConfig,
    riskGrades: baseline.riskGrades,
    experimentConfig: baseline.experimentConfig,
    builtIn: Boolean(baseline.builtIn),
    baselineVersion: baseline,
  };
}

// ─── Baseline Registry Queries & Mutations ──────────────────────────────────
export function bumpPatch(v: string): string {
  const [a = 1, b = 0, c = 0] = v.split('.').map(n => parseInt(n, 10) || 0);
  return `${a}.${b}.${c + 1}`;
}

export function getActiveModelId(): string {
  const s = getStore();
  const customDefault = s.peek?.<string>(REGISTRY_DEFAULT_KEY);
  return customDefault || bundled.activeModelId;
}

export async function getDefaultModelId(): Promise<string> {
  const stored = await getStore().get<string>(REGISTRY_DEFAULT_KEY);
  return stored || bundled.activeModelId;
}

export async function setDefaultModelId(modelId: string): Promise<string> {
  const m = await getModel(modelId);
  if (!m) {
    throw new RegistryError(`ไม่พบโมเดล "${modelId}" ในระบบ`, 404);
  }
  await getStore().set(REGISTRY_DEFAULT_KEY, modelId);
  return modelId;
}

async function getStoredModelsMap(): Promise<Map<string, ModelMetadata>> {
  const map = new Map<string, ModelMetadata>();
  for (const id of Object.keys(bundled.models)) {
    map.set(id, buildBuiltInModelMetadata(id));
  }
  const stored = (await getStore().get<ModelMetadata[]>(REGISTRY_MODELS_KEY)) ?? [];
  for (const m of stored) {
    // Stored metadata wins on matching id, preserving builtIn flag if it was built-in
    const prev = map.get(m.modelId);
    map.set(m.modelId, { ...prev, ...m, builtIn: prev?.builtIn ?? m.builtIn ?? false });
  }
  return map;
}

async function saveStoredModelMetadata(meta: ModelMetadata): Promise<void> {
  const store = getStore();
  const list = (await store.get<ModelMetadata[]>(REGISTRY_MODELS_KEY)) ?? [];
  const filtered = list.filter(m => m.modelId !== meta.modelId);
  await store.set(REGISTRY_MODELS_KEY, [...filtered, meta]);
  knownEventModelIds.add(meta.modelId);
}

async function getStoredVersions(modelId: string): Promise<BaselineVersion[]> {
  return (await getStore().get<BaselineVersion[]>(registryVersionsKey(modelId))) ?? [];
}

async function saveStoredVersions(modelId: string, versions: BaselineVersion[]): Promise<void> {
  await getStore().set(registryVersionsKey(modelId), versions);
  knownEventModelIds.add(modelId);
}

/**
 * Returns all versions of `modelId` (merging built-in version with stored versions).
 * Built-in versions can never be overwritten; if a stored version is `ACTIVE`,
 * the built-in version automatically reflects `ARCHIVED`.
 */
export async function listBaselineVersions(modelId: string): Promise<BaselineVersion[]> {
  const stored = await getStoredVersions(modelId);
  if (!isBuiltInModelId(modelId)) {
    return stored;
  }
  const hasStoredActive = stored.some(v => v.status === 'ACTIVE');
  const builtInVer = buildBuiltInBaselineVersion(modelId, hasStoredActive);

  // Apply stored threshold overrides (from legacy /api/model-config) to built-in if active
  const ov = await getStore().get<ConfigOverride>(overrideKey(modelId));
  if (ov && !hasStoredActive) {
    builtInVer.thresholds = { ...builtInVer.thresholds, ...ov.thresholds };
    builtInVer.version = ov.configVersion;
  }

  const nonColliding = stored.filter(v => v.version !== (bundled.models[modelId].configVersion ?? '1.1.0'));
  return [builtInVer, ...nonColliding];
}

export async function getModel(modelId?: string): Promise<{
  model: ModelMetadata;
  activeVersion: BaselineVersion | null;
  versions: BaselineVersion[];
  isDefault: boolean;
} | null> {
  const defaultId = await getDefaultModelId();
  const targetId = modelId || defaultId;
  const modelsMap = await getStoredModelsMap();
  const model = modelsMap.get(targetId);
  if (!model) return null;

  const versions = await listBaselineVersions(targetId);
  const activeVersion = versions.find(v => v.status === 'ACTIVE') ?? null;
  return {
    model,
    activeVersion,
    versions,
    isDefault: targetId === defaultId,
  };
}

export async function listRegistryModels(): Promise<{
  defaultModelId: string;
  models: Array<
    ModelMetadata & {
      activeVersion: BaselineVersion | null;
      versionCount: number;
      isDefault: boolean;
    }
  >;
}> {
  const defaultModelId = await getDefaultModelId();
  const modelsMap = await getStoredModelsMap();
  const out = [];
  for (const m of modelsMap.values()) {
    const versions = await listBaselineVersions(m.modelId);
    const activeVersion = versions.find(v => v.status === 'ACTIVE') ?? null;
    out.push({
      ...m,
      activeVersion,
      versionCount: versions.length,
      isDefault: m.modelId === defaultModelId,
    });
  }
  return { defaultModelId, models: out };
}

export async function getActiveBaseline(modelId?: string): Promise<BaselineVersion> {
  const targetId = modelId || (await getDefaultModelId());
  const info = await getModel(targetId);
  if (!info) {
    throw new RegistryError(`ไม่พบโมเดล "${targetId}" ใน Registry`, 404);
  }
  if (!info.activeVersion) {
    throw new RegistryError(`โมเดล "${targetId}" ยังไม่มีเวอร์ชันที่เปิดใช้งาน (ACTIVE)`, 404);
  }
  return info.activeVersion;
}

/**
 * Loads the `ReferenceProfile` for `referenceId` from blob/built-in storage,
 * cached by `referenceId + sha256 + scoring/column fingerprint`.
 */
export async function loadReferenceProfile(
  referenceId: string,
  baseline?: BaselineVersion | any,
): Promise<ReferenceProfile> {
  const blob = await loadReferenceDatasetBlob(referenceId);
  const mode: BaselineMode =
    baseline?.mode ??
    (baseline?.scoring?.scorecard && Object.keys(baseline.scoring.scorecard).length > 0
      ? 'scorecard'
      : 'score_column');
  const labelColumn: string | undefined =
    baseline?.columns?.labelColumn ?? baseline?.labelColumn ?? DEFAULT_LABEL_COLUMN;
  const scoreColumn: string | undefined =
    mode === 'score_column'
      ? (baseline?.columns?.scoreColumn ?? baseline?.scoreColumn ?? undefined)
      : undefined;
  const scoring = mode === 'scorecard' ? baseline?.scoring : null;

  const featureRegistry = baseline?.featureRegistry;

  if (blob) {
    registerReferenceDataset(blob.meta, blob.rows);
    return buildReferenceProfileFromData(blob, scoring, { labelColumn, scoreColumn, featureRegistry });
  }
  return getReferenceProfile(referenceId, scoring, { labelColumn, scoreColumn, featureRegistry });
}

/**
 * Effective model object (compatible with all existing pipeline functions & APIs).
 */
export async function getEffectiveModel(modelId?: string) {
  const targetId = modelId || (await getDefaultModelId());
  const active = await getActiveBaseline(targetId);
  await loadReferenceProfile(active.referenceDatasetId, active);
  return baselineToModelObject(active);
}

export async function getEffectiveConfig(requestedModelId?: string) {
  const { defaultModelId, models: regModels } = await listRegistryModels();
  const models: Record<string, any> = {};
  for (const m of regModels) {
    if (m.activeVersion) {
      try {
        await loadReferenceProfile(m.activeVersion.referenceDatasetId, m.activeVersion);
      } catch {
        // Ignore if reference is not yet uploaded
      }
      models[m.modelId] = baselineToModelObject(m.activeVersion);
    }
  }
  const activeModelId =
    requestedModelId && models[requestedModelId]
      ? requestedModelId
      : defaultModelId;
  return { activeModelId, defaultModelId, models };
}

export async function saveThresholds(
  modelId: string,
  thresholds: MonitoringThresholds,
  note = 'Thresholds updated from dashboard',
) {
  const current = await getEffectiveModel(modelId);
  const store = getStore();
  const prev = await store.get<ConfigOverride>(overrideKey(modelId));
  const version = bumpPatch(current.configVersion ?? '1.0.0');
  const now = new Date().toISOString();
  const ov: ConfigOverride = {
    configVersion: version,
    updatedAt: now,
    thresholds,
    history: [{ version, updatedAt: now, note }, ...(prev?.history ?? [])].slice(0, 50),
  };
  await store.set(overrideKey(modelId), ov);
  return ov;
}

export async function resetOverrides(modelId: string) {
  await getStore().del(overrideKey(modelId));
}

// ─── Baseline Version Lifecycle (DRAFT → VALIDATED → ACTIVE → ARCHIVED) ─────
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export async function createDraftBaselineVersion(
  modelId: string,
  input: Partial<BaselineVersion>,
  opts: { by?: string; note?: string } = {},
): Promise<BaselineVersion> {
  if (isBuiltInModelId(modelId)) {
    throw new BuiltInProtectedError(
      `ไม่สามารถสร้างหรือแก้ไขทับโมเดลมาตรฐาน (Built-in) "${modelId}" ได้`,
    );
  }
  const version = String(input.version ?? '1.0.0').trim();
  if (!SEMVER_RE.test(version)) {
    throw new RegistryError(`หมายเลขเวอร์ชัน "${version}" ต้องอยู่ในรูปแบบ semver (เช่น 1.0.0)`, 400);
  }

  const now = new Date().toISOString();
  const by = opts.by || input.createdBy || 'user';
  const mode: BaselineMode =
    input.mode ??
    (input.scoring?.scorecard && Object.keys(input.scoring.scorecard).length > 0
      ? 'scorecard'
      : 'score_column');

  const modelsMap = await getStoredModelsMap();
  if (!modelsMap.has(modelId)) {
    await saveStoredModelMetadata({
      modelId,
      name: input.name || modelId,
      description: input.description || '',
      type: mode,
      createdAt: now,
      builtIn: false,
    });
  }

  const stored = await getStoredVersions(modelId);
  const existingIdx = stored.findIndex(v => v.version === version);
  if (existingIdx !== -1 && stored[existingIdx].status === 'ACTIVE') {
    throw new RegistryError(
      `เวอร์ชัน "${modelId}@${version}" กำลัง ACTIVE อยู่ ไม่สามารถเขียนทับได้ กรุณาสร้างหมายเลขเวอร์ชันใหม่`,
      409,
    );
  }

  const prevHistory = existingIdx !== -1 ? stored[existingIdx].statusHistory : [];
  const prevStatus = existingIdx !== -1 ? stored[existingIdx].status : null;

  const draft: BaselineVersion = {
    modelId,
    version,
    name: input.name || modelsMap.get(modelId)?.name || modelId,
    description: input.description ?? '',
    status: 'DRAFT',
    mode,
    columns: {
      idColumn: input.columns?.idColumn || (input as any).idColumn || DEFAULT_ID_COLUMN,
      dateColumn:
        input.columns?.dateColumn !== undefined
          ? input.columns.dateColumn
          : ((input as any).dateColumn ?? null),
      labelColumn:
        input.columns?.labelColumn !== undefined
          ? input.columns.labelColumn
          : ((input as any).labelColumn ?? DEFAULT_LABEL_COLUMN),
      scoreColumn:
        input.columns?.scoreColumn !== undefined
          ? input.columns.scoreColumn
          : ((input as any).scoreColumn ?? null),
    },
    scoreDirection:
      input.scoreDirection === 'higher_is_riskier' ? 'higher_is_riskier' : 'higher_is_safer',
    featureRegistry: input.featureRegistry ?? {},
    ...(mode === 'scorecard' && input.scoring ? { scoring: input.scoring } : {}),
    thresholds: input.thresholds ?? {
      psi_warning: 0.10,
      psi_critical: 0.25,
      gini_min: 0.10,
      auc_min: 0.55,
      ks_min: 0.10,
      csi_features: {},
    },
    ...(input.anomalyConfig ? { anomalyConfig: input.anomalyConfig } : {}),
    ...(input.driftConfig ? { driftConfig: input.driftConfig } : {}),
    ...(input.triggerConfig ? { triggerConfig: input.triggerConfig } : {}),
    ...(input.riskGrades ? { riskGrades: input.riskGrades } : {}),
    ...(input.experimentConfig ? { experimentConfig: input.experimentConfig } : {}),
    ...(input.onboardingLog ? { onboardingLog: input.onboardingLog } : {}),
    referenceDatasetId: String(input.referenceDatasetId ?? (input as any).referenceId ?? ''),
    validationReport: null,
    createdAt: existingIdx !== -1 ? stored[existingIdx].createdAt : now,
    createdBy: by,
    statusHistory: [
      ...prevHistory,
      {
        from: prevStatus,
        to: 'DRAFT',
        at: now,
        by,
        note: opts.note || (existingIdx !== -1 ? 'Updated draft baseline' : 'Created draft baseline'),
      },
    ],
    builtIn: false,
  };

  const next =
    existingIdx !== -1
      ? stored.map((v, i) => (i === existingIdx ? draft : v))
      : [...stored, draft];
  await saveStoredVersions(modelId, next);
  return draft;
}

export async function validateBaselineVersion(
  modelId: string,
  version: string,
  opts: { by?: string; note?: string; dryRun?: boolean } = {},
): Promise<{ ok: boolean; version: BaselineVersion; report: BaselineValidationReport }> {
  if (isBuiltInBaselineVersion(modelId, version) && !opts.dryRun) {
    throw new BuiltInProtectedError(
      `เวอร์ชัน Built-in "${modelId}@${version}" ถูกล็อกไว้แล้ว ไม่สามารถเปลี่ยนสถานะได้`,
    );
  }

  const allVersions = await listBaselineVersions(modelId);
  const target = allVersions.find(v => v.version === version);
  if (!target) {
    throw new RegistryError(`ไม่พบเวอร์ชัน "${version}" ของโมเดล "${modelId}"`, 404);
  }

  const refBlob = await loadReferenceDatasetBlob(target.referenceDatasetId);
  if (!refBlob) {
    const missingRefReport: BaselineValidationReport = {
      ok: false,
      validatedAt: new Date().toISOString(),
      referenceId: target.referenceDatasetId,
      sha256: '',
      errors: [
        {
          code: 'REFERENCE_NOT_FOUND',
          field: 'referenceDatasetId',
          message: `ไม่พบ Reference Dataset "${target.referenceDatasetId}" ใน Blob Storage`,
        },
      ],
      warnings: [],
      computed: {
        rowCount: 0,
        hasLabels: false,
        labeledRowCount: 0,
        badCount: 0,
        badRate: null,
        performance: null,
        autoGeneratedBins: {},
        featureSkewness: {},
        referenceFlaggedCount: 0,
        referenceFlaggedPct: 0,
        multivariateFitMs: 0,
      },
    };
    return { ok: false, version: { ...target, validationReport: missingRefReport }, report: missingRefReport };
  }

  const report = validateBaseline(target, refBlob);
  if (opts.dryRun) {
    return { ok: report.ok, version: { ...target, validationReport: report }, report };
  }

  const stored = await getStoredVersions(modelId);
  const idx = stored.findIndex(v => v.version === version);
  if (idx === -1) {
    throw new RegistryError(`ไม่พบเวอร์ชัน "${version}" ในรายการที่แก้ไขได้`, 404);
  }

  const now = new Date().toISOString();
  const by = opts.by || 'validator';
  const current = stored[idx];
  const nextStatus: BaselineStatus = report.ok
    ? current.status === 'ACTIVE'
      ? 'ACTIVE'
      : 'VALIDATED'
    : 'DRAFT';

  const updated: BaselineVersion = {
    ...current,
    status: nextStatus,
    validationReport: report,
    statusHistory:
      nextStatus !== current.status
        ? [
            ...current.statusHistory,
            {
              from: current.status,
              to: nextStatus,
              at: now,
              by,
              note:
                opts.note ||
                (report.ok
                  ? `Validated against reference "${target.referenceDatasetId}"`
                  : `Validation failed (${report.errors.length} errors)`),
            },
          ]
        : current.statusHistory,
  };

  const nextList = [...stored];
  nextList[idx] = updated;
  await saveStoredVersions(modelId, nextList);
  return { ok: report.ok, version: updated, report };
}

export async function activateBaselineVersion(
  modelId: string,
  version: string,
  opts: { by?: string; note?: string } = {},
): Promise<BaselineVersion> {
  if (isBuiltInBaselineVersion(modelId, version)) {
    throw new BuiltInProtectedError(
      `เวอร์ชัน Built-in "${modelId}@${version}" ไม่สามารถแก้ไขสถานะผ่าน API ได้`,
    );
  }

  const stored = await getStoredVersions(modelId);
  const idx = stored.findIndex(v => v.version === version);
  if (idx === -1) {
    throw new RegistryError(`ไม่พบเวอร์ชัน "${version}" ของโมเดล "${modelId}"`, 404);
  }

  const target = stored[idx];
  if (target.status !== 'VALIDATED') {
    throw new RegistryError(
      `ไม่สามารถเปิดใช้งาน (ACTIVE) เวอร์ชัน "${modelId}@${version}" ได้เนื่องจากสถานะปัจจุบันคือ "${target.status}" (ต้องเป็น "VALIDATED" เท่านั้น)`,
      400,
    );
  }

  const now = new Date().toISOString();
  const by = opts.by || 'user';

  // Archive any currently ACTIVE stored version of the same model automatically
  const nextList = stored.map((v, i) => {
    if (i === idx) {
      return {
        ...v,
        status: 'ACTIVE' as const,
        statusHistory: [
          ...v.statusHistory,
          {
            from: v.status,
            to: 'ACTIVE' as const,
            at: now,
            by,
            note: opts.note || `Activated version ${version}`,
          },
        ],
      };
    }
    if (v.status === 'ACTIVE') {
      return {
        ...v,
        status: 'ARCHIVED' as const,
        statusHistory: [
          ...v.statusHistory,
          {
            from: 'ACTIVE' as const,
            to: 'ARCHIVED' as const,
            at: now,
            by: 'system',
            note: `Archived automatically when version ${version} was activated`,
          },
        ],
      };
    }
    return v;
  });

  await saveStoredVersions(modelId, nextList);
  const activated = nextList[idx];
  await loadReferenceProfile(activated.referenceDatasetId, activated);
  return activated;
}

export async function archiveBaselineVersion(
  modelId: string,
  version: string,
  opts: { by?: string; note?: string } = {},
): Promise<BaselineVersion> {
  if (isBuiltInModelId(modelId) || isBuiltInBaselineVersion(modelId, version)) {
    throw new BuiltInProtectedError(
      `ไม่สามารถ Archive เวอร์ชันมาตรฐาน (Built-in) "${modelId}@${version}" ได้`,
    );
  }

  const stored = await getStoredVersions(modelId);
  const idx = stored.findIndex(v => v.version === version);
  if (idx === -1) {
    throw new RegistryError(`ไม่พบเวอร์ชัน "${version}" ของโมเดล "${modelId}"`, 404);
  }

  const now = new Date().toISOString();
  const by = opts.by || 'user';
  const current = stored[idx];
  const updated: BaselineVersion = {
    ...current,
    status: 'ARCHIVED',
    statusHistory: [
      ...current.statusHistory,
      {
        from: current.status,
        to: 'ARCHIVED',
        at: now,
        by,
        note: opts.note || `Archived version ${version}`,
      },
    ],
  };

  const nextList = [...stored];
  nextList[idx] = updated;
  await saveStoredVersions(modelId, nextList);
  return updated;
}

export async function exportBaselineVersion(
  modelId: string,
  version: string,
): Promise<BaselineVersion & { baseline: BaselineVersion; reference: ReferenceDatasetBlob | null }> {
  const all = await listBaselineVersions(modelId);
  const found = all.find(v => v.version === version);
  if (!found) {
    throw new RegistryError(`ไม่พบเวอร์ชัน "${version}" ของโมเดล "${modelId}"`, 404);
  }
  const cloned = structuredClone(found);
  const reference = await loadReferenceDatasetBlob(cloned.referenceDatasetId);
  return {
    ...cloned,
    baseline: structuredClone(cloned),
    reference: reference ? structuredClone(reference) : null,
  };
}

export async function importBaselineVersion(
  payload: Partial<BaselineVersion> & {
    baseline?: Partial<BaselineVersion>;
    reference?: ReferenceDatasetBlob | null;
  },
  opts: { by?: string; note?: string } = {},
): Promise<BaselineVersion> {
  const src: Partial<BaselineVersion> = payload.baseline ?? payload;
  const modelId = String(src.modelId ?? '').trim();
  const version = String(src.version ?? '').trim();
  if (!modelId || !version) {
    throw new RegistryError('ข้อมูลที่นำเข้าต้องระบุ modelId และ version', 400);
  }
  if (isBuiltInModelId(modelId) || isBuiltInBaselineVersion(modelId, version)) {
    throw new BuiltInProtectedError(
      `ไม่สามารถนำเข้าทับเวอร์ชันมาตรฐาน (Built-in) "${modelId}@${version}" ได้`,
    );
  }
  if (
    payload.reference &&
    payload.reference.meta?.referenceId &&
    Array.isArray(payload.reference.rows) &&
    !isBuiltInReferenceId(payload.reference.meta.referenceId)
  ) {
    await saveReferenceDatasetBlob(payload.reference);
  }
  return createDraftBaselineVersion(modelId, src, {
    by: opts.by || src.createdBy || 'importer',
    note: opts.note || 'Imported baseline version',
  });
}

// ─── Runs & Trigger Events (monitoring + sandbox) ───────────────────────────
export function createTriggerEventFromRun(run: MonitoringRun): TriggerEvent | null {
  if (!run.trigger || run.trigger.action === 'CONTINUE') return null;
  return {
    eventId: `evt_${run.model.modelId}_${run.runId}`,
    runId: run.runId,
    createdAt: run.createdAt,
    model: run.model,
    referenceId: run.referenceId,
    decision: run.trigger,
    status: 'OPEN',
    review: null,
  };
}

/** Synchronous history lookup when using local MemoryStore or FileStore. */
export function getMonitoringHistorySync(
  modelId: string,
  referenceId?: string,
  configVersion?: string,
): MonitoringRun[] {
  const s = getStore();
  if (!s.peek) return [];
  const list = s.peek<MonitoringRun[]>(runsKey('monitoring', modelId)) ?? [];
  return list.filter(r => {
    if (referenceId && r.referenceId !== referenceId) return false;
    if (configVersion && r.model?.configVersion && r.model.configVersion !== configVersion) return false;
    return true;
  });
}

/** Synchronous event persistence when using local MemoryStore or FileStore. */
export function recordTriggerEventSync(run: MonitoringRun): TriggerEvent | null {
  const ev = createTriggerEventFromRun(run);
  if (!ev) return null;
  knownEventModelIds.add(ev.model.modelId);
  const s = getStore();
  if (s.peek && s.putSync) {
    const key = eventsKey(ev.model.modelId);
    const list = s.peek<TriggerEvent[]>(key) ?? [];
    if (!list.some(x => x.eventId === ev.eventId || x.runId === ev.runId)) {
      s.putSync(key, [ev, ...list].slice(0, MAX_EVENTS));
    }
  }
  return ev;
}

export async function saveTriggerEvent(ev: TriggerEvent): Promise<TriggerEvent> {
  knownEventModelIds.add(ev.model.modelId);
  const s = getStore();
  const key = eventsKey(ev.model.modelId);
  const list = (await s.get<TriggerEvent[]>(key)) ?? [];
  const filtered = list.filter(x => x.eventId !== ev.eventId && x.runId !== ev.runId);
  await s.set(key, [ev, ...filtered].slice(0, MAX_EVENTS));
  return ev;
}

export async function listTriggerEvents(
  opts: {
    modelId?: string;
    status?: TriggerEventStatus;
  } = {},
): Promise<TriggerEvent[]> {
  const s = getStore();
  const modelIds = opts.modelId ? [opts.modelId] : [...knownEventModelIds];
  const all: TriggerEvent[] = [];
  for (const mId of modelIds) {
    const list = (await s.get<TriggerEvent[]>(eventsKey(mId))) ?? [];
    all.push(...list);
  }
  return opts.status ? all.filter(e => e.status === opts.status) : all;
}

export async function reviewTriggerEvent(
  eventId: string,
  payload: { decision: TriggerReviewDecision; note?: string; reviewer?: string },
): Promise<
  | { status: 'ok'; event: TriggerEvent }
  | { status: 'already_reviewed'; event: TriggerEvent }
  | { status: 'not_found' }
> {
  const s = getStore();
  const modelIds = new Set<string>(knownEventModelIds);
  const m = eventId.match(/^evt_(.+)_mon_/);
  if (m?.[1]) modelIds.add(m[1]);

  for (const mId of modelIds) {
    const key = eventsKey(mId);
    const list = (await s.get<TriggerEvent[]>(key)) ?? [];
    const idx = list.findIndex(e => e.eventId === eventId);
    if (idx === -1) continue;
    const current = list[idx];
    if (current.status === 'REVIEWED' || current.review !== null) {
      return { status: 'already_reviewed', event: current };
    }
    const updated: TriggerEvent = {
      ...current,
      status: 'REVIEWED',
      review: {
        decision: payload.decision,
        note: payload.note ?? '',
        reviewer: payload.reviewer ?? 'unknown',
        reviewedAt: new Date().toISOString(),
      },
    };
    const nextList = [...list];
    nextList[idx] = updated;
    await s.set(key, nextList);
    return { status: 'ok', event: updated };
  }
  return { status: 'not_found' };
}

export async function saveRun(run: StoredRun) {
  knownEventModelIds.add(run.model.modelId);
  await getStore().listPush(runsKey(run.kind, run.model.modelId), run, MAX_RUNS);
  if (run.kind === 'monitoring') {
    const ev = createTriggerEventFromRun(run);
    if (ev) await saveTriggerEvent(ev);
  }
}

export async function listRuns<T extends StoredRun = StoredRun>(
  kind: T['kind'],
  modelId: string,
  opts: { configVersion?: string; limit?: number } = {},
): Promise<T[]> {
  const items = await getStore().listRange<T>(runsKey(kind, modelId), opts.limit ?? MAX_RUNS);
  return opts.configVersion ? items.filter(r => r.model.configVersion === opts.configVersion) : items;
}

export async function clearRuns(kind: StoredRun['kind'], modelId: string) {
  await getStore().del(runsKey(kind, modelId));
}

export function storageInfo() {
  const s = getStore();
  return { kind: s.kind, persistent: s.persistent };
}

export type {
  MonitoringRun,
  ExperimentRun,
  ModelVersionRef,
  TriggerEvent,
  BaselineVersion,
  ModelMetadata,
  BaselineValidationReport,
};
