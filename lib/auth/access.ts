/**
 * Shared Access Code Authentication & Rate Limiting Module (Step 15 / งาน D)
 *
 * Implements:
 * 1. ACCESS_CODE verification via constant-time comparison (crypto.timingSafeEqual).
 * 2. HMAC-SHA256 session token generation and verification (key = ACCESS_CODE).
 * 3. Rate limiting by IP (max 5 failed attempts in 15 minutes, stored in KV).
 * 4. Secure HTTP-only cookie configuration (12-hour expiration).
 * 5. Strict privacy: ACCESS_CODE is NEVER logged, printed, or included in errors/cookies.
 */
import crypto from 'node:crypto';
import { getStore } from '../storage/store';

export const ACCESS_COOKIE_NAME = 'crm_access_token';
export const ACCESS_COOKIE_MAX_AGE = 12 * 60 * 60; // 12 hours in seconds
export const RATE_LIMIT_MAX_ATTEMPTS = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes in ms

export interface RateLimitStatus {
  locked: boolean;
  remainingSeconds?: number;
  attempts?: number;
}

export interface TokenVerificationResult {
  valid: boolean;
  reason?: 'missing' | 'invalid_format' | 'expired' | 'invalid_signature' | 'unconfigured';
}

/**
 * Checks whether ACCESS_CODE is configured in environment variables.
 */
export function isAccessCodeConfigured(): boolean {
  const code = process.env.ACCESS_CODE;
  return Boolean(code && typeof code === 'string' && code.trim() !== '');
}

/**
 * Retrieves the configured ACCESS_CODE without exposing it in logs or errors.
 */
function getSecretKey(): string | null {
  const code = process.env.ACCESS_CODE;
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return null;
  }
  return code.trim();
}

/**
 * Constant-time comparison between user input and configured ACCESS_CODE.
 * Never throws or leaks the secret in error messages.
 */
export function verifyAccessCode(inputCode: string): boolean {
  const secret = getSecretKey();
  if (!secret) {
    // If ACCESS_CODE is not configured, authentication is bypassed
    return true;
  }
  if (!inputCode || typeof inputCode !== 'string') {
    return false;
  }

  const secretBuf = Buffer.from(secret);
  const inputBuf = Buffer.from(inputCode);

  if (secretBuf.length !== inputBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(secretBuf, inputBuf);
}

/**
 * Generates an HMAC-SHA256 signed token with expiration timestamp.
 * Token structure: `${exp}.${signature}`
 * The actual ACCESS_CODE is NEVER embedded in the token.
 */
export function generateAccessToken(secretOverride?: string, ttlSeconds = ACCESS_COOKIE_MAX_AGE): string {
  const secret = secretOverride || getSecretKey();
  if (!secret) {
    throw new Error('ACCESS_CODE is not configured');
  }

  const exp = Date.now() + ttlSeconds * 1000;
  const expStr = String(exp);
  const signature = crypto.createHmac('sha256', secret).update(expStr).digest('hex');

  return `${expStr}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed session token.
 * Validates expiration and cryptographic signature using constant-time comparison.
 */
export function verifyAccessToken(
  token: string | null | undefined,
  secretOverride?: string,
): TokenVerificationResult {
  const secret = secretOverride || getSecretKey();
  if (!secret) {
    // Not configured: allow access
    return { valid: true, reason: 'unconfigured' };
  }

  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'missing' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'invalid_format' };
  }

  const [expStr, sig] = parts;
  const exp = parseInt(expStr, 10);

  if (isNaN(exp)) {
    return { valid: false, reason: 'invalid_format' };
  }

  if (Date.now() > exp) {
    return { valid: false, reason: 'expired' };
  }

  const expectedSig = crypto.createHmac('sha256', secret).update(expStr).digest('hex');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const isMatch = crypto.timingSafeEqual(sigBuf, expectedBuf);
  if (!isMatch) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true };
}

// ─── Rate Limiting by IP (Stored in KV) ───────────────────────────────────────

export function getClientIp(request: Request): string {
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const firstIp = xForwardedFor.split(',')[0].trim();
    if (firstIp) return firstIp;
  }
  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp && xRealIp.trim() !== '') {
    return xRealIp.trim();
  }
  return '127.0.0.1';
}

function rateLimitKey(ip: string): string {
  return `access:failed:${ip}`;
}

interface FailedAttemptRecord {
  count: number;
  firstFailedAt: number;
}

/**
 * Checks whether an IP address is currently locked out due to exceeding failed attempts.
 */
export async function checkRateLimit(ip: string): Promise<RateLimitStatus> {
  const store = getStore();
  const record = await store.get<FailedAttemptRecord>(rateLimitKey(ip));

  if (!record) {
    return { locked: false, attempts: 0 };
  }

  const elapsed = Date.now() - record.firstFailedAt;
  if (elapsed >= RATE_LIMIT_WINDOW_MS) {
    // Window expired: clear record
    await store.del(rateLimitKey(ip));
    return { locked: false, attempts: 0 };
  }

  if (record.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const remainingSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000);
    return { locked: true, remainingSeconds, attempts: record.count };
  }

  return { locked: false, attempts: record.count };
}

/**
 * Records a failed attempt for an IP address. Locks out if attempts reach threshold.
 */
export async function recordFailedAttempt(ip: string): Promise<RateLimitStatus> {
  const store = getStore();
  const key = rateLimitKey(ip);
  const now = Date.now();
  const record = await store.get<FailedAttemptRecord>(key);

  if (!record || now - record.firstFailedAt >= RATE_LIMIT_WINDOW_MS) {
    const newRecord: FailedAttemptRecord = { count: 1, firstFailedAt: now };
    await store.set(key, newRecord);
    return { locked: false, attempts: 1 };
  }

  const nextCount = record.count + 1;
  const updatedRecord: FailedAttemptRecord = {
    count: nextCount,
    firstFailedAt: record.firstFailedAt,
  };
  await store.set(key, updatedRecord);

  const elapsed = now - record.firstFailedAt;
  const remainingSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000);

  return {
    locked: nextCount >= RATE_LIMIT_MAX_ATTEMPTS,
    remainingSeconds: nextCount >= RATE_LIMIT_MAX_ATTEMPTS ? remainingSeconds : undefined,
    attempts: nextCount,
  };
}

/**
 * Clears the failed attempts record for an IP address upon successful verification.
 */
export async function clearRateLimit(ip: string): Promise<void> {
  const store = getStore();
  await store.del(rateLimitKey(ip));
}

export { sanitizeRedirectPath } from './redirect';


