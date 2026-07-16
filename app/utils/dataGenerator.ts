/**
 * A-Score Scorecard Data Generator
 *
 * ข้อมูลอ้างอิง: ascore_model_report.xlsx (Development / Training set)
 * และ personal_loan_mock_data.xlsx (approved population, n=855)
 *
 * Scorecard parameters (จาก Sheet: Scorecard):
 *   Base Points = 554.2
 *   Score = Base Points + Σ Points ของแต่ละตัวแปรตาม bin ที่ลูกค้าตกอยู่
 *   PDO = 20, Base Score = 600, Base Odds = 50:1
 *   Factor = PDO / ln(2) = 28.854
 *   Offset = 487.123
 *   PD = 1 / (1 + odds), where odds = baseOdds × 2^((Score − BaseScore) / PDO)
 *
 * Baseline statistics (จาก personal_loan_mock_data.xlsx — approved only, n=855):
 *   monthly_income : mean=28,381  std=13,501  min=15,000  max=103,900
 *   loan_amount    : mean=82,595  std=46,759  min=20,000  max=403,000
 *   dti_ratio      : mean=0.44    std=0.21    min=0.05    max=1.49
 *   bad_rate       : 9.36% (80/855)
 */

interface ScorecardBin {
  bins: number[];
  points: number[];
}

interface FeatureScorecardConfig {
  [feature: string]: ScorecardBin;
}

// ── Scorecard bins & points (จาก ascore_model_report.xlsx Sheet: Scorecard) ──
const SCORECARD: FeatureScorecardConfig = {
  monthly_income: {
    // Bins (ขอบเขต): (14999.999, 17800] | (17800, 22300] | (22300, 27520] | (27520, 36360] | (36360, 103900]
    bins: [17800, 22300, 27520, 36360],
    // Points ต่อ bin (จากไฟล์): -10.2, -2.1, -5.5, 13.4, 13.6
    points: [-10.2, -2.1, -5.5, 13.4, 13.6],
  },
  loan_amount: {
    // Bins: (19999.999, 46000] | (46000, 63000] | (63000, 81000] | (81000, 112000] | (112000, 403000]
    bins: [46000, 63000, 81000, 112000],
    // Points: 13.3, 4.6, -4.5, 9.6, -13.6
    points: [13.3, 4.6, -4.5, 9.6, -13.6],
  },
  dti_ratio: {
    // Bins: (0.049, 0.264] | (0.264, 0.36] | (0.36, 0.47] | (0.47, 0.606] | (0.606, 1.49]
    bins: [0.264, 0.360, 0.470, 0.606],
    // Points: 22.4, 18.0, 17.8, -13.8, -20.7
    points: [22.4, 18.0, 17.8, -13.8, -20.7],
  },
};

// ── Scorecard calibration parameters (จาก ascore_model_report.xlsx) ──
const BASE_POINTS  = 554.2;   // กระจาย intercept — คงที่ทุกราย
const BASE_SCORE   = 600;     // Base Score ที่ Base Odds
const BASE_ODDS    = 50;      // Good:Bad odds ที่ Base Score (50:1)
const SCORE_FACTOR = 28.854;  // PDO / ln(2) = 20 / 0.6931
const SCORE_OFFSET = 487.123; // Base Score − Factor × ln(Base Odds)

// ── Baseline distribution (จาก personal_loan_mock_data.xlsx — approved only, n=855) ──
const BASELINE = {
  monthly_income: { mean: 28381, std: 13501, min: 15000, max: 103900 },
  loan_amount:    { mean: 82595, std: 46759, min: 20000, max: 403000 },
  dti_ratio:      { mean: 0.44,  std: 0.21,  min: 0.05,  max: 1.49  },
};

/**
 * Get bin index for a value given sorted boundaries.
 * Boundary convention: value ≤ boundary → assign to that bin.
 */
export function getBinIndex(value: number, boundaries: number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (value <= boundaries[i]) return i;
  }
  return boundaries.length; // last bin
}

/**
 * Calculate scorecard points for a single feature value.
 */
