/**
 * Repository and domain logic for Model Rule Sets, Revisions, Auditing, and Simulation.
 *
 * Implements immutable revisions, single-active-set per model version, audit logging with diffs,
 * input validation, and dry-run simulation against historical runs.
 */
import { getStore } from './store';
import type {
  RuleSet,
  RuleSetConfig,
  RuleSetRevision,
  RuleSetAuditEntry,
  RuleSetAuditDiff,
  MonitoringRun,
  TriggerDecision,
} from '../types';
import {
  DEFAULT_PSI_WARNING,
  DEFAULT_PSI_CRITICAL,
  DEFAULT_AUC_MIN,
  DEFAULT_GINI_MIN,
  DEFAULT_KS_MIN,
  RISK_DECILE_ALERT_THRESHOLD_PCT_POINTS,
} from '../defaults';
import { evaluateTrigger } from '../trigger';

export const RULE_SET_FIELD_LABELS: Record<string, string> = {
  psi_warning: 'เกณฑ์เตือน PSI (Warning)',
  psi_critical: 'เกณฑ์วิกฤต PSI (Critical)',
  csi_warning: 'เกณฑ์เตือน CSI (Warning)',
  csi_critical: 'เกณฑ์วิกฤต CSI (Critical)',
  auc_min: 'เกณฑ์ขั้นต่ำ AUC',
  gini_min: 'เกณฑ์ขั้นต่ำ Gini',
  ks_min: 'เกณฑ์ขั้นต่ำ KS',
  dataIssueThresholdRate: 'สัดส่วนปัญหาข้อมูลที่เริ่มตัด/เตือน (R1b %)',
  labelPValueThreshold: 'ระดับนัยสำคัญ Label Drift (p-value)',
  decileAlertThresholdPctPoints: 'เกณฑ์เตือนสัดส่วนกลุ่มเสี่ยงสูงสุด (%pts)',
  'enabledRules.R1b': 'เปิดใช้งานกฎ R1b (Data Quality Issues)',
  'enabledRules.R5': 'เปิดใช้งานกฎ R5 (Recalibration)',
  'enabledRules.R8': 'เปิดใช้งานกฎ R8 (Monitor Closely)',
  'enabledRules.R5b': 'เปิดใช้งานกฎ R5b (Population Shift)',
};

export const STANDARD_RULE_SET_CONFIG: RuleSetConfig = {
  psi_warning: DEFAULT_PSI_WARNING,
  psi_critical: DEFAULT_PSI_CRITICAL,
  csi_warning: 0.10,
  csi_critical: 0.25,
  auc_min: DEFAULT_AUC_MIN,
  gini_min: DEFAULT_GINI_MIN,
  ks_min: DEFAULT_KS_MIN,
  dataIssueThresholdRate: 1.0, // 1%
  labelPValueThreshold: 0.05,
  decileAlertThresholdPctPoints: RISK_DECILE_ALERT_THRESHOLD_PCT_POINTS,
  enabledRules: {
    R1b: true,
    R5: true,
    R8: true,
    R5b: false,
  },
};

export const STRICT_RULE_SET_CONFIG: RuleSetConfig = {
  psi_warning: 0.05,
  psi_critical: 0.15,
  csi_warning: 0.05,
  csi_critical: 0.15,
  auc_min: 0.60,
  gini_min: 0.20,
  ks_min: 0.15,
  dataIssueThresholdRate: 0.5, // 0.5%
  labelPValueThreshold: 0.10,
  decileAlertThresholdPctPoints: 3.0,
  enabledRules: {
    R1b: true,
    R5: true,
    R8: true,
    R5b: false,
  },
};

export const RELAXED_RULE_SET_CONFIG: RuleSetConfig = {
  psi_warning: 0.15,
  psi_critical: 0.30,
  csi_warning: 0.15,
  csi_critical: 0.30,
  auc_min: 0.50,
  gini_min: 0.05,
  ks_min: 0.05,
  dataIssueThresholdRate: 2.0, // 2%
  labelPValueThreshold: 0.01,
  decileAlertThresholdPctPoints: 8.0,
  enabledRules: {
    R1b: true,
    R5: true,
    R8: true,
    R5b: false,
  },
};

export const POPULATION_ADJUSTED_RULE_SET_CONFIG: RuleSetConfig = {
  ...STANDARD_RULE_SET_CONFIG,
  enabledRules: {
    ...STANDARD_RULE_SET_CONFIG.enabledRules,
    R5b: true,
  },
};

