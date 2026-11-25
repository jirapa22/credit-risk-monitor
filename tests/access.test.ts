import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
import { POST as accessPost, DELETE as accessDelete, GET as accessGet } from '../app/api/access/route';
import { POST as ingestPost } from '../app/api/ingest/route';
import { GET as cronGet } from '../app/api/cron/pull-ingest/route';
import {
  generateAccessToken,
  clearRateLimit,
  ACCESS_COOKIE_NAME,
} from '../lib/auth/access';

const TEST_SECRET = 'SuperSecretAccessCode2026!';
const ORIGINAL_ENV = { ...process.env };

describe('Task D: Shared Access Code Authentication & Interception', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.ACCESS_CODE = TEST_SECRET;
    process.env.MONITOR_API_TOKEN = 'test-ingest-token-12345';
    process.env.CRON_SECRET = 'test-cron-secret-67890';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  // 6a) ไม่มี cookie: หน้าเว็บ redirect, API ได้ 401
  describe('6a: Unauthenticated access without cookie', () => {
    it('redirects page requests to /access with from parameter', async () => {
      const req = new NextRequest('http://localhost:3000/dashboard');
      const res = proxy(req);

      expect(res.status).toBe(307);
      const location = res.headers.get('location');
      expect(location).toBeDefined();
      expect(location).toContain('/access');
      expect(location).toContain('from=%2Fdashboard');
    });

    it('returns HTTP 401 JSON for API requests without redirecting', async () => {
      const req = new NextRequest('http://localhost:3000/api/registry/models');
      const res = proxy(req);

      expect(res.status).toBe(401);
      expect(res.headers.get('location')).toBeNull();
      const body = await res.json();
      expect(body.code).toBe('UNAUTHORIZED');
      expect(body.error).toContain('กรุณายืนยันรหัสเข้าใช้งานก่อน');
    });
  });

  // 6b) ใส่รหัสผิด: ได้ 401 ไม่มี Set-Cookie, ผิดครบ 5 ครั้ง ได้ 429
  describe('6b: Wrong password handling & rate limiting', () => {
    const testIp = '192.168.1.101';

    beforeEach(async () => {
      await clearRateLimit(testIp);
    });

    afterEach(async () => {
      await clearRateLimit(testIp);
    });

    it('returns 401 and no Set-Cookie on wrong password', async () => {
      const req = new Request('http://localhost:3000/api/access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': testIp,
        },
        body: JSON.stringify({ code: 'incorrect-pass' }),
      });

      const res = await accessPost(req);
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();

      const json = await res.json();
      expect(json.code).toBe('INVALID_CODE');
      expect(json.remainingAttempts).toBe(4);
    });

    it('locks out with HTTP 429 after 5 failed attempts within window', async () => {
      for (let i = 1; i <= 4; i++) {
        const req = new Request('http://localhost:3000/api/access', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-forwarded-for': testIp,
          },
          body: JSON.stringify({ code: `wrong-attempt-${i}` }),
        });
        const res = await accessPost(req);
        expect(res.status).toBe(401);
      }

      // 5th failed attempt triggers rate limit lockout
      const fifthReq = new Request('http://localhost:3000/api/access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': testIp,
        },
        body: JSON.stringify({ code: 'wrong-attempt-5' }),
      });
      const fifthRes = await accessPost(fifthReq);
      expect(fifthRes.status).toBe(429);
      const json = await fifthRes.json();
      expect(json.code).toBe('RATE_LIMITED');
      expect(json.error).toContain('ใส่รหัสผิดเกิน 5 ครั้ง');
      expect(typeof json.remainingSeconds).toBe('number');
      expect(json.remainingSeconds).toBeGreaterThan(0);

      // Subsequent attempt while locked also returns 429
      const lockedReq = new Request('http://localhost:3000/api/access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': testIp,
        },
        body: JSON.stringify({ code: TEST_SECRET }),
      });
      const lockedRes = await accessPost(lockedReq);
      expect(lockedRes.status).toBe(429);
    });
  });

  // 6c) ใส่รหัสถูก: ได้ cookie ที่มี httpOnly, secure (ถ้า prod), sameSite=Lax, อายุ 12 ชม., แล้วเข้าหน้าเว็บ/API ได้
  describe('6c: Correct password & session cookie attributes', () => {
    const cleanIp = '192.168.1.102';

    beforeEach(async () => {
      await clearRateLimit(cleanIp);
    });

    afterEach(async () => {
      await clearRateLimit(cleanIp);
    });

    it('issues cookie with httpOnly, sameSite=Lax, maxAge 12h and allows access', async () => {
      const loginReq = new Request('http://localhost:3000/api/access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': cleanIp,
        },
        body: JSON.stringify({ code: TEST_SECRET }),
      });

      const loginRes = await accessPost(loginReq);
      expect(loginRes.status).toBe(200);

      const setCookie = loginRes.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain(ACCESS_COOKIE_NAME);
      expect(setCookie?.toLowerCase()).toContain('httponly');
      expect(setCookie?.toLowerCase()).toContain('samesite=lax');
      expect(setCookie?.toLowerCase()).toContain('max-age=43200');

      // Extract token value from Set-Cookie header
      const tokenMatch = setCookie?.match(new RegExp(`${ACCESS_COOKIE_NAME}=([^;]+)`));
      expect(tokenMatch).not.toBeNull();
      const token = tokenMatch ? tokenMatch[1] : '';

      // Verify page access with valid cookie
      const pageReq = new NextRequest('http://localhost:3000/dashboard', {
        headers: { cookie: `${ACCESS_COOKIE_NAME}=${token}` },
      });
      const pageRes = proxy(pageReq);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get('location')).toBeNull();

      // Verify API access with valid cookie
      const apiReq = new NextRequest('http://localhost:3000/api/registry/models', {
        headers: { cookie: `${ACCESS_COOKIE_NAME}=${token}` },
      });
      const apiRes = proxy(apiReq);
      expect(apiRes.status).toBe(200);
    });

    it('sets secure cookie attribute in production environment', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const prodReq = new Request('http://localhost:3000/api/access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': cleanIp,
        },
        body: JSON.stringify({ code: TEST_SECRET }),
      });
      const prodRes = await accessPost(prodReq);
      expect(prodRes.status).toBe(200);
      const setCookie = prodRes.headers.get('set-cookie');
      expect(setCookie?.toLowerCase()).toContain('secure');
    });
  });

  // 6d) ปลอม cookie หรือ cookie หมดอายุ: ถูกปฏิเสธ
  describe('6d: Tampered or expired cookie rejection', () => {
    it('rejects tampered cookie signature', () => {
      const validToken = generateAccessToken(TEST_SECRET);
      const tamperedToken = `${validToken}tampered`;

      const pageReq = new NextRequest('http://localhost:3000/dashboard', {
        headers: { cookie: `${ACCESS_COOKIE_NAME}=${tamperedToken}` },
      });
      const pageRes = proxy(pageReq);
      expect(pageRes.status).toBe(307);
      expect(pageRes.headers.get('location')).toContain('/access');

      const apiReq = new NextRequest('http://localhost:3000/api/triggers', {
        headers: { cookie: `${ACCESS_COOKIE_NAME}=${tamperedToken}` },
      });
      const apiRes = proxy(apiReq);
      expect(apiRes.status).toBe(401);
    });

    it('rejects expired cookie token', () => {
      // Generate token expired 60 seconds ago
      const expiredToken = generateAccessToken(TEST_SECRET, -60);

      const pageReq = new NextRequest('http://localhost:3000/dashboard', {
        headers: { cookie: `${ACCESS_COOKIE_NAME}=${expiredToken}` },
      });
      const pageRes = proxy(pageReq);
      expect(pageRes.status).toBe(307);

      const apiReq = new NextRequest('http://localhost:3000/api/triggers', {
        headers: { cookie: `${ACCESS_COOKIE_NAME}=${expiredToken}` },
      });
      const apiRes = proxy(apiReq);
      expect(apiRes.status).toBe(401);
    });
  });

  // 6e) /api/ingest ที่มี Bearer token ถูกต้องผ่านได้โดยไม่ต้องมี cookie, ถ้าไม่มี Bearer ได้ 401
  describe('6e: /api/ingest Bearer authentication exemption', () => {
    it('allows POST /api/ingest with valid Bearer token without session cookie', async () => {
      // 1. Proxy level allows through
      const proxyReq = new NextRequest('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.MONITOR_API_TOKEN}`,
        },
      });
      const proxyRes = proxy(proxyReq);
      expect(proxyRes.status).toBe(200);

      // 2. Route handler level verifies Bearer token
      const handlerReq = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.MONITOR_API_TOKEN}`,
          'Content-Type': 'text/csv',
        },
        body: '',
      });
      const handlerRes = await ingestPost(handlerReq);
      // Empty body yields 400 Bad Request, NOT 401 Unauthorized
      expect(handlerRes.status).toBe(400);
      const json = await handlerRes.json();
      expect(json.error).not.toBe('Unauthorized');
    });

    it('returns 401 for POST /api/ingest when Bearer token is missing', async () => {
      const handlerReq = new Request('http://localhost:3000/api/ingest', {
        method: 'POST',
      });
      const handlerRes = await ingestPost(handlerReq);
      expect(handlerRes.status).toBe(401);
      const json = await handlerRes.json();
      expect(json.error).toBe('Unauthorized');
    });
  });

  // 6f) /api/cron/pull-ingest ที่มี valid CRON_SECRET ผ่านได้โดยไม่ต้องมี cookie
  describe('6f: /api/cron/pull-ingest CRON_SECRET exemption', () => {
    it('allows GET /api/cron/pull-ingest with valid CRON_SECRET without cookie', async () => {
      // 1. Proxy level allows through
      const proxyReq = new NextRequest('http://localhost:3000/api/cron/pull-ingest', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
      });
      const proxyRes = proxy(proxyReq);
      expect(proxyRes.status).toBe(200);

      // 2. Route handler level authorizes with CRON_SECRET
      const handlerReq = new Request('http://localhost:3000/api/cron/pull-ingest', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
      });
      const handlerRes = await cronGet(handlerReq);
      expect(handlerRes.status).not.toBe(401);
    });

    it('returns 401 for GET /api/cron/pull-ingest when CRON_SECRET is missing or wrong', async () => {
      const handlerReq = new Request('http://localhost:3000/api/cron/pull-ingest', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer wrong-secret',
        },
      });
      const handlerRes = await cronGet(handlerReq);
      expect(handlerRes.status).toBe(401);
    });
  });

  // 6g) ACCESS_CODE ไม่ได้ตั้ง -> ปลดล็อก
  describe('6g: Unconfigured ACCESS_CODE bypass', () => {
    beforeEach(() => {
      delete process.env.ACCESS_CODE;
    });

    it('bypasses proxy protection and unlocks both pages and API endpoints', () => {
      const pageReq = new NextRequest('http://localhost:3000/dashboard');
      const pageRes = proxy(pageReq);
      expect(pageRes.status).toBe(200);

      const apiReq = new NextRequest('http://localhost:3000/api/registry/models');
      const apiRes = proxy(apiReq);
      expect(apiRes.status).toBe(200);
    });

    it('reports unconfigured status in GET /api/access', async () => {
      const req = new Request('http://localhost:3000/api/access', { method: 'GET' });
      const res = await accessGet(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.configured).toBe(false);
      expect(json.authenticated).toBe(true);
    });
  });

  // 6h) ค่า ACCESS_CODE ไม่ปรากฏในผลลัพธ์/error/log ใดๆ
  describe('6h: Strict confidentiality of ACCESS_CODE', () => {
    it('never leaks ACCESS_CODE in responses, errors, or issued cookies', async () => {
      // 1. Check wrong password response
      const wrongReq = new Request('http://localhost:3000/api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'wrong-attempt' }),
      });
      const wrongRes = await accessPost(wrongReq);
      const wrongText = await wrongRes.text();
      expect(wrongText).not.toContain(TEST_SECRET);

      // 2. Check successful login response and Set-Cookie header
      const goodReq = new Request('http://localhost:3000/api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: TEST_SECRET }),
      });
      const goodRes = await accessPost(goodReq);
      const goodText = await goodRes.text();
      expect(goodText).not.toContain(TEST_SECRET);

      const cookieVal = goodRes.headers.get('set-cookie') || '';
      expect(cookieVal).not.toContain(TEST_SECRET);

      // 3. Check logout response
      const logoutRes = await accessDelete();
      const logoutText = await logoutRes.text();
      expect(logoutText).not.toContain(TEST_SECRET);

      // 4. Check status GET response
      const getRes = await accessGet(new Request('http://localhost:3000/api/access'));
      const getText = await getRes.text();
      expect(getText).not.toContain(TEST_SECRET);
    });
  });
});
