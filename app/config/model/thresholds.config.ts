/**
 * Alert threshold configuration.
 *
 * Replaces the hard-coded `psi_threshold: 0.15` in the legacy
 * model-config.json and adds a warn tier so monitoring logic can
 * distinguish "watch" from "critical" states without coupling to
 * any specific numeric constant in application code.
 *
 * Industry-standard PSI interpretation:
 *   < 0.10  — No significant shift
 *   0.10–0.25 — Moderate shift (warn)
 *   > 0.25  — Significant shift (critical)
 *
 * The thresholds here are intentionally tighter than the textbook values
 * because this model operates in a high-volume retail credit context.
 */

import type { ThresholdConfig } from './types';

export const thresholds: ThresholdConfig = {
  /** PSI above this value triggers a WARN alert in the dashboard */
  psiWarnThreshold: 0.10,
  /** PSI above this value triggers a CRITICAL alert in the dashboard */
  psiCriticalThreshold: 0.15,

  /**
   * Global CSI threshold — applied to features that do not define their own
   * `csiThreshold` override. Industry guideline: > 0.10 warrants review.
   */
  csiThreshold: 0.10,

  /**
   * Performance thresholds — if the monitored model metric falls below these
   * values, a performance-degradation alert is raised.
   *   AUC  > 0.70 — acceptable discrimination
   *   Gini > 0.40 — acceptable (= 2 × AUC − 1)
   *   KS   > 0.30 — acceptable separation
   */
  minAuc: 0.70,
  minGini: 0.40,
  minKs: 0.30,
};
