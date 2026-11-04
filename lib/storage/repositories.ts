/**
 * Repositories — the only place that knows storage keys.
 *
 * Model configuration = bundled app/model-config.json (immutable, versioned in git)
 *                     + stored overrides (thresholds edited in the UI).
 * Every override save bumps configVersion so monitoring runs made under
 * different thresholds stay distinguishable.
 */
import modelConfigJson from '../../app/model-config.json';
import type { ExperimentRun, MonitoringRun, MonitoringThresholds, ModelVersionRef, StoredRun } from '../types';
import { getStore } from './store';

const MAX_RUNS = 500;

// ─── Model config ───────────────────────────────────────────────────────────
export interface ConfigOverride {
  configVersion: string;
  updatedAt: string;
  thresholds: MonitoringThresholds;
  history: { version: string; updatedAt: string; note: string }[];
}

type BundledConfig = { activeModelId: string; models: Record<string, any> };
const bundled = modelConfigJson as unknown as BundledConfig;

const overrideKey = (modelId: string) => `config:${modelId}:override`;

export function bumpPatch(v: string): string {
  const [a = 1, b = 0, c = 0] = v.split('.').map(n => parseInt(n, 10) || 0);
  return `${a}.${b}.${c + 1}`;
}

export function getActiveModelId(): string { return bundled.activeModelId; }

/** Effective model = bundled model with stored overrides applied. */
export async function getEffectiveModel(modelId = bundled.activeModelId) {
  const base = bundled.models[modelId];
  if (!base) throw new Error(`Unknown model "${modelId}"`);
  const ov = await getStore().get<ConfigOverride>(overrideKey(modelId));
  const model = structuredClone(base);
  if (ov) {
    model.thresholds = { ...model.thresholds, ...ov.thresholds };
    model.configVersion = ov.configVersion;
    model.configUpdatedAt = ov.updatedAt;
    model.configHistory = [...ov.history, ...(model.configHistory ?? [])];
  }
  return model;
}

export async function getEffectiveConfig() {
  const models: Record<string, any> = {};
  for (const id of Object.keys(bundled.models)) models[id] = await getEffectiveModel(id);
  return { activeModelId: bundled.activeModelId, models };
}

export async function saveThresholds(modelId: string, thresholds: MonitoringThresholds, note = 'Thresholds updated from dashboard') {
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

// ─── Runs (monitoring + sandbox) ────────────────────────────────────────────
const runsKey = (kind: StoredRun['kind'], modelId: string) => `runs:${kind}:${modelId}`;

export async function saveRun(run: StoredRun) {
  await getStore().listPush(runsKey(run.kind, run.model.modelId), run, MAX_RUNS);
}

export async function listRuns<T extends StoredRun = StoredRun>(
  kind: T['kind'], modelId: string, opts: { configVersion?: string; limit?: number } = {},
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

export type { MonitoringRun, ExperimentRun, ModelVersionRef };
