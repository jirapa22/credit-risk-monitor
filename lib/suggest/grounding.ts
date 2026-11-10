/**
 * Number Grounding Verification for AI Explanations (Step 10d.C.4).
 *
 * Verifies that EVERY numeric claim made in an AI-generated explanation
 * actually originates from the BaselineValidationReport.
 * If any hallucinated or ungrounded number is found, the explanation is discarded.
 */
import type { BaselineValidationReport } from '../types';

export interface GroundingCheckResult {
  grounded: boolean;
  explanation: string;
  numbersInText: number[];
  reportNumbers: number[];
  ungroundedNumbers: number[];
}

function extractAllReportNumbers(report: BaselineValidationReport): Set<number> {
  const nums = new Set<number>();

  const addNum = (val: unknown) => {
    if (typeof val === 'number' && Number.isFinite(val)) {
      nums.add(val);
      // Also add percentage representation (e.g. 0.0936 -> 9.36)
      if (val >= 0 && val <= 1) {
        nums.add(+(val * 100).toFixed(2));
        nums.add(+(val * 100).toFixed(1));
        nums.add(Math.round(val * 100));
      }
      // Add rounded forms
      nums.add(+val.toFixed(4));
      nums.add(+val.toFixed(2));
      nums.add(+val.toFixed(1));
      nums.add(Math.round(val));
    }
  };

  if (report.computed) {
    const c = report.computed;
    addNum(c.rowCount);
    addNum(c.labeledRowCount);
    addNum(c.badCount);
    addNum(c.badRate);
    addNum(c.referenceFlaggedCount);
    addNum(c.referenceFlaggedPct);
    addNum(c.multivariateFitMs);

    if (c.performance) {
      addNum(c.performance.auc);
      addNum(c.performance.gini);
      addNum(c.performance.ks);
    }

    if (c.featureSkewness) {
      for (const item of Object.values(c.featureSkewness)) {
        if (item && typeof item === 'object') {
          addNum(item.skewness);
        }
      }
    }
  }

  // Also collect any numbers explicitly mentioned in warnings/errors
  const textBlob = [...(report.errors || []), ...(report.warnings || [])].join(' ');
  const textMatches = textBlob.match(/\b\d+(?:\.\d+)?\b/g) || [];
  for (const tm of textMatches) {
    const n = parseFloat(tm);
    if (Number.isFinite(n)) addNum(n);
  }

  // Extract years from validatedAt (e.g. 2026)
  if (report.validatedAt) {
    const y = new Date(report.validatedAt).getFullYear();
    if (Number.isFinite(y)) addNum(y);
  }

  return nums;
}

/**
 * Checks whether all numbers in `text` are grounded in `report`.
 * Discards the explanation and returns fallback if any number is fabricated.
 */
export function verifyNumberGrounding(
  text: string,
  report: BaselineValidationReport,
): GroundingCheckResult {
  if (!text || text.trim() === '') {
    return {
      grounded: false,
      explanation: 'AI อธิบายไม่ผ่านการตรวจ',
      numbersInText: [],
      reportNumbers: [],
      ungroundedNumbers: [],
    };
  }

  const reportNumberSet = extractAllReportNumbers(report);
  const reportNumberList = [...reportNumberSet].sort((a, b) => a - b);

  // Extract numbers from text (e.g. "0.71", "71.07%", "855", "35")
  const rawMatches = text.match(/\b\d+(?:,\d{3})*(?:\.\d+)?%?\b/g) || [];
  const numbersInText: number[] = [];

  for (const m of rawMatches) {
    const cleanStr = m.replace(/,/g, '').replace(/%$/, '');
    const num = parseFloat(cleanStr);
    if (Number.isFinite(num)) {
      numbersInText.push(num);
    }
  }

  const ungroundedNumbers: number[] = [];

  for (const num of numbersInText) {
    // Check if `num` is grounded in any report number
    // Allows small rounding tolerance (+/- 0.015 or relative diff <= 1%)
    const isGrounded = reportNumberList.some(rn => {
      if (Math.abs(rn - num) < 0.015) return true;
      if (rn !== 0 && Math.abs((rn - num) / rn) < 0.01) return true;
      return false;
    });

    if (!isGrounded) {
      ungroundedNumbers.push(num);
    }
  }

  if (ungroundedNumbers.length > 0) {
    return {
      grounded: false,
      explanation: 'AI อธิบายไม่ผ่านการตรวจ',
      numbersInText,
      reportNumbers: reportNumberList,
      ungroundedNumbers,
    };
  }

  return {
    grounded: true,
    explanation: text.trim(),
    numbersInText,
    reportNumbers: reportNumberList,
    ungroundedNumbers: [],
  };
}

