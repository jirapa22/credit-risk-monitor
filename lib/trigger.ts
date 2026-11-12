/**
 * MLOps Trigger & Recommended Action Engine (Step 9 — Slide 12 Step 6: Monitoring → Trigger).
 *
 * Design principles:
 *   1. Rules are data (`TriggerRule[]`), never hard-coded if-else chains.
 *   2. `evaluateTrigger(run, model, history)` validates `model.triggerConfig` at load time
 *      (unique rule IDs, known condition types). If invalid, it falls back to `DEFAULT_TRIGGER_RULES`
 *      and emits a warning.
 *   3. Unavailable data (`NOT_AVAILABLE`) never triggers a positive `sectionStatus` condition.
 */
import type {
  DriftSectionStatus,
  DriftStatus,
  MonitoringRun,
  TriggerCondition,
  TriggerDecision,
  TriggerEvidence,
  TriggerRule,
  TriggerSectionName,
} from './types';
import { getReferenceMeta } from './reference';

const STATUS_RANK: Record<DriftStatus, number> = {
  STABLE: 0,
  WARNING: 1,
  CRITICAL: 2,
};

const KNOWN_CONDITION_TYPES = new Set([
  'validationBlocked',
  'sectionStatus',
  'driftResolvedByExclusion',
  'flaggedPctAbove',
  'persistence',
  'not',
]);

const KNOWN_SECTIONS = new Set<TriggerSectionName>([
  'covariate',
  'missing',
  'label',
  'concept',
  'overall',
]);

const KNOWN_AT_LEAST = new Set(['WARNING', 'CRITICAL']);

