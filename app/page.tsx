'use client';
import { useState, useEffect } from 'react';
import type { ModelConfiguration } from './config/model/types';

export default function Dashboard() {
  const [latestPsi, setLatestPsi] = useState(0);
  const [psiStatus, setPsiStatus] = useState('STABLE');
  const [config, setConfig] = useState<ModelConfiguration | null>(null);

  // Load model configuration once on mount
  useEffect(() => {
    fetch('/api/model-config')
      .then((r) => r.json())
      .then((data: ModelConfiguration) => setConfig(data))
      .catch(() => {/* config unavailable — UI falls back to defaults */});
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = () =>
      fetch('/api/get-latest-psi')
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) {
            setLatestPsi(data.latestPsi ?? 0);
            setPsiStatus(data.status ?? 'STABLE');
          }
        })
        .catch(() => {/* keep previous values on transient errors */});

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const statusColor =
    psiStatus === 'CRITICAL' ? 'border-red-600' :
    psiStatus === 'WARN'     ? 'border-yellow-500' :
                               'border-green-500';

  const statusTextColor =
    psiStatus === 'CRITICAL' ? 'text-red-600' :
    psiStatus === 'WARN'     ? 'text-yellow-600' :
                               'text-green-600';

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <h1 className="text-2xl font-bold mb-2 text-gray-800">AI-Assisted Credit Risk Monitoring</h1>
      {config && (
        <p className="text-sm text-gray-500 mb-6">
          {config.model.name} · v{config.model.version} · {config.model.status}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {/* PSI Card — reads threshold from config, no hardcode */}
        <div className={`bg-white p-6 rounded-lg shadow border-l-4 ${statusColor}`}>
          <h3 className="text-sm text-gray-500">Current PSI</h3>
          <p className="text-3xl font-bold text-gray-800">{latestPsi.toFixed(4)}</p>
          <span className={`text-xs font-bold ${statusTextColor}`}>{psiStatus}</span>
          {config && (
            <p className="text-xs text-gray-400 mt-1">
              Warn ≥ {config.thresholds.psiWarnThreshold} · Critical ≥ {config.thresholds.psiCriticalThreshold}
            </p>
          )}
        </div>

        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-green-500">
          <h3 className="text-sm text-gray-500">Min AUC Threshold</h3>
          <p className="text-3xl font-bold text-gray-800">
            {config ? config.thresholds.minAuc.toFixed(2) : '—'}
          </p>
          <span className="text-xs text-gray-400">Minimum acceptable AUC</span>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-blue-500">
          <h3 className="text-sm text-gray-500">System Status</h3>
          <p className="text-3xl font-bold text-gray-800">Active</p>
          <span className="text-xs text-gray-400">
            {config ? `${config.features.filter(f => f.monitoringEnabled).length} features monitored` : ''}
          </span>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="font-bold text-gray-800 mb-4">Live Monitoring</h2>
        <p className="text-gray-600">ระบบกำลังติดตามค่า PSI จากประวัติการคำนวณล่าสุด</p>
        {config && (
          <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
            {config.features.filter(f => f.monitoringEnabled).map(f => (
              <div key={f.featureId} className="bg-gray-50 rounded p-3">
                <p className="font-medium text-gray-700">{f.displayName}</p>
                <p className="text-gray-400 text-xs">CSI threshold: {f.csiThreshold}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}