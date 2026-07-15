/**
 * Feature configuration for the Ascore Personal Loan model.
 *
 * Each feature entry contains:
 *   - Source and transformation documentation
 *   - WOE scorecard bins with points, bad rates, and baseline distribution (pct)
 *   - Information Value (IV) — computed from training data
 *
 * Accepted CSV columns: monthly_income, loan_amount, dti_ratio, default_flag
 *
 * Excluded columns (data leakage — DO NOT include in monitoring uploads):
 *   credit_score, risk_grade, interest_rate_pct, current_dpd, outstanding_balance
 *
 * Bin boundary convention:
 *   lowerBound — exclusive lower bound (value > lowerBound), null = −∞
 *   upperBound — inclusive upper bound (value ≤ upperBound), null = +∞
 */

import type { FeatureConfig } from './types';

export const features: FeatureConfig[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // feat_001 — Monthly Income
  // ─────────────────────────────────────────────────────────────────────────
  {
    featureId: 'feat_001',
    displayName: 'Monthly Income',
    columnName: 'monthly_income',
    source: 'CSV column: monthly_income — Application form field',
    transformation:
      'WOE-transformed — รายได้รวมต่อเดือนของผู้สมัคร (เงินเดือน/ค่าจ้าง) แบ่ง 5 bins ด้วยวิธี manual binning ตาม Bad Rate pattern',
    description: 'รายได้รวมต่อเดือน (บาท) — Primary affordability signal',
    dataType: 'Numeric',
    required: true,
    monitoringEnabled: true,
    csiThreshold: 0.1,
    displayOrder: 1,
    editable: true,
    iv: 0.281,
    bins: [
      {
        binLabel: '≤17,800',
        lowerBound: null,
        upperBound: 17800,
        woe: -0.4885,
        points: -18.2,
        badRate: 0.145,
        count: 78,
        pct: 0.1304,
      },
      {
        binLabel: '17,801–22,300',
        lowerBound: 17800,
        upperBound: 22300,
        woe: -0.8979,
        points: -2.1,
        badRate: 0.103,
        count: 97,
        pct: 0.1622,
      },
      {
        binLabel: '22,301–27,520',
        lowerBound: 22300,
        upperBound: 27520,
        woe: -0.2555,
        points: -5.5,
        badRate: 0.119,
        count: 128,
        pct: 0.2141,
      },
      {
        binLabel: '27,521–36,360',
        lowerBound: 27520,
        upperBound: 36360,
        woe: 0.5292,
        points: 13.4,
        badRate: 0.059,
        count: 186,
        pct: 0.3111,
      },
      {
        binLabel: '>36,360',
        lowerBound: 36360,
        upperBound: null,
        woe: 0.8379,
        points: 13.6,
        badRate: 0.050,
        count: 109,
        pct: 0.1823,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // feat_002 — Loan Amount
  // ─────────────────────────────────────────────────────────────────────────
  {
    featureId: 'feat_002',
    displayName: 'Loan Amount',
    columnName: 'loan_amount',
    source: 'CSV column: loan_amount — Application form field',
    transformation:
      'WOE-transformed — วงเงินกู้ที่ผู้สมัครขอ แบ่ง 5 bins ด้วย manual binning สังเกต U-shape (กู้น้อยหรือกู้มากเกินไปมี Bad Rate สูงกว่า)',
    description: 'วงเงินกู้ที่ขอ (บาท)',
    dataType: 'Numeric',
    required: true,
    monitoringEnabled: true,
    csiThreshold: 0.1,
    displayOrder: 2,
    editable: true,
    iv: 0.163,
    bins: [
      {
        binLabel: '≤46,000',
        lowerBound: null,
        upperBound: 46000,
        woe: 0.6466,
        points: 13.3,
        badRate: 0.050,
        count: 92,
        pct: 0.1539,
      },
      {
        binLabel: '46,001–63,000',
        lowerBound: 46000,
        upperBound: 63000,
        woe: 0.3229,
        points: 4.6,
        badRate: 0.076,
        count: 148,
        pct: 0.2475,
      },
      {
        binLabel: '63,001–81,000',
        lowerBound: 63000,
        upperBound: 81000,
        woe: -0.2182,
        points: -4.5,
        badRate: 0.115,
        count: 130,
        pct: 0.2174,
      },
      {
        binLabel: '81,001–112,000',
        lowerBound: 81000,
        upperBound: 112000,
        woe: 0.4683,
        points: 9.6,
        badRate: 0.060,
        count: 119,
        pct: 0.1990,
      },
      {
        binLabel: '>112,000',
        lowerBound: 112000,
        upperBound: null,
        woe: -0.6612,
        points: -13.6,
        badRate: 0.178,
        count: 109,
        pct: 0.1823,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // feat_003 — DTI Ratio (Derived)
  // ─────────────────────────────────────────────────────────────────────────
  {
    featureId: 'feat_003',
    displayName: 'DTI Ratio',
    columnName: 'dti_ratio',
    source:
      'CSV column: dti_ratio — Derived field: existing_monthly_debt / monthly_income',
    transformation:
      'WOE-transformed — อัตราส่วนหนี้สินต่อรายได้ แบ่ง 5 bins; ค่า DTI สูง (>0.47) แสดง Bad Rate สูงชัดเจน',
    description:
      'อัตราส่วนภาระหนี้ต่อรายได้ (existing_monthly_debt ÷ monthly_income)',
    dataType: 'Numeric',
    required: true,
    monitoringEnabled: true,
    csiThreshold: 0.1,
    displayOrder: 3,
    editable: true,
    iv: 0.324,
    bins: [
      {
        binLabel: '≤0.264',
        lowerBound: null,
        upperBound: 0.264,
        woe: 0.8137,
        points: 22.4,
        badRate: 0.042,
        count: 118,
        pct: 0.1973,
      },
      {
        binLabel: '0.265–0.360',
        lowerBound: 0.264,
        upperBound: 0.360,
        woe: 0.6552,
        points: 18.0,
        badRate: 0.049,
        count: 143,
        pct: 0.2392,
      },
      {
        binLabel: '0.361–0.470',
        lowerBound: 0.360,
        upperBound: 0.470,
        woe: 0.6466,
        points: 17.8,
        badRate: 0.059,
        count: 152,
        pct: 0.2542,
      },
      {
        binLabel: '0.471–0.606',
        lowerBound: 0.470,
        upperBound: 0.606,
        woe: -0.5838,
        points: -13.8,
        badRate: 0.143,
        count: 127,
        pct: 0.2124,
      },
      {
        binLabel: '>0.606',
        lowerBound: 0.606,
        upperBound: null,
        woe: -0.7543,
        points: -28.7,
        badRate: 0.183,
        count: 58,
        pct: 0.0970,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Look up a feature by its CSV column name. */
export function getFeatureByColumn(
  columnName: string
): FeatureConfig | undefined {
  return features.find((f) => f.columnName === columnName);
}

/** Return all features with monitoring enabled, sorted by displayOrder. */
export function getMonitoredFeatures(): FeatureConfig[] {
  return features
    .filter((f) => f.monitoringEnabled)
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * Find the WOE scorecard bin for a given numeric value.
 * Boundary convention: lowerBound exclusive, upperBound inclusive.
 * Falls back to the last bin if no match is found.
 */
export function findBin(
  feature: FeatureConfig,
  value: number
): FeatureConfig['bins'][number] {
  for (const bin of feature.bins) {
    const passesLower =
      bin.lowerBound === null || value > bin.lowerBound;
    const passesUpper =
      bin.upperBound === null || value <= bin.upperBound;
    if (passesLower && passesUpper) return bin;
  }
  return feature.bins[feature.bins.length - 1];
}
