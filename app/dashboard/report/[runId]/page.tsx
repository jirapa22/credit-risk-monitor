import React from 'react';
import Link from 'next/link';
import {
  getActiveModelId,
  getMonitoringRunDetail,
  listRegistryModels,
  getActiveBaseline,
} from '@/lib/storage/repositories';
import { buildRunReport } from '@/lib/report/buildRunReport';
import ReportActions from './ReportActions';

export const dynamic = 'force-dynamic';

interface ReportPageProps {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ modelId?: string }>;
}

export default async function ReportPage(props: ReportPageProps) {
  const { runId } = await props.params;
  const { modelId: queryModelId } = await props.searchParams;

  let activeId = queryModelId || getActiveModelId();
  let result = await getMonitoringRunDetail(activeId, runId);

  // If not found in active model, search other models
  if (!result.run) {
    try {
      const reg = await listRegistryModels();
      for (const m of reg.models) {
        if (m.modelId !== activeId) {
          const alt = await getMonitoringRunDetail(m.modelId, runId);
          if (alt.run) {
            result = alt;
            activeId = m.modelId;
            break;
          }
        }
      }
    } catch {
      // ignore lookup error
    }
  }

  // If still not found, render Thai 404 page
  if (!result.run) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-xl">
          <div className="text-4xl mb-3">🔍</div>
          <h1 className="text-xl font-bold text-slate-100 mb-2">ไม่พบรายงานการตรวจสอบ</h1>
          <p className="text-sm text-slate-400 mb-4">
            ไม่พบข้อมูลสำหรับรอบการตรวจสอบรหัส:
          </p>
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 font-mono text-xs text-rose-400 break-all mb-6">
            {runId}
          </div>
          <p className="text-xs text-slate-500 mb-6">
            รายการนี้อาจถูกลบไปแล้ว หรือรหัสรอบการตรวจสอบไม่ถูกต้อง
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors text-xs font-semibold"
          >
            ← กลับสู่หน้าแดชบอร์ด
          </Link>
        </div>
      </div>
    );
  }

  // Load baseline if available for configHash
  let baseline = null;
  try {
    baseline = await getActiveBaseline(activeId);
  } catch {
    // optional
  }

  const report = buildRunReport(result.run, result.detail, baseline);
  const {
    header,
    summary,
    dataQuality,
    overallDrift,
    featuresCsi,
    performance,
    recommendation,
    footerNotes,
  } = report;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans print:bg-white print:text-black">
      {/* Print Stylesheet */}
      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 12mm 12mm 12mm 12mm;
          }
          body {
            background: white !important;
            color: black !important;
            font-size: 11pt;
            line-height: 1.4;
          }
          .no-print {
            display: none !important;
          }
          .print-card {
            background: white !important;
            border: 1px solid #cbd5e1 !important;
            box-shadow: none !important;
            color: black !important;
            break-inside: avoid;
            margin-bottom: 12px !important;
          }
          .print-table {
            border-collapse: collapse !important;
            width: 100% !important;
          }
          .print-table th, .print-table td {
            border: 1px solid #cbd5e1 !important;
            color: black !important;
            padding: 6px 8px !important;
          }
          .print-table th {
            background-color: #f1f5f9 !important;
            font-weight: bold !important;
          }
          .print-text-dark {
            color: black !important;
          }
          .print-text-muted {
            color: #475569 !important;
          }
          .print-badge {
            border: 1px solid #94a3b8 !important;
            background: #f8fafc !important;
            color: black !important;
          }
        }
      `}</style>

      {/* Top Navbar (Hidden when printing) */}
      <ReportActions modelId={activeId} />

      {/* Main Document Container (A4 Printable Layout) */}
      <main className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 print:p-0 print:max-w-none">
        {/* ── 1. หัวรายงาน (Header) ── */}
        <header className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 shadow-sm print-card print:p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-4 print:border-slate-300">
            <div>
              <div className="text-[11px] font-semibold tracking-wider text-indigo-400 uppercase print-text-muted">
                รายงานการติดตามผลแบบจำลองประจำรอบ (Per-run Drift Report)
              </div>
              <h1 className="text-xl sm:text-2xl font-bold text-white print-text-dark mt-0.5">
                {header.modelName}
              </h1>
            </div>
            <div className="sm:text-right">
              <span className="inline-block px-2.5 py-1 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs font-mono font-medium print-badge">
                เวอร์ชัน {header.version}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div>
              <div className="text-slate-400 print-text-muted text-[11px]">ชื่อไฟล์ข้อมูล</div>
              <div className="font-semibold text-slate-200 print-text-dark break-all whitespace-normal mt-0.5" title={header.fileName}>
                {header.fileName}
              </div>
            </div>
            <div>
              <div className="text-slate-400 print-text-muted text-[11px]">งวดข้อมูล (Period)</div>
              <div className="font-semibold text-slate-200 print-text-dark mt-0.5">
                {header.dataPeriod}
                {header.isPeriodFallback && (
                  <span className="text-[10px] text-slate-500 ml-1">(คาดจากชื่อไฟล์)</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-slate-400 print-text-muted text-[11px]">วันเวลาประมวลผล</div>
              <div className="font-semibold text-slate-200 print-text-dark mt-0.5">
                {header.runDateTime}
              </div>
            </div>
            <div>
              <div className="text-slate-400 print-text-muted text-[11px]">จำนวนแถวข้อมูล</div>
              <div className="font-semibold text-slate-200 print-text-dark mt-0.5">
                {header.rowCount.toLocaleString()} แถว
                {header.rejectedRowCount > 0 && (
                  <span className="text-[10px] text-amber-400 ml-1 print-text-muted">
                    (ตัด {header.rejectedRowCount.toLocaleString()})
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-800/60 print:border-slate-200 flex flex-wrap items-center justify-between text-[11px] text-slate-500 font-mono gap-2">
            <div>
              <span className="text-slate-400 print-text-muted">Run ID: </span>
              <span className="text-slate-300 print-text-dark">{header.runId}</span>
            </div>
            <div>
              <span className="text-slate-400 print-text-muted">ชุดกฎที่ใช้: </span>
              <span className="text-slate-300 print-text-dark font-sans">{header.ruleSetInfo}</span>
            </div>
            <div>
              <span className="text-slate-400 print-text-muted">Config Hash: </span>
              <span className="text-slate-300 print-text-dark">{header.configHash}</span>
            </div>
          </div>
        </header>

        {/* ── 2. สรุปผล (กล่องบนสุด: Verdict & Trigger) ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 shadow-sm print-card print:p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300 print-text-dark flex items-center gap-2">
              <span>🎯</span>
              <span>บทสรุปผลการตรวจสอบ (Executive Summary)</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {/* Verdict Box */}
            <div className={`p-4 rounded-xl border ${
              summary.verdictColor === 'emerald'
                ? 'bg-emerald-950/20 border-emerald-500/30'
                : summary.verdictColor === 'amber'
                ? 'bg-amber-950/20 border-amber-500/30'
                : 'bg-rose-950/20 border-rose-500/30'
            } print-card print:p-3`}>
              <div className="text-[11px] font-semibold text-slate-400 print-text-muted mb-1">
                สถานะผลการตรวจข้อมูล / ความเสถียร (Verdict)
              </div>
              <div className={`text-base font-bold ${
                summary.verdictColor === 'emerald'
                  ? 'text-emerald-400'
                  : summary.verdictColor === 'amber'
                  ? 'text-amber-400'
                  : 'text-rose-400'
              } print-text-dark`}>
                {summary.verdictLabel}
              </div>
              {summary.verdictReasonLine && (
                <div className="text-xs text-slate-300 mt-1 font-medium print-text-dark">
                  {summary.verdictReasonLine}
                </div>
              )}
            </div>

            {/* Trigger Box */}
            <div className={`p-4 rounded-xl border ${
              summary.severity === 'critical'
                ? 'bg-rose-950/20 border-rose-500/30'
                : summary.severity === 'warning'
                ? 'bg-amber-950/20 border-amber-500/30'
                : 'bg-indigo-950/20 border-indigo-500/30'
            } print-card print:p-3`}>
              <div className="text-[11px] font-semibold text-slate-400 print-text-muted mb-1 flex items-center justify-between">
                <span>การตัดสินใจทาง MLOps (Trigger Action)</span>
                {summary.matchedRuleId && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-indigo-300 print-badge">
                    กฎ {summary.matchedRuleId}
                  </span>
                )}
              </div>
              <div className="text-base font-bold text-indigo-300 print-text-dark">
                {summary.triggerActionLabel}
              </div>
            </div>
          </div>

          {/* Rationale (1-3 lines) */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 print-card print:p-2.5">
            <div className="text-[11px] font-semibold text-slate-400 print-text-muted mb-1.5">
              เหตุผลประกอบการตัดสินใจ (Evidence Rationale):
            </div>
            <ul className="space-y-1 text-xs text-slate-300 print-text-dark">
              {summary.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-indigo-400 print-text-dark">•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── 3. คุณภาพข้อมูล (Data Quality) ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 shadow-sm print-card print:p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300 print-text-dark mb-3 flex items-center gap-2">
            <span>🛡️</span>
            <span>คุณภาพข้อมูล (Data Quality & Validation)</span>
          </h2>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3 print-card print:p-2">
              <div className="text-[11px] text-slate-400 print-text-muted">แถวข้อมูลทั้งหมด</div>
              <div className="text-base font-bold font-mono text-slate-200 print-text-dark mt-0.5">
                {dataQuality.totalRows.toLocaleString()}
              </div>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3 print-card print:p-2">
              <div className="text-[11px] text-slate-400 print-text-muted">แถวที่ผ่านเกณฑ์ (Valid)</div>
              <div className="text-base font-bold font-mono text-emerald-400 print-text-dark mt-0.5">
                {dataQuality.validRows.toLocaleString()}
              </div>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3 print-card print:p-2">
              <div className="text-[11px] text-slate-400 print-text-muted">แถวที่ถูกตัดออก (Rejected)</div>
              <div className={`text-base font-bold font-mono ${dataQuality.rejectedRows > 0 ? 'text-rose-400' : 'text-slate-400'} print-text-dark mt-0.5`}>
                {dataQuality.rejectedRows.toLocaleString()}
              </div>
            </div>
            <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl p-3 print-card print:p-2">
              <div className="text-[11px] text-slate-400 print-text-muted">สัดส่วนแถวมีปัญหา</div>
              <div className={`text-base font-bold font-mono ${dataQuality.rejectedPct > 0 ? 'text-amber-400' : 'text-slate-400'} print-text-dark mt-0.5`}>
                {dataQuality.rejectedPct}%
              </div>
            </div>
          </div>

          {/* Issues by Type */}
          <div className="mb-4">
            <div className="text-xs font-semibold text-slate-300 print-text-dark mb-2">
              รายการปัญหาข้อมูลที่พบแยกตามชนิด:
            </div>
            {dataQuality.issuesSummary.length === 0 ? (
              <div className="text-xs text-emerald-400 print-text-muted bg-slate-950/40 p-2.5 rounded-lg border border-slate-800">
                ✓ ไม่พบปัญหาข้อมูลผิดรูปแบบหรือข้อมูลสูญหาย
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {dataQuality.issuesSummary.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2 rounded-lg bg-slate-950/40 border border-slate-800/80 print-card print:p-1.5"
                  >
                    <span className="text-slate-300 print-text-dark">
                      {item.label}
                    </span>
                    <span className={`font-mono font-semibold px-2 py-0.5 rounded text-[11px] ${
                      item.severity === 'error'
                        ? 'bg-rose-500/20 text-rose-300'
                        : 'bg-amber-500/20 text-amber-300'
                    } print-badge`}>
                      {item.count.toLocaleString()} ครั้ง
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Coverage note */}
          <div className="text-xs bg-slate-950/40 border border-slate-800 rounded-lg p-2.5 text-slate-400 print-card print:p-2">
            <span className="font-semibold text-slate-300 print-text-dark">ความครอบคลุมของตัวแปร: </span>
            <span>{dataQuality.coverageText}</span>
          </div>
        </section>

        {/* ── 4. Drift ระดับภาพรวม (Overall Drift: Score PSI & Bad Rate) ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 shadow-sm print-card print:p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300 print-text-dark mb-3 flex items-center gap-2">
            <span>📈</span>
            <span>การเคลื่อนตัวของประชากรระดับภาพรวม (Overall Drift)</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Score PSI Card */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 print-card print:p-3">
              <div className="text-xs font-semibold text-slate-400 print-text-muted mb-2">
                ความเสถียรของคะแนนแบบจำลอง (Score PSI)
              </div>
              <div className="flex items-baseline gap-3 mb-2">
                <span className={`text-2xl font-bold font-mono ${
                  overallDrift.scoreStatus === 'CRITICAL'
                    ? 'text-rose-400'
                    : overallDrift.scoreStatus === 'WARNING'
                    ? 'text-amber-400'
                    : overallDrift.scorePsi !== null
                    ? 'text-emerald-400'
                    : 'text-slate-500'
                } print-text-dark`}>
                  {overallDrift.scorePsi !== null ? overallDrift.scorePsi.toFixed(4) : 'ไม่ได้บันทึก'}
                </span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 print-badge">
                  {overallDrift.scoreStatusLabel}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 print-text-muted space-y-0.5 border-t border-slate-800/60 pt-2 print:border-slate-200">
                <div>เกณฑ์เฝ้าระวัง (Warn): {typeof overallDrift.scoreWarningThreshold === 'number' ? `≥ ${overallDrift.scoreWarningThreshold.toFixed(2)}` : overallDrift.scoreWarningThreshold}</div>
                <div>เกณฑ์วิกฤต (Critical): {typeof overallDrift.scoreCriticalThreshold === 'number' ? `≥ ${overallDrift.scoreCriticalThreshold.toFixed(2)}` : overallDrift.scoreCriticalThreshold}</div>
              </div>
            </div>

            {/* Label Drift / Bad Rate Card */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 print-card print:p-3">
              <div className="text-xs font-semibold text-slate-400 print-text-muted mb-2">
                การเปลี่ยนแปลงของอัตราหนี้เสีย (Label Drift / Bad Rate)
              </div>
              {overallDrift.hasLabelDrift ? (
                <>
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="text-xs text-slate-400 print-text-muted">Ref:</span>
                    <span className="text-sm font-mono font-bold text-slate-200 print-text-dark">
                      {overallDrift.labelRefBadRate}
                    </span>
                    <span className="text-xs text-slate-400 print-text-muted">→ ใหม่:</span>
                    <span className="text-sm font-mono font-bold text-cyan-400 print-text-dark">
                      {overallDrift.labelActBadRate}
                    </span>
                    <span className="text-xs font-mono font-bold text-amber-400 ml-1">
                      ({overallDrift.labelRelativeChange})
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 print-text-muted space-y-1 border-t border-slate-800/60 pt-2 print:border-slate-200">
                    <div>
                      ค่า p-value (Unadjusted): <span className="font-mono font-bold text-slate-300 print-text-dark">{overallDrift.labelPValue}</span>
                      {overallDrift.labelPThreshold !== 'ไม่ได้บันทึก' && (
                        <span> (เกณฑ์นัยสำคัญ &lt; {overallDrift.labelPThreshold})</span>
                      )}
                    </div>
                    {overallDrift.expectedBadRate && overallDrift.expectedBadRate !== 'N/A' && (
                      <div className="bg-slate-900/80 rounded px-2.5 py-1.5 mt-1 border border-slate-800">
                        <div className="flex items-center justify-between text-[11px] gap-2">
                          <span>Expected Bad Rate (ช่วงคะแนน): <strong className="font-mono text-cyan-400">{overallDrift.expectedBadRate}</strong></span>
                          <span>p-value (Adjusted): <strong className="font-mono text-slate-300">{overallDrift.labelPValueAdjusted}</strong></span>
                        </div>
                        <div className="text-[9px] text-slate-500 mt-0.5">
                          * {overallDrift.scoreAdjustedNote}
                        </div>
                      </div>
                    )}
                    {overallDrift.labelReason && (
                      <div className="truncate text-[10px]" title={overallDrift.labelReason}>
                        สัญญาณ: {overallDrift.labelReason}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="py-3 text-xs text-slate-500 print-text-muted">
                  รอบนี้ไม่มีข้อมูลเฉลยผลจริง (Label/Default Flag) จึงข้ามการคำนวณ Label Drift
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── 5. CSI รายตัวแปร (Feature CSI Table) ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 shadow-sm print-card print:p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300 print-text-dark flex items-center gap-2">
              <span>📋</span>
              <span>CSI รายตัวแปร (Characteristic Stability Index)</span>
            </h2>
            <span className="text-[11px] text-slate-500 print-text-muted">
              เรียงจากค่า CSI มากไปน้อย
            </span>
          </div>

          {featuresCsi.length === 0 ? (
            <div className="text-xs text-slate-500 print-text-muted bg-slate-950/40 p-4 rounded-xl border border-slate-800 text-center">
              ไม่มีข้อมูล CSI รายตัวแปรสำหรับรอบนี้ (ข้อมูลไม่ผ่านเกณฑ์หรือไม่ได้เปิดการติดตาม)
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800 print:border-slate-300">
              <table className="w-full text-xs text-left print-table">
                <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-3">ตัวแปร (Feature)</th>
                    <th className="py-2.5 px-3 text-right">ค่า CSI</th>
                    <th className="py-2.5 px-3 text-center">สถานะ</th>
                    <th className="py-2.5 px-3 text-right">เกณฑ์เตือน / วิกฤต</th>
                    <th className="py-2.5 px-3">หมายเหตุ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {featuresCsi.map(feat => {
                    const isCrit = feat.status === 'CRITICAL';
                    const isWarn = feat.status === 'WARNING';
                    return (
                      <tr
                        key={feat.key}
                        className={`${
                          isCrit
                            ? 'bg-rose-950/20 text-rose-300 font-semibold'
                            : isWarn
                            ? 'bg-amber-950/15 text-amber-300 font-semibold'
                            : 'text-slate-300 hover:bg-slate-800/30'
                        } transition-colors`}
                      >
                        <td className="py-2.5 px-3 font-sans">
                          <div className="font-semibold text-slate-200 print-text-dark">
                            {feat.displayName}
                          </div>
                          {feat.displayName !== feat.key && (
                            <div className="text-[10px] text-slate-500 font-mono">
                              {feat.key}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-bold">
                          {feat.csiValue !== null ? feat.csiValue.toFixed(4) : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-center font-sans">
                          <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                            isCrit
                              ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                              : isWarn
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                              : 'bg-emerald-500/20 text-emerald-400'
                          } print-badge`}>
                            {feat.statusLabel}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-slate-400 print-text-muted text-[11px]">
                          {typeof feat.warnThreshold === 'number' && typeof feat.critThreshold === 'number'
                            ? `${feat.warnThreshold.toFixed(2)} / ${feat.critThreshold.toFixed(2)}`
                            : feat.warnThreshold === feat.critThreshold
                            ? feat.warnThreshold
                            : `${feat.warnThreshold} / ${feat.critThreshold}`}
                        </td>
                        <td className="py-2.5 px-3 font-sans text-xs text-slate-400 print-text-muted">
                          {feat.unseenInfo ? (
                            <span className="text-amber-400 print-text-dark font-medium">
                              ⚠️ {feat.unseenInfo}
                            </span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── 6. ประสิทธิภาพโมเดล (Model Performance, ถ้ามี label) ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 shadow-sm print-card print:p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300 print-text-dark mb-3 flex items-center gap-2">
            <span>🏆</span>
            <span>ประสิทธิภาพแบบจำลอง (Model Performance)</span>
          </h2>

          {performance.hasLabels ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* AUC Card */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 print-card print:p-2.5">
                <div className="text-[11px] text-slate-400 print-text-muted mb-1">AUC (ROC)</div>
                <div className="flex items-baseline justify-between">
                  <span className={`text-xl font-bold font-mono ${performance.aucPass === true ? 'text-emerald-400' : performance.aucPass === false ? 'text-rose-400' : 'text-slate-200'} print-text-dark`}>
                    {performance.auc?.toFixed(4)}
                  </span>
                  <span className="text-[10px] text-slate-500 print-text-muted">
                    {typeof performance.aucThreshold === 'number' ? `เกณฑ์ ≥ ${performance.aucThreshold}` : `เกณฑ์: ${performance.aucThreshold}`}
                  </span>
                </div>
              </div>

              {/* Gini Card */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 print-card print:p-2.5">
                <div className="text-[11px] text-slate-400 print-text-muted mb-1">Gini Coefficient</div>
                <div className="flex items-baseline justify-between">
                  <span className={`text-xl font-bold font-mono ${performance.giniPass === true ? 'text-emerald-400' : performance.giniPass === false ? 'text-rose-400' : 'text-slate-200'} print-text-dark`}>
                    {performance.gini !== null ? performance.gini.toFixed(4) : '—'}
                  </span>
                  <span className="text-[10px] text-slate-500 print-text-muted">
                    {typeof performance.giniThreshold === 'number' ? `เกณฑ์ ≥ ${performance.giniThreshold}` : `เกณฑ์: ${performance.giniThreshold}`}
                  </span>
                </div>
              </div>

              {/* KS Card */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 print-card print:p-2.5">
                <div className="text-[11px] text-slate-400 print-text-muted mb-1">KS Statistic</div>
                <div className="flex items-baseline justify-between">
                  <span className={`text-xl font-bold font-mono ${performance.ksPass === true ? 'text-emerald-400' : performance.ksPass === false ? 'text-rose-400' : 'text-slate-200'} print-text-dark`}>
                    {performance.ks !== null ? performance.ks.toFixed(4) : '—'}
                  </span>
                  <span className="text-[10px] text-slate-500 print-text-muted">
                    {typeof performance.ksThreshold === 'number' ? `เกณฑ์ ≥ ${performance.ksThreshold}` : `เกณฑ์: ${performance.ksThreshold}`}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-3.5 text-xs text-slate-400 print-card print:p-2.5">
              {performance.message}
            </div>
          )}
        </section>

        {/* ── 7. คำแนะนำ (Recommendations) ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 shadow-sm print-card print:p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300 print-text-dark mb-3 flex items-center gap-2">
            <span>💡</span>
            <span>คำแนะนำและการปฏิบัติงาน (Recommendations & Action Items)</span>
          </h2>

          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 print-card print:p-3">
            <div className="text-xs font-semibold text-slate-300 print-text-dark mb-2">
              การดำเนินการที่แนะนำสำหรับรอบนี้ ({recommendation.actionTitle}):
            </div>
            <ul className="space-y-1.5 text-xs text-slate-300 print-text-dark">
              {recommendation.recommendations.map((rec, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-indigo-400 font-bold">•</span>
                  <span>{rec}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── 8. ท้ายรายงาน (Footer / Disclaimer) ── */}
        <footer className="text-xs text-slate-500 border-t border-slate-800/80 pt-4 print:border-slate-300 print-text-muted">
          <p className="leading-relaxed mb-2">
            {footerNotes.disclaimer}
          </p>
          <div className="flex justify-between items-center text-[10px] text-slate-600 print-text-muted mt-2">
            <span>ระบบติดตามความเสี่ยงแบบจำลองเครดิต (Credit Risk Monitor)</span>
            <span>สร้างรายงานเมื่อ: {footerNotes.generatedAt}</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