// ─── Default Trigger Rules (R1–R9 in priority order) ─────────────────────────
export const DEFAULT_TRIGGER_RULES: TriggerRule[] = [
  {
    id: 'R1',
    priority: 1,
    when: [{ type: 'validationBlocked' }],
    action: 'BLOCKED_INVALID_DATA',
    severity: 'critical',
    message: 'แก้ไฟล์แล้วอัปโหลดใหม่',
    recommendedSteps: [
      'ตรวจสอบรายการข้อผิดพลาดระดับไฟล์และระดับแถวในส่วน Data Validation',
      'แก้ไขชื่อคอลัมน์ ชนิดข้อมูล หรือค่าที่อยู่นอกช่วงที่กำหนดในไฟล์ต้นทาง',
      'อัปโหลดไฟล์ที่แก้ไขแล้วใหม่อีกครั้งเพื่อเริ่มการตรวจวัด Drift',
    ],
  },
  {
    id: 'R2',
    priority: 2,
    when: [
      { type: 'driftResolvedByExclusion' },
    ],
    action: 'INVESTIGATE_DATA',
    severity: 'warning',
    message: 'สัญญาณ drift น่าจะมาจากข้อมูลผิด ตรวจแถวที่โดนธงก่อนสรุป',
    recommendedSteps: [
      'ตรวจสอบรายการแถวที่ถูกปักธงในชั้น Anomaly Screening (IQR / MAD / Cross-field / Isolation Forest / LOF)',
      'ยืนยันกับระบบต้นทางว่าแถวที่ผิดปกติเกิดจากความผิดพลาดของข้อมูล (เช่น หน่วยผิด หรือกรอกศูนย์เกิน) หรือเป็นลูกค้าจริง',
      'หากเป็นข้อมูลผิดพลาด ให้คัดกรองแถวดังกล่าวออก (Exclude Rows) เพื่อคำนวณ Drift ทางการใหม่',
    ],
  },
  {
    id: 'R3',
    priority: 3,
    when: [{ type: 'sectionStatus', section: 'missing', atLeast: 'CRITICAL' }],
    action: 'INVESTIGATE_DATA',
    severity: 'warning',
    message: 'ตรวจระบบต้นทาง ค่าว่างเพิ่มผิดปกติ (missing-as-a-feature)',
    recommendedSteps: [
      'ตรวจสอบ Pipeline ดึงข้อมูลและระบบรับใบสมัครต้นทางว่ามีการเปลี่ยนแปลง Schema หรือฟิลด์ส่งค่าว่างมาผิดปกติหรือไม่',
      'ตรวจสอบสัดส่วนการเติมค่า (Imputation Rate) ว่ารบกวนคะแนนของโมเดลหรือไม่',
      'ประสานทีมวิศวกรรมข้อมูลเพื่อแก้ไขต้นทางก่อนนำผลคะแนนไปใช้ตัดสินใจ',
    ],
  },
  {
    id: 'R4',
    priority: 4,
    when: [{ type: 'sectionStatus', section: 'concept', atLeast: 'CRITICAL' }],
    action: 'CONSIDER_RETRAIN',
    severity: 'critical',
    message: 'ความสัมพันธ์ระหว่างตัวแปรกับหนี้เสียเปลี่ยน โมเดลอาจใช้ไม่ได้แล้ว',
    recommendedSteps: [
      'ตรวจสอบค่า AUC, Gini และ KS รวมถึง Bad Rate ราย Bin เทียบกับชุดข้อมูลอ้างอิง (Reference Dataset)',
      'วิเคราะห์ตัวแปรที่อัตราหนี้เสียราย Bin เปลี่ยนแปลงไปจากทิศทางของคะแนนเดิม',
      'วางแผนพัฒนาโมเดลใหม่ (Retrain / Refit Scorecard) ด้วยข้อมูลที่มีผลลัพธ์ (Outcome Period) ล่าสุด',
    ],
  },
  {
    id: 'R5',
    priority: 5,
    when: [
      { type: 'sectionStatus', section: 'label', atLeast: 'CRITICAL' },
      {
        type: 'not',
        condition: { type: 'sectionStatus', section: 'concept', atLeast: 'WARNING' },
      },
    ],
    action: 'RECALIBRATE',
    severity: 'warning',
    message: 'อัตราหนี้เสียเปลี่ยนแต่ความสามารถจัดอันดับยังดี พิจารณาปรับ cut-off หรือ calibration แทนการ retrain',
    recommendedSteps: [
      'ความสามารถในการเรียงลำดับความเสี่ยง (Gini / AUC) ยังคงดีอยู่ จึงยังไม่จำเป็นต้องพัฒนาโมเดลใหม่ทั้งหมด',
      'ปรับพารามิเตอร์ Calibration (Offset / Base Odds) เพื่อให้ค่า PD สอดคล้องกับอัตราหนี้เสียจริงปัจจุบัน',
      'ทบทวนเกณฑ์คะแนนอนุมัติ (Score Cut-off) ให้สอดคล้องกับระดับความเสี่ยงที่ยอมรับได้ (Risk Appetite)',
    ],
  },
  {
    id: 'R6',
    priority: 6,
    when: [{ type: 'persistence', section: 'covariate', atLeast: 'CRITICAL', runs: 2 }],
    action: 'CONSIDER_RETRAIN',
    severity: 'critical',
    message: 'พบการเลื่อนของการกระจายตัวแปร (Covariate Drift) ระดับวิกฤตต่อเนื่องกัน 2 รอบ พิจารณาพัฒนาโมเดลใหม่ (Retrain)',
    recommendedSteps: [
      'การเปลี่ยนแปลงโครงสร้างประชากรลูกค้าเกิดขึ้นต่อเนื่องอย่างน้อย 2 รอบการติดตาม ไม่ใช่ความผันผวนชั่วคราว',
      'ประเมินผลกระทบของการเลื่อนตัวแปรต่อการกระจายคะแนน (PSI) และสัดส่วนลูกค้าในแต่ละเกรดความเสี่ยง',
      'เตรียมชุดข้อมูลล่าสุดเพื่อพิจารณา Retrain หรือปรับ Binning / น้ำหนักคะแนนของตัวแปรที่เปลี่ยนไป',
    ],
  },
  {
    id: 'R7',
    priority: 7,
    when: [{ type: 'sectionStatus', section: 'covariate', atLeast: 'CRITICAL' }],
    action: 'INVESTIGATE_DRIFT',
    severity: 'warning',
    message: 'ลักษณะลูกค้าเปลี่ยน ติดตามรอบถัดไป ถ้ายังเกิดซ้ำให้พิจารณา retrain',
    recommendedSteps: [
      'ตรวจสอบตัวแปรที่มีค่า CSI, KS D หรือ Wasserstein สูงถึงระดับ CRITICAL ว่าเกิดจากแคมเปญการตลาดหรือกลุ่มลูกค้าใหม่หรือไม่',
      'ติดตามผลการรันในรอบถัดไปอย่างใกล้ชิด หากเกิดซ้ำต่อเนื่องระบบจะยกระดับเป็น CONSIDER_RETRAIN',
    ],
  },
  {
    id: 'R8b',
    priority: 8,
    when: [{ type: 'flaggedPctAbove', multiplierOfReference: 2 }],
    action: 'INVESTIGATE_DATA',
    severity: 'warning',
    message: 'พบแถวผิดปกติมากกว่าปกติ แม้ยังไม่กระทบตัวชี้วัด drift — ตรวจแถวที่โดนธงก่อนใช้ข้อมูลรอบนี้',
    recommendedSteps: [
      'ตรวจสอบรายการแถวที่ถูกปักธงในชั้น Anomaly Screening',
      'ยืนยันความถูกต้องของข้อมูลกับระบบต้นทางก่อนนำผลคะแนนรอบนี้ไปใช้งาน',
    ],
  },
  {
    id: 'R8',
    priority: 9,
    when: [{ type: 'sectionStatus', section: 'overall', atLeast: 'WARNING' }],
    action: 'MONITOR_CLOSELY',
    severity: 'info',
    message: 'พบสัญญาณเตือนระดับเฝ้าระวัง ติดตามผลในรอบถัดไปอย่างใกล้ชิด',
    recommendedSteps: [
      'ตรวจสอบส่วนที่มีสถานะ WARNING ใน Drift Report เพื่อดูแนวโน้มการเปลี่ยนแปลง',
      'ยังสามารถใช้งานโมเดลต่อได้ตามปกติ และติดตามผลในรอบการอัปโหลดถัดไป',
    ],
  },
  {
    id: 'R9',
    priority: 10,
    when: [],
    action: 'CONTINUE',
    severity: 'info',
    message: 'ข้อมูลและประสิทธิภาพโมเดลอยู่ในเกณฑ์ปกติ สามารถใช้งานโมเดลต่อไปได้ตามปกติ',
    recommendedSteps: [
      'ดำเนินการใช้งานโมเดลตามปกติ และอัปโหลดข้อมูลตามรอบการติดตามถัดไป',
    ],
  },
];