export interface RuleSetTemplateDefinition {
  templateId: 'standard' | 'strict' | 'relaxed' | 'population_adjusted';
  name: string;
  description: string;
  config: RuleSetConfig;
}

export const DEFAULT_TEMPLATES: RuleSetTemplateDefinition[] = [
  {
    templateId: 'standard',
    name: 'มาตรฐาน',
    description: 'เกณฑ์มาตรฐานตามแนวปฏิบัติทั่วไปของระบบ (ค่าเริ่มต้นเชิงปฏิบัติ)',
    config: STANDARD_RULE_SET_CONFIG,
  },
  {
    templateId: 'strict',
    name: 'เข้มงวด',
    description: 'เกณฑ์ตรวจวัดที่เข้มงวดขึ้น เหมาะสำหรับพอร์ตความเสี่ยงสูงหรือโมเดลที่ต้องการความไวสูง',
    config: STRICT_RULE_SET_CONFIG,
  },
  {
    templateId: 'relaxed',
    name: 'ผ่อนปรน',
    description: 'เกณฑ์ที่ยืดหยุ่นขึ้น เหมาะสำหรับพอร์ตที่กำลังเติบโตหรือมี seasonality สูง',
    config: RELAXED_RULE_SET_CONFIG,
  },
  {
    templateId: 'population_adjusted',
    name: 'ปรับตามประชากร',
    description: 'เกณฑ์มาตรฐานพร้อมเปิดใช้กฎ R5b เพื่อแยกการเปลี่ยนของประชากรออกจากการเสื่อมถอยของโมเดล',
    config: POPULATION_ADJUSTED_RULE_SET_CONFIG,
  },
];

export function validateRuleSetConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== 'object') {
    return ['ข้อมูลชุดกฎไม่ถูกต้อง (ต้องเป็น Object)'];
  }
  const c = config as Record<string, any>;

  const checkNum = (val: unknown, name: string, min: number, max: number, strictMin = false) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      errors.push(`${name} ต้องเป็นตัวเลขที่ถูกต้อง`);
      return;
    }
    if (strictMin ? val <= min : val < min) {
      errors.push(`${name} ต้อง ${strictMin ? '>' : '≥'} ${min}`);
    }
    if (val > max) {
      errors.push(`${name} ต้อง ≤ ${max}`);
    }
  };

  checkNum(c.psi_warning, 'เกณฑ์เตือน PSI', 0, 2, true);
  checkNum(c.psi_critical, 'เกณฑ์วิกฤต PSI', 0, 2, true);
  if (typeof c.psi_warning === 'number' && typeof c.psi_critical === 'number') {
    if (c.psi_warning >= c.psi_critical) {
      errors.push('เกณฑ์เตือน PSI ต้องน้อยกว่าเกณฑ์วิกฤต PSI');
    }
  }

  checkNum(c.csi_warning, 'เกณฑ์เตือน CSI', 0, 2, true);
  checkNum(c.csi_critical, 'เกณฑ์วิกฤต CSI', 0, 2, true);
  if (typeof c.csi_warning === 'number' && typeof c.csi_critical === 'number') {
    if (c.csi_warning >= c.csi_critical) {
      errors.push('เกณฑ์เตือน CSI ต้องน้อยกว่าเกณฑ์วิกฤต CSI');
    }
  }

  checkNum(c.auc_min, 'เกณฑ์ขั้นต่ำ AUC', 0, 1, true);
  checkNum(c.gini_min, 'เกณฑ์ขั้นต่ำ Gini', 0, 1, false);
  checkNum(c.ks_min, 'เกณฑ์ขั้นต่ำ KS', 0, 1, false);

  checkNum(c.dataIssueThresholdRate, 'สัดส่วนปัญหาข้อมูล (R1b)', 0, 100, false);
  checkNum(c.labelPValueThreshold, 'ระดับนัยสำคัญ Label Drift', 0, 1, true);
  checkNum(c.decileAlertThresholdPctPoints, 'เกณฑ์เตือนเดไซล์', 0, 100, false);

  if (!c.enabledRules || typeof c.enabledRules !== 'object') {
    errors.push('ต้องระบุสถานะเปิด/ปิดกฎ (enabledRules)');
  } else {
    for (const ruleKey of ['R1b', 'R5', 'R8', 'R5b']) {
      if (typeof c.enabledRules[ruleKey] !== 'boolean') {
        errors.push(`สถานะกฎ ${ruleKey} ต้องเป็น boolean (true/false)`);
      }
    }
  }

  return errors;
}

