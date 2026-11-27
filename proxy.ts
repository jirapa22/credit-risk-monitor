import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  isAccessCodeConfigured,
  verifyAccessToken,
  ACCESS_COOKIE_NAME,
  sanitizeRedirectPath,
} from './lib/auth/access';

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. If ACCESS_CODE is not configured in env, allow access with server warning
  if (!isAccessCodeConfigured()) {
    console.warn('[CRM Auth Warning] ACCESS_CODE is not configured. Access protection is bypassed.');
    return NextResponse.next();
  }

  // 2. Exempt paths:
  // - /access (login page)
  if (pathname === '/access' || pathname.startsWith('/access/')) {
    return NextResponse.next();
  }

  // - /api/access (login, logout, status endpoints)
  if (pathname === '/api/access' || pathname.startsWith('/api/access/')) {
    return NextResponse.next();
  }

  // - Endpoints with existing auth mechanisms:
  //   POST /api/ingest: authenticated via Bearer MONITOR_API_TOKEN
  if (pathname === '/api/ingest' && request.method === 'POST') {
    return NextResponse.next();
  }

  //   GET /api/cron/pull-ingest: authenticated via Bearer CRON_SECRET
  if (pathname === '/api/cron/pull-ingest' && request.method === 'GET') {
    return NextResponse.next();
  }

  // 3. Verify session cookie
  const token = request.cookies.get(ACCESS_COOKIE_NAME)?.value;
  const result = verifyAccessToken(token);

  if (result.valid) {
    return NextResponse.next();
  }

  // 4. Unauthenticated handling:
  // API endpoints: return HTTP 401 JSON in Thai (STRICTLY NO REDIRECT)
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        error: 'กรุณายืนยันรหัสเข้าใช้งานก่อน (Unauthorized)',
        code: 'UNAUTHORIZED',
      },
      { status: 401 }
    );
  }

  // Web pages: redirect to /access with return destination
  const accessUrl = new URL('/access', request.url);
  const target = pathname === '/' ? '/dashboard' : sanitizeRedirectPath(pathname);
  accessUrl.searchParams.set('from', target);
  return NextResponse.redirect(accessUrl);
}

export default proxy;