// ─── Config Validation ───────────────────────────────────────────────────────
function validateCondition(cond: unknown, ruleId: string): string | null {
  if (!cond || typeof cond !== 'object') {
    return `กฎ "${ruleId}" มี condition ที่ไม่ใช่ object`;
  }
  const c = cond as Record<string, unknown>;
  if (typeof c.type !== 'string' || !KNOWN_CONDITION_TYPES.has(c.type)) {
    return `กฎ "${ruleId}" ใช้ชนิดเงื่อนไขที่ไม่รู้จัก "${String(c.type)}"`;
  }
  switch (c.type) {
    case 'validationBlocked':
    case 'driftResolvedByExclusion':
      return null;
    case 'sectionStatus':
      if (!KNOWN_SECTIONS.has(c.section as TriggerSectionName)) {
        return `กฎ "${ruleId}" ระบุ section ไม่ถูกต้อง "${String(c.section)}"`;
      }
      if (!KNOWN_AT_LEAST.has(String(c.atLeast))) {
        return `กฎ "${ruleId}" ระบุ atLeast ไม่ถูกต้อง "${String(c.atLeast)}"`;
      }
      return null;
    case 'flaggedPctAbove':
      if (typeof c.multiplierOfReference !== 'number' || !Number.isFinite(c.multiplierOfReference) || c.multiplierOfReference <= 0) {
        return `กฎ "${ruleId}" ต้องระบุ multiplierOfReference > 0`;
      }
      return null;
    case 'persistence':
      if (!KNOWN_SECTIONS.has(c.section as TriggerSectionName)) {
        return `กฎ "${ruleId}" ระบุ section ไม่ถูกต้อง "${String(c.section)}"`;
      }
      if (!KNOWN_AT_LEAST.has(String(c.atLeast))) {
        return `กฎ "${ruleId}" ระบุ atLeast ไม่ถูกต้อง "${String(c.atLeast)}"`;
      }
      if (typeof c.runs !== 'number' || !Number.isInteger(c.runs) || c.runs < 1) {
        return `กฎ "${ruleId}" ต้องระบุ runs เป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป`;
      }
      return null;
    case 'not':
      return validateCondition(c.condition, ruleId);
    default:
      return `กฎ "${ruleId}" ใช้ชนิดเงื่อนไขที่ไม่รู้จัก "${String(c.type)}"`;
  }
}

