'use client';
import { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import type { ModelConfiguration } from '../config/model/types';

// ─── IV Strength helper ──────────────────────────────────────────────────────
function ivStrength(iv: number): { label: string; color: string } {
  if (iv < 0.02) return { label: 'Negligible', color: 'text-gray-400' };
  if (iv < 0.1)  return { label: 'Weak', color: 'text-yellow-600' };
  if (iv < 0.3)  return { label: 'Moderate', color: 'text-blue-600' };
  return { label: 'Strong', color: 'text-green-700' };
}

// ─── Overfitting gap helper ──────────────────────────────────────────────────
function gapColor(gap: number): string {
  const abs = Math.abs(gap);
  if (abs < 0.05) return 'text-green-600';
  if (abs < 0.1)  return 'text-yellow-600';
  return 'text-red-600';
}

export default function Dashboard() {
  const [psi, setPsi] = useState(0.12);
  const [config, setConfig] = useState<ModelConfiguration | null>(null);

  useEffect(() => {
    fetch('/api/model-config')
      .then((r) => r.json())
      .then((data: ModelConfiguration) => setConfig(data))
      .catch(() => {/* silently fall back to defaults */});
  }, []);

  const criticalThreshold = config?.thresholds.psiCriticalThreshold ?? 0.15;
  const warnThreshold     = config?.thresholds.psiWarnThreshold ?? 0.10;

  const chartData = [
    { name: 'Jan', psi: 0.05, forecast: null },
    { name: 'Feb', psi: 0.07, forecast: null },
    { name: 'Mar', psi: 0.06, forecast: null },
    { name: 'Apr', psi: 0.09, forecast: null },
    { name: 'May', psi: 0.11, forecast: null },
    { name: 'Jun', psi: psi,  forecast: 0.12 },
    { name: 'Jul (AI)', psi: null, forecast: 0.15 },
  ];

  const triggerDrift = () => setPsi((prev) => Math.min(prev + 0.05, 1.0));

  // Performance from config (test split = production benchmark)
  const testAuc  = config?.performance.test.auc  ?? null;
  const testGini = config?.performance.test.gini ?? null;
  const testKs   = config?.performance.test.ks   ?? null;
  const trainPerf = config?.performance.train;
  const testPerf  = config?.performance.test;

  return (
    <div className="p-6 bg-gray-50 min-h-screen space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">
        AI-Assisted Credit Risk Monitoring
      </h1>

      {/* ── Sec 1: KPI Cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* PSI */}
        <div className={`bg-white p-5 rounded-lg shadow border-l-4 ${
          psi >= criticalThreshold ? 'border-red-500' :
          psi >= warnThreshold     ? 'border-yellow-500' :
                                     'border-green-500'
        }`}>
          <p className="text-xs text-gray-500 uppercase tracking-wide">Current PSI</p>
          <p className="text-3xl font-bold text-gray-800 mt-1">{psi.toFixed(2)}</p>
          <p className="text-xs text-gray-400 mt-1">
            Warn ≥ {warnThreshold} · Critical ≥ {criticalThreshold}
          </p>
        </div>

        {/* Test AUC — actual baseline value, NOT a threshold */}
        <div className="bg-white p-5 rounded-lg shadow border-l-4 border-blue-500">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Baseline AUC (Test)</p>
          <p className="text-3xl font-bold text-gray-800 mt-1">
            {testAuc !== null ? testAuc.toFixed(3) : '—'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {testPerf ? `n = ${testPerf.sampleSize.toLocaleString()} · ${testPerf.period}` : ''}
          </p>
        </div>

        {/* Test Gini — actual baseline value */}
        <div className="bg-white p-5 rounded-lg shadow border-l-4 border-purple-500">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Baseline Gini (Test)</p>
          <p className="text-3xl font-bold text-gray-800 mt-1">
            {testGini !== null ? testGini.toFixed(3) : '—'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Min acceptable: {config?.thresholds.minGini ?? '—'}
          </p>
        </div>

        {/* Test KS */}
        <div className="bg-white p-5 rounded-lg shadow border-l-4 border-teal-500">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Baseline KS (Test)</p>
          <p className="text-3xl font-bold text-gray-800 mt-1">
            {testKs !== null ? testKs.toFixed(3) : '—'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Min acceptable: {config?.thresholds.minKs ?? '—'}
          </p>
        </div>
      </div>

      {/* ── Sec 2: Baseline Feature Distribution (actual stats, not thresholds) */}
      {config && (
        <div className="bg-white rounded-lg shadow p-5">
          <h2 className="font-bold text-gray-800 mb-3">
            Baseline Feature Distribution
            <span className="ml-2 text-xs font-normal text-gray-400">
              (Training set stats · {config.performance.train.period} · n = {config.performance.train.sampleSize})
            </span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b text-gray-500 text-xs uppercase">
                  <th className="pb-2 pr-4">Feature</th>
                  <th className="pb-2 pr-4 text-right">Mean</th>
                  <th className="pb-2 pr-4 text-right">Std</th>
                  <th className="pb-2 pr-4 text-right">Median</th>
                  <th className="pb-2 pr-4 text-right">P25</th>
                  <th className="pb-2 pr-4 text-right">P75</th>
                  <th className="pb-2 pr-4 text-right">Min</th>
                  <th className="pb-2 pr-4 text-right">Max</th>
                  <th className="pb-2 text-right">Missing%</th>
                </tr>
              </thead>
              <tbody>
                {config.features.map((feat) => {
                  const b = config.baseline.find(
                    (bl) => bl.featureId === feat.featureId
                  );
                  if (!b) return null;
                  const fmt = (v: number) =>
                    feat.columnName === 'dti_ratio'
                      ? v.toFixed(3)
                      : v.toLocaleString();
                  return (
                    <tr key={feat.featureId} className="border-b last:border-0 text-gray-700">
                      <td className="py-2 pr-4 font-medium">{feat.displayName}</td>
                      <td className="py-2 pr-4 text-right">{fmt(b.mean)}</td>
                      <td className="py-2 pr-4 text-right">{fmt(b.std)}</td>
                      <td className="py-2 pr-4 text-right">{fmt(b.median)}</td>
                      <td className="py-2 pr-4 text-right">{fmt(b.p25)}</td>
                      <td className="py-2 pr-4 text-right">{fmt(b.p75)}</td>
                      <td className="py-2 pr-4 text-right">{fmt(b.min)}</td>
                      <td className="py-2 pr-4 text-right">{fmt(b.max)}</td>
                      <td className="py-2 text-right">
                        {(b.missingPct * 100).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Sec 3: PSI Trend + Drift Simulator ──────────────────────────── */}
      <div className="bg-white p-5 rounded-lg shadow">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-gray-800">Historical & Predicted PSI Trend</h2>
          <button
            onClick={triggerDrift}
            className="bg-red-600 text-white text-sm px-3 py-1.5 rounded hover:bg-red-700 transition"
          >
            Simulate Drift (+0.05 PSI)
          </button>
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis domain={[0, 0.4]} />
              <Tooltip />
              <Legend />
              <ReferenceLine y={warnThreshold}     stroke="#eab308" strokeDasharray="4 2" label={{ value: 'Warn', fontSize: 11 }} />
              <ReferenceLine y={criticalThreshold} stroke="#ef4444" strokeDasharray="4 2" label={{ value: 'Critical', fontSize: 11 }} />
              <Line type="monotone" dataKey="psi"      stroke="#eab308" strokeWidth={3} name="Actual PSI" dot />
              <Line type="monotone" dataKey="forecast" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 5" name="AI Forecast" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* AI Insight */}
      <div className="bg-blue-50 p-5 rounded-lg border border-blue-200">
        <h2 className="font-bold text-blue-800">AI Predictive Insight</h2>
        <div className="mt-2 text-blue-700 text-sm">
          {psi >= criticalThreshold ? (
            <p>⚠️ <strong>ตรวจพบความเสี่ยงสูงเกินเกณฑ์!</strong> แนะนำให้ทำการ Retrain โมเดลทันทีเพื่อป้องกัน NPL</p>
          ) : psi >= warnThreshold ? (
            <p>🟡 PSI อยู่ในระดับ Warning — ติดตามอย่างใกล้ชิดและเตรียมข้อมูลสำหรับ re-evaluation</p>
          ) : (
            <p>✅ ค่า PSI อยู่ในเกณฑ์ปกติ แนะนำให้ติดตามผลต่อเนื่องตาม monitoring cycle ปกติ</p>
          )}
        </div>
      </div>

      {/* ── Sec 4: Model Analytics ───────────────────────────────────────── */}
      {config && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-gray-800 border-b pb-2">
            Section 4 — Model Analytics
          </h2>

          {/* 4.1 IV per Feature */}
          <div className="bg-white rounded-lg shadow p-5">
            <h3 className="font-semibold text-gray-700 mb-3">
              4.1 Information Value (IV) per Feature
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-gray-500 text-xs uppercase">
                    <th className="pb-2 pr-4 text-left">Feature</th>
                    <th className="pb-2 pr-4 text-left">Column</th>
                    <th className="pb-2 pr-4 text-right">IV</th>
                    <th className="pb-2 pr-4 text-left">Strength</th>
                    <th className="pb-2 text-right">Bins</th>
                  </tr>
                </thead>
                <tbody>
                  {config.features.map((feat) => {
                    const { label, color } = ivStrength(feat.iv);
                    return (
                      <tr key={feat.featureId} className="border-b last:border-0 text-gray-700">
                        <td className="py-2 pr-4 font-medium">{feat.displayName}</td>
                        <td className="py-2 pr-4 text-gray-500 font-mono text-xs">{feat.columnName}</td>
                        <td className="py-2 pr-4 text-right font-semibold">{feat.iv.toFixed(3)}</td>
                        <td className={`py-2 pr-4 font-medium ${color}`}>{label}</td>
                        <td className="py-2 text-right text-gray-500">{feat.bins.length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 p-3 bg-gray-50 rounded text-xs text-gray-500 grid grid-cols-2 md:grid-cols-4 gap-2">
              <span>IV &lt; 0.02 → Negligible</span>
              <span>0.02–0.10 → Weak</span>
              <span>0.10–0.30 → Moderate</span>
              <span>&gt; 0.30 → Strong</span>
            </div>
          </div>

          {/* 4.2 CSI per Feature */}
          <div className="bg-white rounded-lg shadow p-5">
            <h3 className="font-semibold text-gray-700 mb-3">
              4.2 CSI per Feature (Current Monitoring Window)
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-gray-500 text-xs uppercase">
                    <th className="pb-2 pr-4 text-left">Feature</th>
                    <th className="pb-2 pr-4 text-right">Alert Limit</th>
                    <th className="pb-2 pr-4 text-right">CSI (Current)</th>
                    <th className="pb-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {config.features.map((feat) => (
                    <tr key={feat.featureId} className="border-b last:border-0 text-gray-700">
                      <td className="py-2 pr-4 font-medium">{feat.displayName}</td>
                      <td className="py-2 pr-4 text-right text-gray-500">≥ {feat.csiThreshold.toFixed(2)}</td>
                      <td className="py-2 pr-4 text-right text-gray-400 italic">N/A</td>
                      <td className="py-2 text-gray-400 text-xs italic">
                        Upload monitoring CSV to calculate
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-gray-400">
              CSI = Σ (Actual% − Expected%) × ln(Actual%/Expected%) computed per bin
              against baseline distribution stored in each feature&apos;s <code>pct</code> field.
            </p>
          </div>

          {/* 4.3 Train vs Test Performance */}
          <div className="bg-white rounded-lg shadow p-5">
            <h3 className="font-semibold text-gray-700 mb-3">
              4.3 Train vs Test Performance Comparison
            </h3>
            {trainPerf && testPerf && (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-gray-500 text-xs uppercase">
                        <th className="pb-2 pr-4 text-left">Split</th>
                        <th className="pb-2 pr-4 text-left">Period</th>
                        <th className="pb-2 pr-4 text-right">n</th>
                        <th className="pb-2 pr-4 text-right">Bad Rate</th>
                        <th className="pb-2 pr-4 text-right">AUC</th>
                        <th className="pb-2 pr-4 text-right">Gini</th>
                        <th className="pb-2 text-right">KS</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b text-gray-700">
                        <td className="py-2 pr-4 font-semibold text-blue-700">Train</td>
                        <td className="py-2 pr-4 text-gray-500 text-xs">{trainPerf.period}</td>
                        <td className="py-2 pr-4 text-right">{trainPerf.sampleSize.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right">{(trainPerf.badRate * 100).toFixed(1)}%</td>
                        <td className="py-2 pr-4 text-right font-semibold">{trainPerf.auc.toFixed(3)}</td>
                        <td className="py-2 pr-4 text-right font-semibold">{trainPerf.gini.toFixed(3)}</td>
                        <td className="py-2 text-right font-semibold">{trainPerf.ks.toFixed(3)}</td>
                      </tr>
                      <tr className="border-b text-gray-700">
                        <td className="py-2 pr-4 font-semibold text-orange-700">Test</td>
                        <td className="py-2 pr-4 text-gray-500 text-xs">{testPerf.period}</td>
                        <td className="py-2 pr-4 text-right">{testPerf.sampleSize.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right">{(testPerf.badRate * 100).toFixed(1)}%</td>
                        <td className="py-2 pr-4 text-right font-semibold">{testPerf.auc.toFixed(3)}</td>
                        <td className="py-2 pr-4 text-right font-semibold">{testPerf.gini.toFixed(3)}</td>
                        <td className="py-2 text-right font-semibold">{testPerf.ks.toFixed(3)}</td>
                      </tr>
                      {/* Gap row */}
                      <tr className="bg-gray-50 text-xs">
                        <td className="py-2 pr-4 font-semibold text-gray-600" colSpan={4}>
                          Gap (Test − Train)
                        </td>
                        <td className={`py-2 pr-4 text-right font-bold ${gapColor(testPerf.auc - trainPerf.auc)}`}>
                          {(testPerf.auc - trainPerf.auc).toFixed(3)}
                        </td>
                        <td className={`py-2 pr-4 text-right font-bold ${gapColor(testPerf.gini - trainPerf.gini)}`}>
                          {(testPerf.gini - trainPerf.gini).toFixed(3)}
                        </td>
                        <td className={`py-2 text-right font-bold ${gapColor(testPerf.ks - trainPerf.ks)}`}>
                          {(testPerf.ks - trainPerf.ks).toFixed(3)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Overfitting note */}
                {Math.abs(testPerf.gini - trainPerf.gini) > 0.1 && (
                  <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                    <strong>⚠️ Overfitting alert:</strong>{' '}
                    Gini ลดลง{' '}
                    {(
                      ((trainPerf.gini - testPerf.gini) / trainPerf.gini) *
                      100
                    ).toFixed(0)}
                    % จาก Train → Test (
                    {trainPerf.gini.toFixed(3)} → {testPerf.gini.toFixed(3)}).
                    แนะนำให้ตรวจสอบ: (1) distribution shift ระหว่าง {trainPerf.period} และ {testPerf.period};
                    (2) จำนวนตัวแปรเทียบกับ bad count ใน train set;
                    (3) พิจารณา out-of-time validation ด้วย window ที่กว้างกว่า
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}