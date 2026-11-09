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

