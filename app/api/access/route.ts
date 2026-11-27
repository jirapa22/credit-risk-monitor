import { NextResponse } from 'next/server';
import {
  isAccessCodeConfigured,
  verifyAccessCode,
  generateAccessToken,
  verifyAccessToken,
  getClientIp,
  checkRateLimit,
  recordFailedAttempt,
  clearRateLimit,
  ACCESS_COOKIE_NAME,
  ACCESS_COOKIE_MAX_AGE,
  RATE_LIMIT_MAX_ATTEMPTS,
} from '../../../lib/auth/access';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ip = getClientIp(request);

  // 1. Check rate limit
  const rateLimit = await checkRateLimit(ip);
  if (rateLimit.locked) {
    return NextResponse.json(
      {
        error: `ใส่รหัสผิดเกินจำนวนครั้งที่กำหนด ระบบระงับชั่วคราว กรุณารออีก ${rateLimit.remainingSeconds} วินาที`,
        code: 'RATE_LIMITED',
        remainingSeconds: rateLimit.remainingSeconds,
      },
      { status: 429 }
    );
  }

  // Parse request body
  let code = '';
  try {
    const body = await request.json();
    if (typeof body?.code === 'string') {
      code = body.code;
    }
  } catch {
    return NextResponse.json(
      { error: 'รูปแบบข้อมูลไม่ถูกต้อง กรุณาส่ง JSON พร้อมฟิลด์ code' },
      { status: 400 }
    );
  }

  // 2. Check if ACCESS_CODE is configured
  if (!isAccessCodeConfigured()) {
    return NextResponse.json({
      success: true,
      message: 'ระบบไม่ได้ตั้งรหัสผ่าน (เข้าถึงได้โดยไม่ต้องยืนยันรหัส)',
      unconfigured: true,
    });
  }

  // 3. Verify access code
  const isValid = verifyAccessCode(code);
  if (!isValid) {
    const updatedRateLimit = await recordFailedAttempt(ip);
    if (updatedRateLimit.locked) {
      return NextResponse.json(
        {
          error: `ใส่รหัสผิดเกิน ${RATE_LIMIT_MAX_ATTEMPTS} ครั้ง ระบบถูกระงับชั่วคราว 15 นาที กรุณารออีก ${updatedRateLimit.remainingSeconds} วินาที`,
          code: 'RATE_LIMITED',
          remainingSeconds: updatedRateLimit.remainingSeconds,
        },
        { status: 429 }
      );
    }

    const remainingAttempts = Math.max(0, RATE_LIMIT_MAX_ATTEMPTS - (updatedRateLimit.attempts || 1));
    return NextResponse.json(
      {
        error: `รหัสเข้าใช้งานไม่ถูกต้อง (เหลือโอกาสอีก ${remainingAttempts} ครั้ง)`,
        code: 'INVALID_CODE',
        remainingAttempts,
      },
      { status: 401 }
    );
  }

  // 4. Success: Clear rate limit & issue token
  await clearRateLimit(ip);
  const token = generateAccessToken();

  const response = NextResponse.json({
    success: true,
    message: 'ยืนยันรหัสผ่านสำเร็จ',
  });

  const isProduction = process.env.NODE_ENV === 'production';
  response.cookies.set(ACCESS_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({
    success: true,
    message: 'ออกจากระบบเรียบร้อย',
  });

  const isProduction = process.env.NODE_ENV === 'production';
  response.cookies.set(ACCESS_COOKIE_NAME, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  return response;
}

export async function GET(request: Request) {
  const configured = isAccessCodeConfigured();
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${ACCESS_COOKIE_NAME}=`));
  const token = match ? match.slice(ACCESS_COOKIE_NAME.length + 1) : null;
  const verification = verifyAccessToken(token);

  return NextResponse.json({
    configured,
    authenticated: verification.valid,
  });
}

