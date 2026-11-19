'use client';

import React from 'react';
import Link from 'next/link';

export default function ReportActions({ modelId }: { modelId?: string }) {
  const handlePrint = () => {
    if (typeof window !== 'undefined') {
      window.print();
    }
  };

  const backUrl = modelId ? `/dashboard?modelId=${encodeURIComponent(modelId)}` : '/dashboard';

  return (
    <div className="no-print bg-slate-900 border-b border-slate-800 px-6 py-3.5 flex items-center justify-between sticky top-0 z-50 shadow-md">
      <div className="flex items-center gap-3">
        <Link
          href={backUrl}
          className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors flex items-center gap-1.5 font-medium border border-slate-700"
        >
          <span>←</span>
          <span>กลับแดชบอร์ด</span>
        </Link>
        <span className="text-xs text-slate-500 font-mono">|</span>
        <span className="text-xs font-semibold text-slate-300">
          รายงานผลการติดตามโมเดลประจำรอบ (Per-run Drift Report)
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handlePrint}
          className="text-xs px-3.5 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors flex items-center gap-1.5 font-medium shadow-sm cursor-pointer"
          title="พิมพ์รายงานหรือบันทึกเป็น PDF (Ctrl/Cmd+P)"
        >
          <span>🖨️</span>
          <span>พิมพ์รายงาน / บันทึก PDF</span>
        </button>
      </div>
    </div>
  );
}
