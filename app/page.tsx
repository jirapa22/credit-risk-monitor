'use client';
import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function Dashboard() {
  const [metrics, setMetrics] = useState({ psi: 0, auc: 0.78, status: 'STABLE' });

  // ฟังก์ชันดึงข้อมูลที่เชื่อมกับ API ใหม่แล้ว
  const fetchMetrics = async () => {
    try {
      const response = await fetch('/api/risk-score');
      const data = await response.json();
      // รับค่าที่คำนวณจากสมการใน route.ts
      setMetrics({
        psi: data.psi,
        auc: data.auc,
        status: data.status
      });
    } catch (error) {
      console.error("Error fetching data:", error);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">AI-Assisted Credit Risk Monitoring</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {/* การ์ดแสดง PSI จากสมการ */}
        <div className={`bg-white p-6 rounded-lg shadow border-l-4 ${metrics.status === 'CRITICAL' ? 'border-red-600' : 'border-yellow-500'}`}>
          <h3 className="text-sm text-gray-500">Current PSI (Model Equation)</h3>
          <p className="text-3xl font-bold text-gray-800">{metrics.psi.toFixed(4)}</p>
          <span className={`text-xs font-bold ${metrics.status === 'CRITICAL' ? 'text-red-600' : 'text-green-600'}`}>
            {metrics.status}
          </span>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-green-500">
          <h3 className="text-sm text-gray-500">Current AUC</h3>
          <p className="text-3xl font-bold text-gray-800">{metrics.auc.toFixed(2)}</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-red-500">
          <h3 className="text-sm text-gray-500">System Status</h3>
          <p className="text-3xl font-bold text-gray-800">Active</p>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="font-bold text-gray-800 mb-4">Live Monitoring</h2>
        <p className="text-gray-600">ระบบกำลังคำนวณความเสี่ยงจากสมการ Model Weights ที่กำหนดใน Config</p>
      </div>
    </div>
  );
}