export function getFeaturePoints(feature: string, value: number): number {
  const sc = SCORECARD[feature];
  if (!sc) return 0;
  const binIdx = getBinIndex(value, sc.bins);
  return sc.points[binIdx] ?? 0;
}

/**
 * Calculate total A-Score for a customer record.
 * Score = Base Points + Σ bin_points_i
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
 * Convert A-Score to Probability of Default.
 * Standard scorecard formula:
 *   odds = BaseOdds × 2^((Score − BaseScore) / PDO)
 *   PD   = 1 / (1 + odds)
 *
 * Higher score → better odds → lower PD.
 */
export function scoreToPD(score: number): number {
  const oddsGoodToBad = BASE_ODDS * Math.pow(2, (score - BASE_SCORE) / (BASE_SCORE - SCORE_OFFSET) * SCORE_FACTOR / SCORE_FACTOR);
  // Simplified: use factor & offset directly
  // ln(odds) = (Score − Offset) / Factor  ← standard formula
  const logOddsGood = (score - SCORE_OFFSET) / SCORE_FACTOR;
  const odds = Math.exp(logOddsGood);
  const pd = 1 / (1 + odds);
  return Math.round(pd * 10000) / 10000;
}

/** Box-Muller transform: normally distributed random number */
function randNormal(mean: number, std: number): number {
  let u1 = Math.random();
  const u2 = Math.random();
  if (u1 === 0) u1 = 1e-10;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

/** Clamp value between min and max */
function clamp(val: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, val));
}

/**
 * Generate one synthetic customer record.
 *
 * driftLevel: 0 = baseline population (ตรงกับ development population)
 *             1 = fully drifted (higher-risk: income↓, loan↑, DTI↑)
 *
 * Baseline stats อ้างอิงจาก personal_loan_mock_data.xlsx (approved, n=855).
 * Drift parameters calibrated so that at drift=1.0, avg score drops ~30 pts.
 */
function generateCustomer(driftLevel = 0): Record<string, number> & {
  aScore: number;
  pd: number;
  defaultLabel: number;
} {
  const d = clamp(driftLevel, 0, 1);

  // monthly_income: drift ลดรายได้ลง (รายได้น้อย → ความเสี่ยงสูง)
  const monthly_income = clamp(
    randNormal(
      BASELINE.monthly_income.mean - d * 8000,
      BASELINE.monthly_income.std
    ),
    BASELINE.monthly_income.min,
    BASELINE.monthly_income.max
  );

  // loan_amount: drift เพิ่มวงเงินกู้ขึ้น (กู้มากเกิน → เสี่ยงสูง)
  const loan_amount = clamp(
    randNormal(
      BASELINE.loan_amount.mean + d * 25000,
      BASELINE.loan_amount.std
    ),
    BASELINE.loan_amount.min,
    BASELINE.loan_amount.max
  );

  // dti_ratio: drift เพิ่มภาระหนี้ต่อรายได้
  const dti_ratio = clamp(
    randNormal(
      BASELINE.dti_ratio.mean + d * 0.20,
      BASELINE.dti_ratio.std
    ),
    BASELINE.dti_ratio.min,
    BASELINE.dti_ratio.max
  );

  const customer = { monthly_income, loan_amount, dti_ratio };
  const aScore = calculateAScore(customer);
  const pd = scoreToPD(aScore);

  // Default label based on PD (Bernoulli draw)
  const defaultLabel = Math.random() < pd ? 1 : 0;

  return {
    monthly_income: Math.round(monthly_income),
    loan_amount:    Math.round(loan_amount),
    dti_ratio:      Math.round(dti_ratio * 1000) / 1000,
    aScore,
    pd,
    defaultLabel,
  };
}

/**
 * Generate a full synthetic dataset.
 * @param n           Sample size (default 1,000)
 * @param driftLevel  0 = baseline population | 1 = fully drifted
 */
export function generateMockDataset(
  n = 1000,
  driftLevel = 0
): Array<Record<string, number> & { aScore: number; pd: number; defaultLabel: number }> {
  return Array.from({ length: n }, () => generateCustomer(driftLevel));
}

// Legacy alias
export function calculateRiskScore(customer: Record<string, number>): number {
  return calculateAScore(customer);
}