export function resolveTriggerRules(model: any): { rules: TriggerRule[]; warnings: string[] } {
  const customRules = model?.triggerConfig?.rules;
  if (customRules === undefined || customRules === null) {
    return { rules: [...DEFAULT_TRIGGER_RULES].sort((a, b) => a.priority - b.priority), warnings: [] };
  }
  const warnings: string[] = [];
  if (!Array.isArray(customRules) || customRules.length === 0) {
    warnings.push('triggerConfig.rules ต้องเป็น array ที่ไม่ว่าง — ระบบใช้ DEFAULT_TRIGGER_RULES แทน');
    return { rules: [...DEFAULT_TRIGGER_RULES].sort((a, b) => a.priority - b.priority), warnings };
  }

  const seenIds = new Set<string>();
  for (const r of customRules) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || r.id.trim() === '') {
      warnings.push('พบกฎใน triggerConfig ที่ไม่มี id — ระบบใช้ DEFAULT_TRIGGER_RULES แทน');
      return { rules: [...DEFAULT_TRIGGER_RULES].sort((a, b) => a.priority - b.priority), warnings };
    }
    if (seenIds.has(r.id)) {
      warnings.push(`พบ rule id ซ้ำกันใน triggerConfig ("${r.id}") — ระบบใช้ DEFAULT_TRIGGER_RULES แทน`);
      return { rules: [...DEFAULT_TRIGGER_RULES].sort((a, b) => a.priority - b.priority), warnings };
    }
    seenIds.add(r.id);

    if (!Array.isArray(r.when)) {
      warnings.push(`กฎ "${r.id}" ไม่มีรายการเงื่อนไข when ที่เป็น array — ระบบใช้ DEFAULT_TRIGGER_RULES แทน`);
      return { rules: [...DEFAULT_TRIGGER_RULES].sort((a, b) => a.priority - b.priority), warnings };
    }
    for (const cond of r.when) {
      const err = validateCondition(cond, r.id);
      if (err) {
        warnings.push(`${err} — ระบบใช้ DEFAULT_TRIGGER_RULES แทน`);
        return { rules: [...DEFAULT_TRIGGER_RULES].sort((a, b) => a.priority - b.priority), warnings };
      }
    }
  }

  return {
    rules: [...(customRules as TriggerRule[])].sort((a, b) => a.priority - b.priority),
    warnings,
  };
}

// ─── Condition Interpreter ───────────────────────────────────────────────────
function getSectionStatus(run: MonitoringRun, section: TriggerSectionName): DriftSectionStatus {
  if (!run.validation.ok) return 'NOT_AVAILABLE';
  const dr = run.driftReport;
  if (section === 'overall') {
    if (dr?.summary?.overallStatus) return dr.summary.overallStatus;
    if (run.drift?.overallStatus) return run.drift.overallStatus;
    return 'NOT_AVAILABLE';
  }
  if (!dr) {
    // Fallback if a legacy MonitoringRun only had run.drift without run.driftReport
    if (section === 'covariate' && run.drift) return run.drift.overallStatus;
    return 'NOT_AVAILABLE';
  }
  return dr[section]?.status ?? 'NOT_AVAILABLE';
}

function sectionMeetsAtLeast(
  status: DriftSectionStatus,
  atLeast: 'WARNING' | 'CRITICAL',
): boolean {
  if (status === 'NOT_AVAILABLE') return false;
  return STATUS_RANK[status] >= STATUS_RANK[atLeast];
}

