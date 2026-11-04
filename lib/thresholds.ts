/**
 * Validates + normalizes a thresholds payload coming from the dashboard.
 * Returns human-readable (Thai) errors instead of silently coercing values.
 */
import type { MonitoringThresholds } from './types';

export function parseThresholds(input: any, current: MonitoringThresholds): { value?: MonitoringThresholds; errors: string[] } {
  const errors: string[] = [];
  const num = (v: unknown, name: string, fallback: number) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    if (!Number.isFinite(n) || n < 0) { errors.push(`${name} ต้องเป็นตัวเลข ≥ 0 (ได้ "${v}")`); return fallback; }
    return n;
  };
  const t: MonitoringThresholds = {
    psi_warning: num(input?.psi_warning, 'PSI Warning', current.psi_warning),
    psi_critical: num(input?.psi_critical, 'PSI Critical', current.psi_critical),
    gini_min: num(input?.gini_min, 'Gini Min', current.gini_min),
    auc_min: num(input?.auc_min, 'AUC Min', current.auc_min),
    ks_min: num(input?.ks_min, 'KS Min', current.ks_min),
    csi_features: current.csi_features,
  };
  if (t.psi_warning >= t.psi_critical) errors.push('PSI Warning ต้องน้อยกว่า PSI Critical');
  if (t.auc_min > 1) errors.push('AUC Min ต้องไม่เกิน 1');

  if (input?.csi_features && typeof input.csi_features === 'object') {
    t.csi_features = {};
    for (const [key, cfg] of Object.entries(input.csi_features as Record<string, any>)) {
      const k = key.trim();
      if (!k) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { errors.push(`ชื่อคอลัมน์ "${k}" ไม่ถูกต้อง (ใช้ a-z, 0-9, _)`); continue; }
      const raw: unknown[] = Array.isArray(cfg?.bins) ? cfg.bins : [];
      const bins = raw.filter(v => v !== '' && v !== null).map(v => Number(v));
      if (bins.some(b => !Number.isFinite(b))) errors.push(`${k}: bin boundary ต้องเป็นตัวเลข`);
      for (let i = 1; i < bins.length; i++) if (!(bins[i] > bins[i - 1])) { errors.push(`${k}: bin boundary ต้องเรียงจากน้อยไปมากและไม่ซ้ำ`); break; }
      t.csi_features[k] = {
        label: cfg?.label || k,
        source: cfg?.source || '',
        threshold: num(cfg?.threshold, `${k} CSI Limit`, 0.10),
        bins,
        bin_labels: Array.isArray(cfg?.bin_labels) && cfg.bin_labels.length === bins.length + 1 ? cfg.bin_labels : [],
      };
    }
  }
  return errors.length ? { errors } : { value: t, errors };
}
