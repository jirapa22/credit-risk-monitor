/**
 * Validates and sanitizes a redirect destination path ('from' parameter).
 * Strictly allows only internal relative paths starting with a single '/'.
 * Rejects:
 * - Empty/null/undefined
 * - External URLs (http://, https://, protocol-relative //)
 * - Backslashes (e.g. /\, \\)
 * - Control characters (\x00-\x1F, \x7F)
 * Fallback to '/dashboard'.
 */
export function sanitizeRedirectPath(from: string | null | undefined): string {
  if (!from || typeof from !== 'string') {
    return '/dashboard';
  }

  const trimmed = from.trim();
  if (!trimmed) {
    return '/dashboard';
  }

  // Must start with exactly one '/' and not '//' or '/\'
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return '/dashboard';
  }

  // Strictly reject any backslash anywhere in the path
  if (trimmed.includes('\\')) {
    return '/dashboard';
  }

  // Reject control characters (0x00 - 0x1F and 0x7F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return '/dashboard';
  }

  // Reject http(s):// schemes or any URI scheme (e.g. javascript:, data:)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return '/dashboard';
  }

  return trimmed;
}