function describeSectionEvidence(run: MonitoringRun, section: TriggerSectionName): string {
  const dr = run.driftReport;
  if (!dr) {
    if (section === 'overall' || section === 'covariate') {
      return `สถานะ Drift = ${run.drift?.overallStatus ?? 'N/A'} (PSI=${(run.drift?.psi.value ?? 0).toFixed(4)})`;
    }
    return `ส่วน ${section} ไม่มีข้อมูล`;
  }
  switch (section) {
    case 'covariate':
      return `Covariate Drift = ${dr.covariate.status}: ${dr.covariate.reason}`;
    case 'missing':
      return `Missing Drift = ${dr.missing.status}: ${dr.missing.reason}`;
    case 'label':
      return `Label Drift = ${dr.label.status}: ${dr.label.reason}`;
    case 'concept':
      return `Concept Drift = ${dr.concept.status}: ${dr.concept.reason}`;
    case 'overall':
      return `Overall Drift = ${dr.summary.overallStatus}: ${dr.summary.reason}`;
  }
}

function getReferenceFlaggedPct(run: MonitoringRun): number {
  if (!run.anomaly) return 0;
  const refMeta = getReferenceMeta(run.referenceId);
  const refTotal = refMeta?.rowCount ?? 855;
  if (refTotal <= 0) return 0;
  return (run.anomaly.referenceFlaggedCount / refTotal) * 100;
}

interface ConditionEvalResult {
  matched: boolean;
  reason: string;
}

