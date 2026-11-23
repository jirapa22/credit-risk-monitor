/**
 * Single source of truth for default column names and legacy response keys.
 *
 * Guarded by tests/no-hardcode.test.ts: no other file in lib/ or app/api/
 * may hard-code these column or feature identifiers outside comments.
 */

export const DEFAULT_ID_COLUMN = 'customer_id';
export const DEFAULT_DATE_COLUMN = 'application_date';
export const DEFAULT_LABEL_COLUMN = 'default_flag';
export const LEGACY_SCORE_KEY = 'aScore';

/**
 * ขนาดสูงสุดของข้อมูลที่ส่งเข้า API อัตโนมัติ (ไบต์) — ค่าเริ่มต้นเชิงปฏิบัติ 10 MB
 */
export const DEFAULT_MAX_INGEST_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * จำนวนไฟล์สูงสุดที่ดึงและประมวลผลต่อรอบการทำงาน 1 ครั้ง (งาน C) — ป้องกันเวลาประมวลผลเกิน Serverless Timeout
 */
export const DEFAULT_MAX_PULL_FILES_PER_RUN = 3;

/**
 * จำนวนประวัติการดึงข้อมูลล่าสุดที่บันทึกต่อโมเดลใน KV
 */
export const DEFAULT_MAX_PULL_HISTORY_ENTRIES = 50;

/**
 * ค่าเริ่มต้นเชิงปฏิบัติที่ผู้พัฒนาตั้งไว้ (PSI 0.10/0.25 เป็นกฎหัวแม่มือ ไม่ใช่ข้อบังคับ) ผู้ใช้ปรับได้ต่อโมเดล
 */
export const DEFAULT_PSI_WARNING = 0.10;
export const DEFAULT_PSI_CRITICAL = 0.25;

/**
 * ค่าเริ่มต้นเชิงปฏิบัติที่ผู้พัฒนาตั้งไว้ ผู้ใช้ปรับได้ต่อโมเดล
 */
export const DEFAULT_AUC_MIN = 0.55;
export const DEFAULT_GINI_MIN = 0.10;
export const DEFAULT_KS_MIN = 0.10;

/**
 * เกณฑ์ส่วนต่างสัดส่วนกลุ่มความเสี่ยงสูง (Decile เสี่ยงสูงสุด) เทียบกับ Reference ที่ต้องเริ่มแจ้งเตือน (percentage points)
 * ค่าเริ่มต้นเชิงปฏิบัติที่ผู้พัฒนาตั้งไว้ (ปรับได้ผ่านชุดกฎ ไม่ได้ปรับจากข้อมูลทดลอง)
 */
export const RISK_DECILE_ALERT_THRESHOLD_PCT_POINTS = 5.0;

export interface ModelColumnConfig {
  idColumn: string;
  dateColumn: string | null;
  labelColumn: string | null;
  scoreColumn: string | null;
}

/**
 * Resolve column configuration from either a BaselineVersion-style `columns`
 * object or top-level model fields, falling back to code defaults.
 */
export function resolveModelColumns(model?: {
  idColumn?: string;
  dateColumn?: string | null;
  labelColumn?: string | null;
  scoreColumn?: string | null;
  columns?: {
    idColumn?: string;
    dateColumn?: string | null;
    labelColumn?: string | null;
    scoreColumn?: string | null;
  };
} | null): ModelColumnConfig {
  const c = model?.columns;
  const idColumn = c?.idColumn ?? model?.idColumn ?? DEFAULT_ID_COLUMN;
  const dateColumn =
    c && 'dateColumn' in c
      ? (c.dateColumn ?? null)
      : model && 'dateColumn' in model
      ? (model.dateColumn ?? null)
      : DEFAULT_DATE_COLUMN;
  const labelColumn =
    c && 'labelColumn' in c
      ? (c.labelColumn ?? null)
      : model && 'labelColumn' in model
      ? (model.labelColumn ?? null)
      : DEFAULT_LABEL_COLUMN;
  const scoreColumn = c?.scoreColumn ?? model?.scoreColumn ?? null;
  return { idColumn, dateColumn, labelColumn, scoreColumn };
}

/**
 * Collect special (non-feature) column names for a model so they can be
 * excluded when scanning feature columns dynamically.
 */
export function getSpecialColumnSet(model?: Parameters<typeof resolveModelColumns>[0]): Set<string> {
  const cols = resolveModelColumns(model);
  const set = new Set<string>([DEFAULT_ID_COLUMN, DEFAULT_DATE_COLUMN, DEFAULT_LABEL_COLUMN]);
  if (cols.idColumn) set.add(cols.idColumn);
  if (cols.dateColumn) set.add(cols.dateColumn);
  if (cols.labelColumn) set.add(cols.labelColumn);
  if (cols.scoreColumn) set.add(cols.scoreColumn);
  return set;
}

