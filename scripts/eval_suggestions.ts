/**
 * Evaluation Dataset Generator & Runner for Baseline Suggestions (Step 10d.E).
 *
 * Runs evaluation across multiple test suites including standard models and
 * tricky naming variants (acronyms, trap words, blind column names).
 * Measures role accuracy, user corrections needed, latency, and tokens.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../lib/csv';
import { toCsv } from '../lib/injection';
import { buildDatasetProfile, heuristicProvider } from '../lib/suggest/heuristic';
import { AiSuggestionProvider } from '../lib/suggest/ai';
import { CombinedSuggestionProvider } from '../lib/suggest/combined';
import { mulberry32 } from '../lib/random';
import { loadReferenceDatasetBlob } from '../lib/storage/blob';
import type { ColumnRole, SuggestionProvider } from '../lib/suggest/types';

export interface EvalSuiteMeta {
  id: string;
  name: string;
  description: string;
  csvFileName: string;
  groundTruth: Record<string, ColumnRole>;
}

const ROOT = join(__dirname, '..');
const EVAL_DIR = join(ROOT, 'samples', 'eval');
const RESULTS_DIR = join(ROOT, 'results');

export async function ensureEvalDatasets(): Promise<EvalSuiteMeta[]> {
  mkdirSync(EVAL_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const suites: EvalSuiteMeta[] = [];

  // 1. ascore_v1 (approved reference 855 obs)
  const ascoreCsvPath = join(EVAL_DIR, 'ascore_v1.csv');
  if (!existsSync(ascoreCsvPath)) {
    const blob = await loadReferenceDatasetBlob('ascore_v1_dev855');
    if (blob) {
      writeFileSync(ascoreCsvPath, toCsv(blob.rows, blob.meta.columns), 'utf8');
    }
  }
  suites.push({
    id: 'ascore_v1',
    name: 'A-Score v1 Reference',
    description: 'ชุดข้อมูลโมเดลพัฒนา A-Score (855 obs)',
    csvFileName: 'ascore_v1.csv',
    groundTruth: {
      customer_id: 'id',
      application_date: 'date',
      monthly_income: 'feature',
      loan_amount: 'feature',
      dti_ratio: 'feature',
      default_flag: 'label',
    },
  });

  // 2. baseline_ext_model.csv (300 obs)
  const extModelSrc = join(ROOT, 'samples', 'baseline_ext_model.csv');
  const extModelDst = join(EVAL_DIR, 'baseline_ext_model.csv');
  if (existsSync(extModelSrc) && !existsSync(extModelDst)) {
    writeFileSync(extModelDst, readFileSync(extModelSrc, 'utf8'), 'utf8');
  }
  suites.push({
    id: 'ext_model',
    name: 'External PD Model',
    description: 'ชุดข้อมูลโมเดลภายนอก (300 obs)',
    csvFileName: 'baseline_ext_model.csv',
    groundTruth: {
      cust_no: 'id',
      app_date: 'date',
      รายได้ต่อเดือน: 'feature',
      วงเงินสินเชื่อ: 'feature',
      สัดส่วนภาระหนี้: 'feature',
      กลุ่มอาชีพ: 'feature',
      pd_score: 'score',
      flag_npl_90: 'label',
    },
  });

  // 3. Fake Model #1 (Scorecard mode)
  const fake1Path = join(EVAL_DIR, 'fake_model_1.csv');
  if (!existsSync(fake1Path)) {
    const rnd = mulberry32(111);
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `ID_${String(i + 1).padStart(4, '0')}`,
      apply_dt: `2025-03-${String((i % 28) + 1).padStart(2, '0')}`,
      income: Math.round(15000 + rnd() * 60000),
      debt: Math.round(3000 + rnd() * 25000),
      bad_flag: rnd() < 0.1 ? 1 : 0,
    }));
    writeFileSync(fake1Path, toCsv(rows, ['id', 'apply_dt', 'income', 'debt', 'bad_flag']), 'utf8');
  }
  suites.push({
    id: 'fake_model_1',
    name: 'Fake Model #1 (Standard Scorecard)',
    description: 'โมเดลจำลองตัวแปรมาตรฐานภาษาอังกฤษ',
    csvFileName: 'fake_model_1.csv',
    groundTruth: {
      id: 'id',
      apply_dt: 'date',
      income: 'feature',
      debt: 'feature',
      bad_flag: 'label',
    },
  });

  // 4. Fake Model #2 (With Categorical)
  const fake2Path = join(EVAL_DIR, 'fake_model_2.csv');
  if (!existsSync(fake2Path)) {
    const rnd = mulberry32(222);
    const cities = ['Bangkok', 'Chiang Mai', 'Phuket', 'Khon Kaen'];
    const rows = Array.from({ length: 200 }, (_, i) => ({
      cust_id: `CUST_${String(i + 1).padStart(4, '0')}`,
      txn_date: `2025-04-${String((i % 28) + 1).padStart(2, '0')}`,
      age: Math.round(22 + rnd() * 40),
      city: cities[Math.floor(rnd() * cities.length)],
      target: rnd() < 0.08 ? 1 : 0,
    }));
    writeFileSync(fake2Path, toCsv(rows, ['cust_id', 'txn_date', 'age', 'city', 'target']), 'utf8');
  }
  suites.push({
    id: 'fake_model_2',
    name: 'Fake Model #2 (With Categorical City)',
    description: 'โมเดลจำลองที่มีตัวแปรกลุ่ม',
    csvFileName: 'fake_model_2.csv',
    groundTruth: {
      cust_id: 'id',
      txn_date: 'date',
      age: 'feature',
      city: 'feature',
      target: 'label',
    },
  });

  // 5. Fake Model #3 (Score Column Mode)
  const fake3Path = join(EVAL_DIR, 'fake_model_3.csv');
  if (!existsSync(fake3Path)) {
    const rnd = mulberry32(333);
    const rows = Array.from({ length: 200 }, (_, i) => ({
      app_id: `APP_${String(i + 1).padStart(4, '0')}`,
      snapshot_dt: `2025-05-${String((i % 28) + 1).padStart(2, '0')}`,
      x1: +(10 + rnd() * 90).toFixed(2),
      x2: +(20 + rnd() * 80).toFixed(2),
      x3: +(5 + rnd() * 50).toFixed(2),
      ext_score: +(rnd()).toFixed(4),
      target: rnd() < 0.12 ? 1 : 0,
    }));
    writeFileSync(fake3Path, toCsv(rows, ['app_id', 'snapshot_dt', 'x1', 'x2', 'x3', 'ext_score', 'target']), 'utf8');
  }
  suites.push({
    id: 'fake_model_3',
    name: 'Fake Model #3 (External Score)',
    description: 'โมเดลจำลองตัวแปร x1..x3 พร้อม ext_score',
    csvFileName: 'fake_model_3.csv',
    groundTruth: {
      app_id: 'id',
      snapshot_dt: 'date',
      x1: 'feature',
      x2: 'feature',
      x3: 'feature',
      ext_score: 'score',
      target: 'label',
    },
  });

  // 6. Tricky Suite A (Bank Acronyms)
  const trickyAPath = join(EVAL_DIR, 'tricky_a_acronyms.csv');
  if (!existsSync(trickyAPath)) {
    const rnd = mulberry32(444);
    const rows = Array.from({ length: 200 }, (_, i) => ({
      c_id: `BNK${String(i + 1).padStart(5, '0')}`,
      app_dt: `2025-06-${String((i % 28) + 1).padStart(2, '0')}`,
      inc_m: Math.round(20000 + rnd() * 80000),
      ln_amt: Math.round(50000 + rnd() * 300000),
      dsr: +(0.15 + rnd() * 0.6).toFixed(4),
      scr: Math.round(500 + rnd() * 300),
      npl90_f: rnd() < 0.07 ? 1 : 0,
    }));
    writeFileSync(trickyAPath, toCsv(rows, ['c_id', 'app_dt', 'inc_m', 'ln_amt', 'dsr', 'scr', 'npl90_f']), 'utf8');
  }
  suites.push({
    id: 'tricky_a',
    name: 'Tricky Suite A (Bank Acronyms)',
    description: 'ชื่อย่อระบบธนาคาร เช่น inc_m, ln_amt, dsr, scr, npl90_f',
    csvFileName: 'tricky_a_acronyms.csv',
    groundTruth: {
      c_id: 'id',
      app_dt: 'date',
      inc_m: 'feature',
      ln_amt: 'feature',
      dsr: 'feature',
      scr: 'score',
      npl90_f: 'label',
    },
  });

  // 7. Tricky Suite B (Trap Thai Words)
  const trickyBPath = join(EVAL_DIR, 'tricky_b_trap_thai.csv');
  if (!existsSync(trickyBPath)) {
    const rnd = mulberry32(555);
    const rows = Array.from({ length: 200 }, (_, i) => ({
      รหัสลูกค้า: `CUST${String(i + 1).padStart(5, '0')}`,
      เดือนที่สมัคร: `2025-07-${String((i % 28) + 1).padStart(2, '0')}`,
      รายได้ต่อเดือน: Math.round(22000 + rnd() * 75000),
      จำนวนเดือนที่ทำงาน: Math.round(6 + rnd() * 120),
      ยอดผ่อนต่อเดือน: Math.round(2000 + rnd() * 18000),
      คะแนนเครดิต: Math.round(550 + rnd() * 250),
      สถานะหนี้เสีย: rnd() < 0.09 ? 1 : 0,
    }));
    writeFileSync(
      trickyBPath,
      toCsv(rows, [
        'รหัสลูกค้า',
        'เดือนที่สมัคร',
        'รายได้ต่อเดือน',
        'จำนวนเดือนที่ทำงาน',
        'ยอดผ่อนต่อเดือน',
        'คะแนนเครดิต',
        'สถานะหนี้เสีย',
      ]),
      'utf8',
    );
  }
  suites.push({
    id: 'tricky_b',
    name: 'Tricky Suite B (Trap Thai Words)',
    description: 'คำภาษาไทยที่มีคำว่าเดือนปน (รายได้ต่อเดือน, จำนวนเดือนที่ทำงาน, เดือนที่สมัคร)',
    csvFileName: 'tricky_b_trap_thai.csv',
    groundTruth: {
      รหัสลูกค้า: 'id',
      เดือนที่สมัคร: 'date',
      รายได้ต่อเดือน: 'feature',
      จำนวนเดือนที่ทำงาน: 'feature',
      ยอดผ่อนต่อเดือน: 'feature',
      คะแนนเครดิต: 'score',
      สถานะหนี้เสีย: 'label',
    },
  });

  // 8. Tricky Suite C (Blind Names: col_1..col_7)
  const trickyCPath = join(EVAL_DIR, 'tricky_c_blind_names.csv');
  if (!existsSync(trickyCPath)) {
    const rnd = mulberry32(666);
    const occupations = ['Salaried', 'Civil_Servant', 'Self_Employed', 'Business_Owner'];
    const rows = Array.from({ length: 200 }, (_, i) => ({
      col_1: `UID_${String(i + 1).padStart(5, '0')}`,
      col_2: `2025-08-${String((i % 28) + 1).padStart(2, '0')}`,
      col_3: Math.round(18000 + rnd() * 70000),
      col_4: Math.round(50000 + rnd() * 200000),
      col_5: occupations[Math.floor(rnd() * occupations.length)],
      col_6: +(0.01 + rnd() * 0.4).toFixed(4),
      col_7: rnd() < 0.1 ? 1 : 0,
    }));
    writeFileSync(trickyCPath, toCsv(rows, ['col_1', 'col_2', 'col_3', 'col_4', 'col_5', 'col_6', 'col_7']), 'utf8');
  }
  suites.push({
    id: 'tricky_c',
    name: 'Tricky Suite C (Blind Names)',
    description: 'ชื่อคอลัมน์ col_1..col_7 ไม่มีความหมาย ต้องเดาจากค่าและสถิติเท่านั้น',
    csvFileName: 'tricky_c_blind_names.csv',
    groundTruth: {
      col_1: 'id',
      col_2: 'date',
      col_3: 'feature',
      col_4: 'feature',
      col_5: 'feature',
      col_6: 'score',
      col_7: 'label',
    },
  });

  return suites;
}

export interface SuiteEvalResult {
  suiteId: string;
  suiteName: string;
  totalColumns: number;
  correctColumns: number;
  accuracyPct: number;
  correctionsNeeded: number;
  durationMs: number;
  tokensUsed: number;
  perRoleAccuracy: Record<string, { total: number; correct: number; pct: number }>;
}

export async function runEvaluation(providerName: 'heuristic' | 'ai' | 'combined'): Promise<{
  provider: string;
  suites: SuiteEvalResult[];
  overallAccuracyPct: number;
  totalCorrectionsNeeded: number;
  totalDurationMs: number;
  totalTokensUsed: number;
}> {
  const suitesMeta = await ensureEvalDatasets();

  let provider: SuggestionProvider;
  if (providerName === 'ai') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('⚠️ ไม่พบ ANTHROPIC_API_KEY ในสภาพแวดล้อม — สลับเป็น heuristic อัตโนมัติ');
      provider = heuristicProvider;
    } else {
      provider = new AiSuggestionProvider();
    }
  } else if (providerName === 'combined') {
    provider = new CombinedSuggestionProvider();
  } else {
    provider = heuristicProvider;
  }

  const results: SuiteEvalResult[] = [];
  let totalColsAll = 0;
  let correctColsAll = 0;
  let totalDurationAll = 0;
  let totalTokensAll = 0;

  for (const s of suitesMeta) {
    const filePath = join(EVAL_DIR, s.csvFileName);
    const csvContent = readFileSync(filePath, 'utf8');
    const parsed = parseCsv(csvContent);
    const profile = buildDatasetProfile(s.id, parsed.rows, parsed.headers);

    const startTime = Date.now();
    const suggestions = await provider.suggestColumns(profile);
    const durationMs = Date.now() - startTime;
    totalDurationAll += durationMs;

    const usage = provider.getLastUsage ? provider.getLastUsage() : null;
    const tokens = usage?.totalTokens ?? 0;
    totalTokensAll += tokens;

    let correctCount = 0;
    const perRole: Record<string, { total: number; correct: number; pct: number }> = {};

    for (const [colName, expectedRole] of Object.entries(s.groundTruth)) {
      if (!perRole[expectedRole]) {
        perRole[expectedRole] = { total: 0, correct: 0, pct: 0 };
      }
      perRole[expectedRole].total++;

      const sug = suggestions.find(x => x.column === colName);
      if (sug && sug.role === expectedRole) {
        correctCount++;
        perRole[expectedRole].correct++;
      }
    }

    for (const r of Object.keys(perRole)) {
      perRole[r].pct = +(perRole[r].total > 0 ? (perRole[r].correct / perRole[r].total) * 100 : 0).toFixed(1);
    }

    const totalCols = Object.keys(s.groundTruth).length;
    totalColsAll += totalCols;
    correctColsAll += correctCount;

    results.push({
      suiteId: s.id,
      suiteName: s.name,
      totalColumns: totalCols,
      correctColumns: correctCount,
      accuracyPct: +((correctCount / totalCols) * 100).toFixed(1),
      correctionsNeeded: totalCols - correctCount,
      durationMs,
      tokensUsed: tokens,
      perRoleAccuracy: perRole,
    });
  }

  const overallAccuracyPct = +((correctColsAll / totalColsAll) * 100).toFixed(2);
  const totalCorrectionsNeeded = totalColsAll - correctColsAll;

  // Write CSV result
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvOutPath = join(RESULTS_DIR, `eval_suggestions_${providerName}_${timestamp}.csv`);
  const csvRows = results.map(r => ({
    provider: providerName,
    suite_id: r.suiteId,
    suite_name: r.suiteName,
    total_columns: r.totalColumns,
    correct_columns: r.correctColumns,
    accuracy_pct: r.accuracyPct,
    corrections_needed: r.correctionsNeeded,
    duration_ms: r.durationMs,
    tokens_used: r.tokensUsed,
  }));
  writeFileSync(
    csvOutPath,
    toCsv(csvRows, [
      'provider',
      'suite_id',
      'suite_name',
      'total_columns',
      'correct_columns',
      'accuracy_pct',
      'corrections_needed',
      'duration_ms',
      'tokens_used',
    ]),
    'utf8',
  );

  return {
    provider: providerName,
    suites: results,
    overallAccuracyPct,
    totalCorrectionsNeeded,
    totalDurationMs: totalDurationAll,
    totalTokensUsed: totalTokensAll,
  };
}

// CLI Execution entrypoint
async function main() {
  const args = process.argv.slice(2);
  let providerArg: 'heuristic' | 'ai' | 'combined' = 'heuristic';
  const pIdx = args.indexOf('--provider');
  if (pIdx !== -1 && args[pIdx + 1]) {
    const val = args[pIdx + 1].toLowerCase();
    if (val === 'ai' || val === 'combined' || val === 'heuristic') {
      providerArg = val;
    }
  }

  console.log(`\n======================================================`);
  console.log(`  Evaluating Suggestions (Provider: ${providerArg})`);
  console.log(`======================================================\n`);

  const summary = await runEvaluation(providerArg);

  console.table(
    summary.suites.map(s => ({
      'Suite Name': s.suiteName,
      'Columns': s.totalColumns,
      'Correct': s.correctColumns,
      'Accuracy (%)': `${s.accuracyPct}%`,
      'Corrections': s.correctionsNeeded,
      'Latency (ms)': `${s.durationMs}ms`,
    })),
  );

  // Role-level breakdown across all evaluated suites
  const roleAgg: Record<string, { total: number; correct: number }> = {
    id: { total: 0, correct: 0 },
    date: { total: 0, correct: 0 },
    label: { total: 0, correct: 0 },
    score: { total: 0, correct: 0 },
    feature: { total: 0, correct: 0 },
  };
  for (const s of summary.suites) {
    if (s.perRoleAccuracy) {
      for (const [role, data] of Object.entries(s.perRoleAccuracy)) {
        if (!roleAgg[role]) roleAgg[role] = { total: 0, correct: 0 };
        roleAgg[role].total += data.total;
        roleAgg[role].correct += data.correct;
      }
    }
  }

  console.log(`\n--- Accuracy by Column Role (id / date / label / score / feature) ---`);
  console.table(
    Object.entries(roleAgg).map(([role, st]) => ({
      'Role': role,
      'Total Columns': st.total,
      'Correct': st.correct,
      'Accuracy (%)': `${st.total > 0 ? ((st.correct / st.total) * 100).toFixed(1) : '0'}%`,
      'Corrections Needed': st.total - st.correct,
    })),
  );

  console.log(`\n------------------------------------------------------`);
  console.log(`Overall Accuracy: ${summary.overallAccuracyPct}% (${summary.totalCorrectionsNeeded} corrections needed across ${summary.suites.length} suites)`);
  console.log(`Total Latency: ${summary.totalDurationMs}ms | Total Tokens: ${summary.totalTokensUsed}`);
  console.log(`Result written to: results/eval_suggestions_${providerArg}_*.csv\n`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Evaluation failed:', err);
    process.exit(1);
  });
}