export function computeRuleSetConfigDiff(
  oldConfig: Partial<RuleSetConfig> | null | undefined,
  newConfig: RuleSetConfig,
): RuleSetAuditDiff[] {
  const diffs: RuleSetAuditDiff[] = [];
  if (!oldConfig) {
    return diffs;
  }

  const keys: (keyof Omit<RuleSetConfig, 'enabledRules'>)[] = [
    'psi_warning',
    'psi_critical',
    'csi_warning',
    'csi_critical',
    'auc_min',
    'gini_min',
    'ks_min',
    'dataIssueThresholdRate',
    'labelPValueThreshold',
    'decileAlertThresholdPctPoints',
  ];

  for (const k of keys) {
    if (oldConfig[k] !== newConfig[k]) {
      diffs.push({
        field: k,
        label: RULE_SET_FIELD_LABELS[k] || k,
        oldValue: oldConfig[k] ?? null,
        newValue: newConfig[k],
      });
    }
  }

  const oldRules = oldConfig.enabledRules || ({} as any);
  const newRules = newConfig.enabledRules || ({} as any);
  for (const rk of ['R1b', 'R5', 'R8', 'R5b'] as const) {
    if (oldRules[rk] !== newRules[rk]) {
      const field = `enabledRules.${rk}`;
      diffs.push({
        field,
        label: RULE_SET_FIELD_LABELS[field] || field,
        oldValue: oldRules[rk] ?? null,
        newValue: newRules[rk],
      });
    }
  }

  return diffs;
}

// ─── Storage Keys ─────────────────────────────────────────────────────────────
function getRuleSetsKey(modelId: string, version: string): string {
  return `rulesets:${modelId}:${version}`;
}

function getActivePointerKey(modelId: string, version: string): string {
  return `rulesets:active:${modelId}:${version}`;
}

function getAuditLogsKey(modelId: string, version: string): string {
  return `rulesets:audit:${modelId}:${version}`;
}