function evaluateCondition(
  cond: TriggerCondition,
  run: MonitoringRun,
  history: MonitoringRun[],
): ConditionEvalResult {
  switch (cond.type) {
    case 'validationBlocked': {
      const blocked = !run.validation.ok;
      const errMsgs = run.validation.blockingErrors.map(e => e.message).join('; ');
      return {
        matched: blocked,
        reason: blocked
          ? `ไม่ผ่านการตรวจสอบความถูกต้องของข้อมูล (ถูกปฏิเสธ ${run.validation.rejectedRows}/${run.validation.totalRows} แถว = ${run.validation.rejectedPct.toFixed(1)}%${errMsgs ? `, สาเหตุ: ${errMsgs}` : ''})`
          : `ผ่านการตรวจสอบความถูกต้องของข้อมูล (${run.validation.validRows}/${run.validation.totalRows} แถว)`,
      };
    }

    case 'sectionStatus': {
      const status = getSectionStatus(run, cond.section);
      const matched = sectionMeetsAtLeast(status, cond.atLeast);
      return {
        matched,
        reason: describeSectionEvidence(run, cond.section),
      };
    }

    case 'driftResolvedByExclusion': {
      if (!run.validation.ok || !run.drift) {
        return { matched: false, reason: 'ยังไม่มีผลคำนวณ Drift ทางการ' };
      }
      const officialStatus = run.drift.overallStatus;
      const covStatus = run.driftReport?.covariate?.status ?? 'STABLE';
      const officialAlarm = officialStatus !== 'STABLE';
      const covAlarm = covStatus === 'WARNING' || covStatus === 'CRITICAL';
      const alarmBefore = officialAlarm || covAlarm;

      if (!alarmBefore) {
        return {
          matched: false,
          reason: `ทั้ง Drift ทางการ (${officialStatus}) และ DriftReport Covariate (${covStatus}) ปกติ ไม่ได้เตือนก่อนตัดแถว`,
        };
      }

      const hasFlags = Boolean(run.anomaly && run.anomaly.flaggedRows && run.anomaly.flaggedRows.length > 0);
      if (!hasFlags) {
        return { matched: false, reason: 'ไม่มีแถวที่โดนปักธง จึงไม่สามารถตัดแถวเพื่อแก้ drift ได้' };
      }

      const officialExclStatus = run.driftExcludingFlagged?.overallStatus ?? 'STABLE';
      const covExclStatus = run.driftReportExcludingFlagged?.covariate?.status ?? 'STABLE';

      const officialStableAfter = officialExclStatus === 'STABLE';
      const covStableAfter = covExclStatus === 'STABLE';

      const matched = officialStableAfter && covStableAfter;
      return {
        matched,
        reason: matched
          ? `Drift ก่อนตัดแถวแจ้งเตือน (ทางการ=${officialStatus}, Covariate=${covStatus}) แต่เมื่อตัดแถวที่โดนธงออกแล้วกลับเป็น STABLE ทั้งคู่ (ทางการ=${officialExclStatus}, Covariate=${covExclStatus})`
          : `ก่อนตัดแถว: ทางการ=${officialStatus}, Covariate=${covStatus} | หลังตัดแถว: ทางการ=${officialExclStatus}, Covariate=${covExclStatus} (ยังไม่ STABLE ทั้งคู่)`,
      };
    }

    case 'flaggedPctAbove': {
      if (!run.validation.ok || !run.anomaly) {
        return { matched: false, reason: 'ไม่มีผลตรวจ Anomaly Screening' };
      }
      const actualPct = run.anomaly.flaggedPct;
      const refPct = getReferenceFlaggedPct(run);
      const thresholdPct = cond.multiplierOfReference * refPct;
      const matched = actualPct > thresholdPct && actualPct > 0;
      return {
        matched,
        reason: `แถวที่ถูกปักธงมี ${run.anomaly.flaggedRowCount}/${run.anomaly.totalRows} แถว (${actualPct.toFixed(2)}%) เปรียบเทียบกับ ${cond.multiplierOfReference}× ของ Reference (${cond.multiplierOfReference} × ${refPct.toFixed(2)}% = ${thresholdPct.toFixed(2)}%)`,
      };
    }

    case 'persistence': {
      const currentStatus = getSectionStatus(run, cond.section);
      const currentMatched = sectionMeetsAtLeast(currentStatus, cond.atLeast);
      if (!currentMatched) {
        return {
          matched: false,
          reason: `รอบปัจจุบัน ${cond.section} มีสถานะ ${currentStatus} (ไม่ถึง ${cond.atLeast})`,
        };
      }
      if (cond.runs <= 1) {
        return {
          matched: true,
          reason: `${describeSectionEvidence(run, cond.section)} (ครบ 1 รอบ)`,
        };
      }

      // Filter history to the same (modelId, referenceId, configVersion) excluding the current runId
      const sameLineage = history.filter(
        h =>
          h &&
          h.kind === 'monitoring' &&
          h.model?.modelId === run.model?.modelId &&
          h.referenceId === run.referenceId &&
          (!run.model?.configVersion || !h.model?.configVersion || h.model.configVersion === run.model.configVersion) &&
          h.runId !== run.runId,
      );

      // Sort newest first by createdAt (preserving order when timestamps are equal)
      const sortedPrior = [...sameLineage].sort((a, b) => {
        const ta = Date.parse(a.createdAt || '');
        const tb = Date.parse(b.createdAt || '');
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
        return 0;
      });

      const neededPrior = cond.runs - 1;
      if (sortedPrior.length < neededPrior) {
        return {
          matched: false,
          reason: `ประวัติการรันก่อนหน้าของโมเดล "${run.model.modelId}" (Reference "${run.referenceId}") มีเพียง ${sortedPrior.length} รอบ (ต้องการ ${neededPrior} รอบก่อนหน้าเพื่อครบ ${cond.runs} รอบต่อเนื่อง)`,
        };
      }

      const recentPrior = sortedPrior.slice(0, neededPrior);
      const allPriorMatched = recentPrior.every(h =>
        sectionMeetsAtLeast(getSectionStatus(h, cond.section), cond.atLeast),
      );
      return {
        matched: allPriorMatched,
        reason: allPriorMatched
          ? `พบสถานะ ${cond.section} ≥ ${cond.atLeast} ต่อเนื่องครบ ${cond.runs} รอบล่าสุด (รวมรอบปัจจุบันและรันก่อนหน้า: ${recentPrior.map(r => r.runId).join(', ')}) — ${describeSectionEvidence(run, cond.section)}`
          : `รันก่อนหน้าไม่เกิด ${cond.section} ≥ ${cond.atLeast} ต่อเนื่องครบ ${cond.runs} รอบ`,
      };
    }

    case 'not': {
      const inner = evaluateCondition(cond.condition, run, history);
      return {
        matched: !inner.matched,
        reason: !inner.matched
          ? `ไม่เกิดเงื่อนไขตรงข้าม (${inner.reason})`
          : `เกิดเงื่อนไขที่ห้าม (${inner.reason})`,
      };
    }
  }
}

