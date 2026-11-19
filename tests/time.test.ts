import { describe, expect, it } from 'vitest';
import { formatAppDateTime, APP_TIMEZONE } from '../lib/time';

describe('formatAppDateTime Timezone Consistency (Item 2)', () => {
  it('formats dates consistently in Asia/Bangkok (GMT+7) regardless of machine timezone', () => {
    // 2025-07-15T00:30:00.000Z in UTC is 2025-07-15 07:30:00 in Asia/Bangkok
    const iso = '2025-07-15T00:30:00.000Z';
    const formatted = formatAppDateTime(iso, { showSeconds: true });

    expect(formatted).toContain('07:30:00');
    expect(formatted).toContain('(GMT+7)');
  });

  it('produces identical output when timeZone option is explicitly Asia/Bangkok or default', () => {
    const iso = '2025-11-19T14:20:00.000Z';
    const defaultOutput = formatAppDateTime(iso, { showSeconds: true });
    const explicitOutput = formatAppDateTime(iso, { showSeconds: true, timeZone: 'Asia/Bangkok' });

    expect(defaultOutput).toBe(explicitOutput);
    expect(APP_TIMEZONE).toBe('Asia/Bangkok');
  });

  it('handles null, undefined, and invalid date strings gracefully', () => {
    expect(formatAppDateTime(null)).toBe('—');
    expect(formatAppDateTime(undefined)).toBe('—');
    expect(formatAppDateTime('invalid-date')).toBe('—');
  });
});