// ─── Repository CRUD Operations ──────────────────────────────────────────────
export async function initializeDefaultRuleSets(
  modelId: string,
  version: string,
): Promise<{ ruleSets: RuleSet[]; activePointer: { setId: string; revision: number } }> {
  const store = getStore();
  const now = new Date().toISOString();

  const ruleSets: RuleSet[] = DEFAULT_TEMPLATES.map(t => {
    const isStandard = t.templateId === 'standard';
    return {
      id: `ruleset_${t.templateId}`,
      name: t.name,
      description: t.description,
      modelId,
      modelVersion: version,
      templateId: t.templateId,
      currentRevision: 1,
      activeRevision: isStandard ? 1 : undefined,
      isActive: isStandard,
      revisions: [
        {
          revision: 1,
          config: structuredClone(t.config),
          createdAt: now,
          author: 'ระบบ',
          reason: `สร้างชุดกฎตั้งต้นเทมเพลต "${t.name}"`,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
  });

  const activePointer = { setId: 'ruleset_standard', revision: 1 };

  await store.set(getRuleSetsKey(modelId, version), ruleSets);
  await store.set(getActivePointerKey(modelId, version), activePointer);

  const initialAudit: RuleSetAuditEntry = {
    id: `audit_rs_${Date.now()}_init`,
    timestamp: now,
    modelId,
    modelVersion: version,
    setId: 'ruleset_standard',
    setName: 'มาตรฐาน',
    revision: 1,
    action: 'CREATE',
    author: 'ระบบ',
    reason: 'ตั้งต้นชุดกฎมาตรฐานสำหรับโมเดลเวอร์ชันนี้ (ค่าเริ่มต้นของระบบ)',
    diffs: [],
  };

  await store.set(getAuditLogsKey(modelId, version), [initialAudit]);

  return { ruleSets, activePointer };
}

export async function listRuleSets(
  modelId: string,
  version: string,
): Promise<{ ruleSets: RuleSet[]; activeRuleSet: { setId: string; name: string; revision: number; config: RuleSetConfig } }> {
  const store = getStore();
  let sets = await store.get<RuleSet[]>(getRuleSetsKey(modelId, version));
  let activePointer = await store.get<{ setId: string; revision: number }>(getActivePointerKey(modelId, version));

  if (!sets || sets.length === 0 || !activePointer) {
    const init = await initializeDefaultRuleSets(modelId, version);
    sets = init.ruleSets;
    activePointer = init.activePointer;
  }

  // Ensure active status matches pointer
  for (const s of sets) {
    s.isActive = s.id === activePointer.setId;
    s.activeRevision = s.isActive ? activePointer.revision : undefined;
  }

  const activeSet = sets.find(s => s.id === activePointer!.setId) || sets[0];
  const activeRev = activeSet.revisions.find(r => r.revision === activePointer!.revision) || activeSet.revisions[activeSet.revisions.length - 1];

  return {
    ruleSets: sets,
    activeRuleSet: {
      setId: activeSet.id,
      name: activeSet.name,
      revision: activeRev.revision,
      config: activeRev.config,
    },
  };
}

export async function getActiveRuleSet(
  modelId: string,
  version: string,
): Promise<{ setId: string; name: string; revision: number; config: RuleSetConfig }> {
  const { activeRuleSet } = await listRuleSets(modelId, version);
  return activeRuleSet;
}

export async function createRuleSet(
  modelId: string,
  version: string,
  data: {
    name: string;
    description?: string;
    config: RuleSetConfig;
    templateId?: 'standard' | 'strict' | 'relaxed' | 'population_adjusted' | 'custom';
    author: string;
    reason: string;
  },
): Promise<RuleSet> {
  const author = (data.author || '').trim();
  const reason = (data.reason || '').trim();
  if (!author) throw new Error('กรุณาระบุชื่อผู้สร้างชุดกฎ (ห้ามเว้นว่าง)');
  if (!reason) throw new Error('กรุณาระบุเหตุผลในการสร้างชุดกฎ (ห้ามเว้นว่าง)');

  const errors = validateRuleSetConfig(data.config);
  if (errors.length > 0) throw new Error(errors.join('; '));

  const store = getStore();
  const { ruleSets } = await listRuleSets(modelId, version);

  const name = data.name.trim();
  if (!name) throw new Error('กรุณาระบุชื่อชุดกฎ');
  if (ruleSets.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`ชื่อชุดกฎ "${name}" มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น`);
  }

  const now = new Date().toISOString();
  const setId = `ruleset_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const initialRevision: RuleSetRevision = {
    revision: 1,
    config: structuredClone(data.config),
    createdAt: now,
    author,
    reason,
  };

  const newSet: RuleSet = {
    id: setId,
    name,
    description: data.description?.trim() || '',
    modelId,
    modelVersion: version,
    templateId: data.templateId || 'custom',
    currentRevision: 1,
    isActive: false,
    revisions: [initialRevision],
    createdAt: now,
    updatedAt: now,
  };

  ruleSets.push(newSet);
  await store.set(getRuleSetsKey(modelId, version), ruleSets);

  const auditEntry: RuleSetAuditEntry = {
    id: `audit_rs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    modelId,
    modelVersion: version,
    setId,
    setName: name,
    revision: 1,
    action: 'CREATE',
    author,
    reason,
    diffs: computeRuleSetConfigDiff(null, data.config),
  };

  await logAuditEntry(modelId, version, auditEntry);
  return newSet;
}

export async function addRuleSetRevision(
  modelId: string,
  version: string,
  setId: string,
  data: {
    config: RuleSetConfig;
    author: string;
    reason: string;
  },
): Promise<{ ruleSet: RuleSet; newRevision: RuleSetRevision; auditEntry: RuleSetAuditEntry }> {
  const author = (data.author || '').trim();
  const reason = (data.reason || '').trim();
  if (!author) throw new Error('กรุณาระบุชื่อผู้แก้ไข (ห้ามเว้นว่าง)');
  if (!reason) throw new Error('กรุณาระบุเหตุผลในการแก้ไข (ห้ามเว้นว่าง)');

  const errors = validateRuleSetConfig(data.config);
  if (errors.length > 0) throw new Error(errors.join('; '));

  const store = getStore();
  const { ruleSets, activeRuleSet } = await listRuleSets(modelId, version);

  const targetSet = ruleSets.find(s => s.id === setId);
  if (!targetSet) throw new Error(`ไม่พบชุดกฎ "${setId}" ในระบบ`);

  // Immutability: previous revisions must NOT be modified
  const latestRev = targetSet.revisions[targetSet.revisions.length - 1];
  const nextRevNum = targetSet.currentRevision + 1;

  // Compute diff from latest revision
  const diffs = computeRuleSetConfigDiff(latestRev?.config, data.config);
  if (diffs.length === 0) {
    throw new Error('ไม่มีการเปลี่ยนแปลงค่าใดๆ ในชุดกฎ');
  }

  const now = new Date().toISOString();
  const newRevision: RuleSetRevision = {
    revision: nextRevNum,
    config: structuredClone(data.config),
    createdAt: now,
    author,
    reason,
  };

  targetSet.revisions.push(newRevision);
  targetSet.currentRevision = nextRevNum;
  targetSet.updatedAt = now;

  // If this set is active, also update active revision pointer if desired, or let user explicitly activate
  await store.set(getRuleSetsKey(modelId, version), ruleSets);

  const auditEntry: RuleSetAuditEntry = {
    id: `audit_rs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    modelId,
    modelVersion: version,
    setId: targetSet.id,
    setName: targetSet.name,
    revision: nextRevNum,
    action: 'UPDATE',
    author,
    reason,
    diffs,
  };

  await logAuditEntry(modelId, version, auditEntry);
  return { ruleSet: targetSet, newRevision, auditEntry };
}

export async function activateRuleSetRevision(
  modelId: string,
  version: string,
  setId: string,
  revisionNumber: number,
  data: {
    author: string;
    reason: string;
  },
): Promise<{ activeRuleSet: { setId: string; name: string; revision: number; config: RuleSetConfig }; auditEntry: RuleSetAuditEntry }> {
  const author = (data.author || '').trim();
  const reason = (data.reason || '').trim();
  if (!author) throw new Error('กรุณาระบุชื่อผู้เปิดใช้งาน (ห้ามเว้นว่าง)');
  if (!reason) throw new Error('กรุณาระบุเหตุผลในการเปิดใช้งาน (ห้ามเว้นว่าง)');

  const store = getStore();
  const { ruleSets, activeRuleSet: prevActive } = await listRuleSets(modelId, version);

  const targetSet = ruleSets.find(s => s.id === setId);
  if (!targetSet) throw new Error(`ไม่พบชุดกฎ "${setId}"`);

  const targetRev = targetSet.revisions.find(r => r.revision === revisionNumber);
  if (!targetRev) throw new Error(`ไม่พบ Revision ${revisionNumber} ในชุดกฎ "${targetSet.name}"`);

  // Compute diff from previously active config
  const diffs = computeRuleSetConfigDiff(prevActive.config, targetRev.config);

  const now = new Date().toISOString();
  for (const s of ruleSets) {
    if (s.id === setId) {
      s.isActive = true;
      s.activeRevision = revisionNumber;
    } else {
      s.isActive = false;
      s.activeRevision = undefined;
    }
  }

  const activePointer = { setId, revision: revisionNumber };
  await store.set(getActivePointerKey(modelId, version), activePointer);
  await store.set(getRuleSetsKey(modelId, version), ruleSets);

  const auditEntry: RuleSetAuditEntry = {
    id: `audit_rs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    modelId,
    modelVersion: version,
    setId: targetSet.id,
    setName: targetSet.name,
    revision: revisionNumber,
    action: 'ACTIVATE',
    author,
    reason,
    diffs,
  };

  await logAuditEntry(modelId, version, auditEntry);

  return {
    activeRuleSet: {
      setId: targetSet.id,
      name: targetSet.name,
      revision: revisionNumber,
      config: targetRev.config,
    },
    auditEntry,
  };
}

export async function revertRuleSetRevision(
  modelId: string,
  version: string,
  setId: string,
  targetRevisionNumber: number,
  data: {
    author: string;
    reason: string;
  },
): Promise<{ activeRuleSet: { setId: string; name: string; revision: number; config: RuleSetConfig }; auditEntry: RuleSetAuditEntry }> {
  const author = (data.author || '').trim();
  const reason = (data.reason || '').trim();
  if (!author) throw new Error('กรุณาระบุชื่อผู้ย้อนกลับ (ห้ามเว้นว่าง)');
  if (!reason) throw new Error('กรุณาระบุเหตุผลในการย้อนกลับ (ห้ามเว้นว่าง)');

  const store = getStore();
  const { ruleSets, activeRuleSet: prevActive } = await listRuleSets(modelId, version);

  const targetSet = ruleSets.find(s => s.id === setId);
  if (!targetSet) throw new Error(`ไม่พบชุดกฎ "${setId}"`);

  const targetRev = targetSet.revisions.find(r => r.revision === targetRevisionNumber);
  if (!targetRev) throw new Error(`ไม่พบ Revision ${targetRevisionNumber} ในชุดกฎ "${targetSet.name}"`);

  // Reverting activates the specified older revision without deleting subsequent revisions
  const diffs = computeRuleSetConfigDiff(prevActive.config, targetRev.config);

  const now = new Date().toISOString();
  for (const s of ruleSets) {
    if (s.id === setId) {
      s.isActive = true;
      s.activeRevision = targetRevisionNumber;
    } else {
      s.isActive = false;
      s.activeRevision = undefined;
    }
  }

  const activePointer = { setId, revision: targetRevisionNumber };
  await store.set(getActivePointerKey(modelId, version), activePointer);
  await store.set(getRuleSetsKey(modelId, version), ruleSets);

  const auditEntry: RuleSetAuditEntry = {
    id: `audit_rs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    modelId,
    modelVersion: version,
    setId: targetSet.id,
    setName: targetSet.name,
    revision: targetRevisionNumber,
    action: 'REVERT',
    author,
    reason,
    diffs,
  };

  await logAuditEntry(modelId, version, auditEntry);

  return {
    activeRuleSet: {
      setId: targetSet.id,
      name: targetSet.name,
      revision: targetRevisionNumber,
      config: targetRev.config,
    },
    auditEntry,
  };
}

export async function listRuleSetAuditLogs(
  modelId: string,
  version: string,
): Promise<RuleSetAuditEntry[]> {
  const store = getStore();
  const logs = await store.get<RuleSetAuditEntry[]>(getAuditLogsKey(modelId, version));
  return logs || [];
}

async function logAuditEntry(
  modelId: string,
  version: string,
  entry: RuleSetAuditEntry,
): Promise<void> {
  const store = getStore();
  const key = getAuditLogsKey(modelId, version);
  const existing = (await store.get<RuleSetAuditEntry[]>(key)) || [];
  const updated = [entry, ...existing].slice(0, 500); // keep newest 500
  await store.set(key, updated);
}

// ─── Simulation on Past Runs ──────────────────────────────────────────────────
export interface SimulationItemResult {
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

export function simulateRuleSetOnPastRuns(
  candidateConfig: RuleSetConfig,
  runs: MonitoringRun[],
  baseModel: any,
): SimulationItemResult[] {
  const modelWithConfig = {
    ...baseModel,
    ruleSetConfig: candidateConfig,
    thresholds: {
      ...baseModel.thresholds,
      psi_warning: candidateConfig.psi_warning,
      psi_critical: candidateConfig.psi_critical,
      auc_min: candidateConfig.auc_min,
      gini_min: candidateConfig.gini_min,
      ks_min: candidateConfig.ks_min,
    },
    driftConfig: {
      ...baseModel.driftConfig,
      labelPValueThreshold: candidateConfig.labelPValueThreshold,
      riskDecileAlertThresholdPctPoints: candidateConfig.decileAlertThresholdPctPoints,
    },
  };

  return runs.map(r => {
    // Clone run to attach ruleSetConfig for trigger evaluation without persisting
    const clonedRun: MonitoringRun = {
      ...r,
      ruleSetConfig: candidateConfig,
      thresholdsSnapshot: {
        ...r.thresholdsSnapshot,
        psi_warning: candidateConfig.psi_warning,
        psi_critical: candidateConfig.psi_critical,
        auc_min: candidateConfig.auc_min,
        gini_min: candidateConfig.gini_min,
        ks_min: candidateConfig.ks_min,
      },
    };

    const simDecision: TriggerDecision = evaluateTrigger(clonedRun, modelWithConfig, runs);
    const actualAction = r.trigger?.action || 'CONTINUE';
    const actualRuleId = r.trigger?.matchedRuleId || null;
    const simAction = simDecision.action;
    const simRuleId = simDecision.matchedRuleId || null;

    const changed = actualAction !== simAction || actualRuleId !== simRuleId;

    return {
      runId: r.runId,
      period: r.period || null,
      fileName: r.fileName,
      actualAction,
      actualRuleId,
      simulatedAction: simAction,
      simulatedRuleId: simRuleId,
      changed,
      simulatedReasons: simDecision.reasons,
    };
  });
}
