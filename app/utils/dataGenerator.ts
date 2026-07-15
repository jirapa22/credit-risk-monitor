/**
 * A-Score Scorecard Data Generator
 * Generates mock loan applicant data using real scorecard parameters
 * from the A-Score Personal Loan model.
 */

interface ScorecardBin {
  bins: number[];
  points: number[];
}

interface FeatureScorecardConfig {
  [feature: string]: ScorecardBin;
}

// Real scorecard bins & points from model development
const SCORECARD: FeatureScorecardConfig = {
  monthly_income: {
    bins: [17800, 22300, 27520, 36360], // 4 boundaries → 5 bins
    points: [-10.2, -2.1, -5.5, 13.4, 13.6],
  },
  loan_amount: {
    bins: [46000, 63000, 81000, 112000],
    points: [13.3, 4.6, -4.5, 9.6, -13.6],
  },
  dti_ratio: {
    bins: [0.264, 0.36, 0.47, 0.606],
    points: [22.4, 18.0, 17.8, -13.8, -20.7],
  },
};

const BASE_POINTS = 554.2;
// Score → PD: PD = 1 / (1 + exp((Score - 487.123) / 28.854))
const SCORE_OFFSET = 487.123;
const SCORE_FACTOR = 28.854;

/**
 * Get bin index for a value given boundaries
 */
export function getBinIndex(value: number, boundaries: number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (value <= boundaries[i]) return i;
  }
  return boundaries.length; // last bin
}

/**
 * Calculate scorecard points for a single feature value
 */
export function getFeaturePoints(feature: string, value: number): number {
  const sc = SCORECARD[feature];
  if (!sc) return 0;
  const binIdx = getBinIndex(value, sc.bins);
  return sc.points[binIdx] ?? 0;
}

/**
 * Calculate total A-Score for a customer record
 */
export function calculateAScore(customer: Record<string, number>): number {
  let score = BASE_POINTS;
  for (const [feature, sc] of Object.entries(SCORECARD)) {
    const val = customer[feature];
    if (val !== undefined) {
      const binIdx = getBinIndex(val, sc.bins);
      score += sc.points[binIdx] ?? 0;
    }
  }
  return Math.round(score * 100) / 100;
}

/**
 * Convert A-Score to Probability of Default
 * PD = 1 / (1 + exp((Score - Offset) / Factor))
 */
export function scoreToPD(score: number): number {
  const logOdds = (score - SCORE_OFFSET) / SCORE_FACTOR;
  const pd = 1 / (1 + Math.exp(logOdds));
  return Math.round(pd * 10000) / 10000;
}

/** Box-Muller normal random */
function randNormal(mean: number, std: number): number {
  let u1 = Math.random();
  let u2 = Math.random();
  if (u1 === 0) u1 = 1e-10;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

/** Clamp value between min and max */
function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Generate a single customer record
 * driftLevel: 0 = baseline, 1 = fully drifted toward higher-risk population
 */
function generateCustomer(driftLevel: number = 0): Record<string, number> & { aScore: number; pd: number; defaultLabel: number } {
  // Baseline stats from real data
  // Drift pushes toward riskier profiles:
  //   monthly_income lower, loan_amount higher, dti_ratio higher
  const driftFactor = clamp(driftLevel, 0, 1);

  const monthly_income = clamp(
    randNormal(28164 - driftFactor * 8000, 13457),
    15000, 103900
  );

  const loan_amount = clamp(
    randNormal(84268 + driftFactor * 30000, 49997),
    20000, 403000
  );

  // dti_ratio = existing_debt / monthly_income (simplified: generate directly)
  const dti_ratio = clamp(
    randNormal(0.46 + driftFactor * 0.18, 0.23),
    0.05, 2.15
  );

  const customer = { monthly_income, loan_amount, dti_ratio };
  const aScore = calculateAScore(customer);
  const pd = scoreToPD(aScore);

  // Default based on PD with added noise
  const defaultLabel = Math.random() < pd ? 1 : 0;

  return {
    monthly_income: Math.round(monthly_income),
    loan_amount: Math.round(loan_amount),
    dti_ratio: Math.round(dti_ratio * 1000) / 1000,
    aScore,
    pd,
    defaultLabel,
  };
}

/**
 * Generate a full mock dataset
 * @param n Sample size
 * @param driftLevel 0 = baseline, 0.5 = moderate drift, 1 = high drift
 */
export function generateMockDataset(
  n: number = 1000,
  driftLevel: number = 0
): Array<Record<string, number> & { aScore: number; pd: number; defaultLabel: number }> {
  return Array.from({ length: n }, () => generateCustomer(driftLevel));
}

// Legacy compatibility
export function calculateRiskScore(customer: Record<string, number>): number {
  return calculateAScore(customer);
}