function buildEvidence(run: MonitoringRun): TriggerEvidence {
  const refFlaggedPct = getReferenceFlaggedPct(run);
  return {
    validation: {
      ok: run.validation.ok,
      totalRows: run.validation.totalRows,
      validRows: run.validation.validRows,
      rejectedRows: run.validation.rejectedRows,
      rejectedPct: run.validation.rejectedPct,
      blockingErrorCount: run.validation.blockingErrors.length,
    },
    anomaly: run.anomaly
      ? {
          flaggedRowCount: run.anomaly.flaggedRowCount,
          flaggedPct: run.anomaly.flaggedPct,
          referenceFlaggedCount: run.anomaly.referenceFlaggedCount,
          referenceFlaggedPct: +refFlaggedPct.toFixed(2),
          byMethod: run.anomaly.byMethod,
        }
      : null,
    driftReport: run.driftReport
      ? {
          overallStatus: run.driftReport.summary.overallStatus,
          driftTypesDetected: run.driftReport.summary.driftTypesDetected,
          covariateStatus: run.driftReport.covariate.status,
          missingStatus: run.driftReport.missing.status,
          labelStatus: run.driftReport.label.status,
          conceptStatus: run.driftReport.concept.status,
          officialDriftStatus: run.drift?.overallStatus ?? null,
          driftExcludingFlaggedStatus: run.driftExcludingFlagged?.overallStatus ?? null,
        }
      : run.drift
        ? {
            overallStatus: run.drift.overallStatus,
            driftTypesDetected: run.drift.triggered,
            officialDriftStatus: run.drift.overallStatus,
            driftExcludingFlaggedStatus: run.driftExcludingFlagged?.overallStatus ?? null,
          }
        : null,
  };
}

export function evaluateTrigger(
  run: MonitoringRun,
  model: any,
  history: MonitoringRun[] = [],
): TriggerDecision {
  const { rules, warnings: configWarnings } = resolveTriggerRules(model);
  const evidence = buildEvidence(run);

  for (const rule of rules) {
    const evals = rule.when.map(cond => evaluateCondition(cond, run, history));
    if (evals.every(e => e.matched)) {
      let ruleMessage = rule.message;
      if (rule.id === 'R8b' && run.anomaly) {
        const actualPct = run.anomaly.flaggedPct.toFixed(1);
        const refPct = getReferenceFlaggedPct(run).toFixed(1);
        ruleMessage = `พบแถวผิดปกติมากกว่าปกติ ${actualPct}% (ปกติ ${refPct}%) แม้ยังไม่กระทบตัวชี้วัด drift — ตรวจแถวที่โดนธงก่อนใช้ข้อมูลรอบนี้`;
      }
      const reasons: string[] = [
        `[${rule.id}] ${ruleMessage}`,
        ...evals.map(e => e.reason),
      ];
      if (rule.when.length === 0 && run.driftReport) {
        reasons.push(
          `สรุปผล Drift Report: สถานะรวม = ${run.driftReport.summary.overallStatus} (${run.driftReport.summary.reason})`,
        );
      }
      return {
        action: rule.action,
        severity: rule.severity,
        matchedRuleId: rule.id,
        reasons,
        evidence,
        recommendedSteps: [...rule.recommendedSteps],
        requiresHumanReview: rule.action !== 'CONTINUE',
        ...(configWarnings.length > 0 ? { configWarnings } : {}),
      };
    }
  }

  // Fallback if custom rules had no catch-all rule and none matched
  return {
    action: 'CONTINUE',
    severity: 'info',
    matchedRuleId: 'DEFAULT_CONTINUE',
    reasons: ['ไม่มีกฎใดตรงตามเงื่อนไข — ดำเนินการใช้งานโมเดลต่อไปตามปกติ'],
    evidence,
    recommendedSteps: ['ดำเนินการใช้งานโมเดลตามปกติ และติดตามผลในรอบถัดไป'],
    requiresHumanReview: false,
    ...(configWarnings.length > 0 ? { configWarnings } : {}),
  };
}

