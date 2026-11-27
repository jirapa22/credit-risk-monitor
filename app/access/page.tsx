'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { sanitizeRedirectPath } from '../../lib/auth/redirect';

function AccessContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = sanitizeRedirectPath(searchParams.get('from'));

  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const [unconfigured, setUnconfigured] = useState(false);

  // Check initial status
  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await fetch('/api/access');
        if (res.ok) {
          const data = await res.json();
          if (!data.configured) {
            setUnconfigured(true);
          } else if (data.authenticated) {
            router.replace(from);
          }
        }
      } catch {
        // Ignore network errors on check
      }
    }
    checkStatus();
  }, [from, router]);

  // Handle countdown timer if rate limited
  useEffect(() => {
    if (!rateLimitedUntil) return;

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining <= 0) {
        setRateLimitedUntil(null);
        setError(null);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [rateLimitedUntil]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() && !unconfigured) return;
    if (rateLimitedUntil && countdown > 0) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        // Successful login: redirect to sanitized internal destination
        window.location.href = from;
        return;
      }

      if (res.status === 429) {
        const seconds = data.remainingSeconds || 900;
        setRateLimitedUntil(Date.now() + seconds * 1000);
        setCountdown(seconds);
        setError(data.error || `ใส่รหัสผิดเกินจำนวนครั้งที่กำหนด กรุณารอ ${seconds} วินาที`);
      } else {
        setError(data.error || 'รหัสผ่านไม่ถูกต้อง');
      }
    } catch {
      setError('เกิดข้อผิดพลาดในการเชื่อมต่อกับเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4 selection:bg-indigo-500 selection:text-white">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl relative overflow-hidden">
        {/* Top Accent Gradient */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />

        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-xl font-bold text-indigo-400 mx-auto mb-3 shadow-inner">
            🛡️
          </div>
          <h1 className="text-xl font-bold tracking-tight text-white">Credit Risk Monitor</h1>
          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
            ระบบจำกัดการเข้าถึงเฉพาะบุคลากรที่เกี่ยวข้อง กรุณายืนยันรหัสเข้าใช้งานส่วนกลาง
          </p>
        </div>

        {unconfigured && (
          <div className="mb-6 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2.5">
            <span className="text-sm">⚠️</span>
            <div>
              <p className="font-semibold text-amber-200">ยังไม่ได้ตั้งรหัสผ่าน (ACCESS_CODE)</p>
              <p className="text-[11px] text-amber-300/80 mt-0.5">
                เซิร์ฟเวอร์ยังไม่ได้กำหนด ACCESS_CODE ในระบบ ท่านสามารถกดปุ่มด้านล่างเพื่อเข้าสู่ระบบได้ทันที
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-6 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5">
            <span className="text-sm">🚫</span>
            <div className="flex-1">
              <p className="font-semibold text-rose-200">ไม่สามารถเข้าใช้งานได้</p>
              <p className="text-[11px] text-rose-300/90 mt-0.5 leading-relaxed">{error}</p>
              {countdown > 0 && (
                <p className="text-[11px] font-mono text-rose-400 mt-1 font-medium">
                  กรุณารออีก: {Math.floor(countdown / 60)} นาที {countdown % 60} วินาที
                </p>
              )}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!unconfigured && (
            <div>
              <label htmlFor="accessCode" className="block text-xs font-medium text-slate-300 mb-1.5">
                รหัสผ่านร่วม (Access Code)
              </label>
              <div className="relative">
                <input
                  id="accessCode"
                  type={showCode ? 'text' : 'password'}
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="กรอกรหัสเข้าใช้งาน..."
                  disabled={loading || Boolean(countdown > 0)}
                  autoFocus
                  required
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowCode(!showCode)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-200 p-1"
                >
                  {showCode ? 'ซ่อน' : 'แสดง'}
                </button>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || Boolean(countdown > 0) || (!unconfigured && !code.trim())}
            className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-medium text-sm transition shadow-lg shadow-indigo-600/20 disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                <span>กำลังตรวจสอบ...</span>
              </>
            ) : countdown > 0 ? (
              <span>ระงับการลองชั่วคราว ({countdown}s)</span>
            ) : (
              <span>เข้าใช้งานระบบ</span>
            )}
          </button>
        </form>

        <div className="mt-8 pt-5 border-t border-slate-800/80 text-[11px] text-slate-500 space-y-1.5">
          <p className="flex items-start gap-1.5">
            <span>ℹ️</span>
            <span>
              <strong>รหัสผ่านร่วม (Shared Secret):</strong> ระบบนี้ใช้รหัสผ่านส่วนกลางเพื่อป้องกันการเข้าถึงสาธารณะ ยังไม่ใช่ระบบบัญชีผู้ใช้ส่วนบุคคล
            </span>
          </p>
          <p className="text-[10px] text-slate-600 pl-4">
            เซสชันจะมีอายุ 12 ชั่วโมงหลังยืนยันรหัสถูกต้อง
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AccessPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center text-xs font-mono">
          กำลังโหลด...
        </div>
      }
    >
      <AccessContent />
    </Suspense>
  );
}

