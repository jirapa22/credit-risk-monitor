'use client';
import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function Dashboard() {
  const [psi, setPsi] = useState(0.12);

  const data = [
    { name: 'Jan', psi: 0.05, forecast: null },
    { name: 'Feb', psi: 0.07, forecast: null },
    { name: 'Mar', psi: 0.06, forecast: null },
    { name: 'Apr', psi: 0.09, forecast: null },
    { name: 'May', psi: 0.11, forecast: null },
    { name: 'Jun', psi: psi, forecast: 0.12 },
    { name: 'Jul (AI)', psi: null, forecast: 0.15 },
  ];

  const triggerDrift = () => {
    setPsi(prev => Math.min(prev + 0.05, 1.0));
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">AI-Assisted Credit Risk Monitoring</h1>
      
      <div className="mb-6">
        <button 
          onClick={triggerDrift}
          className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 transition"
        >
          Simulate Model Drift (+0.05 PSI)
        </button>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-yellow-500">
          <h3 className="text-sm text-gray-500">Current PSI</h3>
          <p className="text-3xl font-bold text-gray-800">{psi.toFixed(2)}</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-green-500">
          <h3 className="text-sm text-gray-500">Current AUC</h3>
          <p className="text-3xl font-bold text-gray-800">0.78</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow border-l-4 border-red-500">
          <h3 className="text-sm text-gray-500">Est. NPL Impact</h3>
          <p className="text-3xl font-bold text-gray-800">{(psi * 10).toFixed(1)}%</p>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow mb-8">
        <h2 className="font-bold text-gray-800 mb-4">Historical & Predicted PSI Trend</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="psi" stroke="#eab308" strokeWidth={3} name="Actual PSI" />
              <Line type="monotone" dataKey="forecast" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 5" name="AI Forecast" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-blue-50 p-6 rounded-lg border border-blue-200">
        <h2 className="font-bold text-blue-800">AI Predictive Insight</h2>
        <div className="mt-2 text-blue-700">
          {psi > 0.15 ? (
            <p>⚠️ <strong>ตรวจพบความเสี่ยงสูงเกินเกณฑ์!</strong> แนะนำให้ทำการ Retrain โมเดลทันทีเพื่อป้องกัน NPL</p>
          ) : (
            <p>จากการวิเคราะห์แนวโน้ม พบว่าค่า PSI อยู่ในระดับที่เฝ้าระวัง แนะนำให้ติดตามผลอย่างใกล้ชิด</p>
          )}
        </div>
      </div>
    </div>
  );
}