/**
 * Repositories — the only place that knows storage keys.
 *
 * Model configuration = bundled app/model-config.json (immutable, versioned in git)
 *                     + stored overrides (thresholds edited in the UI).
 * Every override save bumps configVersion so monitoring runs made under
 * different thresholds stay distinguishable.
 */
import modelConfigJson from '../../app/model-config.json';
import type {
  ExperimentRun,
  MonitoringRun,
  MonitoringThresholds,
  ModelVersionRef,
  StoredRun,
  TriggerEvent,
  TriggerEventStatus,
  TriggerReviewDecision,
} from '../types';
import { getStore } from './store';

const MAX_RUNS = 500;
const MAX_EVENTS = 500;
const knownEventModelIds = new Set<string>(Object.keys((modelConfigJson as any).models ?? {}));

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
const eventsKey = (modelId: string) => `events:${modelId}`;

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
export function getMonitoringHistorySync(modelId: string, referenceId?: string): MonitoringRun[] {
  const s = getStore();
  if (!s.peek) return [];
  const list = s.peek<MonitoringRun[]>(runsKey('monitoring', modelId)) ?? [];
  return referenceId ? list.filter(r => r.referenceId === referenceId) : list;
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

export async function listTriggerEvents(opts: {
  modelId?: string;
  status?: TriggerEventStatus;
} = {}): Promise<TriggerEvent[]> {
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
  // Extract modelId if eventId has pattern evt_<modelId>_mon_...
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
  await getStore().listPush(runsKey(run.kind, run.model.modelId), run, MAX_RUNS);
  if (run.kind === 'monitoring') {
    const ev = createTriggerEventFromRun(run);
    if (ev) await saveTriggerEvent(ev);
  }
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

export type { MonitoringRun, ExperimentRun, ModelVersionRef, TriggerEvent };
