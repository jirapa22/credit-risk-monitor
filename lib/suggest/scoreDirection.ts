/**
 * Automatic Score Direction Detector (Step 10c.A).
 *
 * Computes AUC in both directions (`higher_is_safer` and `higher_is_riskier`)
 * against the Reference dataset's binary label column, and chooses the
 * direction that achieves AUC > 0.5.
 * Returns `null` when labels or scores are unavailable or contain only one class.
 */
import { calculateAUC, type DataPoint } from '../stats';
import type { ScoreDirectionSuggestion } from './types';

export function detectScoreDirection(
  scoresOrRows: (number | null | undefined)[] | Record<string, unknown>[],
  labelsOrScoreCol: (number | null | undefined)[] | string,
  labelCol?: string,
): ScoreDirectionSuggestion | null {
  let scores: (number | null | undefined)[];
  let labels: (number | null | undefined)[];

  if (typeof labelsOrScoreCol === 'string' && labelCol) {
    const rows = scoresOrRows as Record<string, unknown>[];
    scores = rows.map(r => {
      const v = r[labelsOrScoreCol];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });
    labels = rows.map(r => {
      const v = r[labelCol];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });
  } else {
    scores = scoresOrRows as (number | null | undefined)[];
    labels = labelsOrScoreCol as (number | null | undefined)[];
  }

  const n = Math.min(scores.length, labels.length);
  if (n === 0) return null;

  const pts: DataPoint[] = [];
  let bads = 0;
  let goods = 0;
  for (let i = 0; i < n; i++) {
    const s = scores[i];
    const l = labels[i];
    if (typeof s === 'number' && Number.isFinite(s) && (l === 0 || l === 1)) {
      pts.push({ score: s, label: l });
      if (l === 1) bads++;
      else goods++;
    }
  }

  if (bads === 0 || goods === 0) {
    return null;
  }

  const rawSafer = calculateAUC(pts, 'higher_is_safer');
  const rawRiskier = calculateAUC(pts, 'higher_is_riskier');
  const aucSafer = +rawSafer.toFixed(4);
  const aucRiskier = +rawRiskier.toFixed(4);

  if (Math.abs(rawSafer - 0.5) < 1e-6 && Math.abs(rawRiskier - 0.5) < 1e-6) {
    return null;
  }

  if (rawSafer >= rawRiskier) {
    return {
      direction: 'higher_is_safer',
      auc: aucSafer,
      aucSafer,
      aucRiskier,
      reason: `คะแนนสูง = เสี่ยงต่ำ (AUC = ${aucSafer.toFixed(2)} เทียบกับทิศทางตรงข้าม ${aucRiskier.toFixed(2)})`,
    };
  }

  return {
    direction: 'higher_is_riskier',
    auc: aucRiskier,
    aucSafer,
    aucRiskier,
    reason: `คะแนนสูง = เสี่ยงสูง / PD (AUC = ${aucRiskier.toFixed(2)} เทียบกับทิศทางตรงข้าม ${aucSafer.toFixed(2)})`,
  };
}

