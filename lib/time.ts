/**
 * Shared application-wide date & time formatter.
 *
 * All stored timestamps must remain ISO 8601 UTC.
 * Display consistently renders in Asia/Bangkok (GMT+7) and explicitly indicates
 * the timezone name/abbreviation (e.g. "17/11/2569 22:12 (GMT+7)").
 */
export const APP_TIMEZONE = 'Asia/Bangkok';

export function formatAppDateTime(
  isoStr: string | number | Date | null | undefined,
  options?: {
    dateStyle?: 'short' | 'medium' | 'full';
    showSeconds?: boolean;
    dateOnly?: boolean;
    timeOnly?: boolean;
    timeZone?: string;
  },
): string {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '—';

  const tz = options?.timeZone || APP_TIMEZONE;
  let tzAbbr = 'GMT+7';
  try {
    tzAbbr =
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(d)
        .find(p => p.type === 'timeZoneName')?.value || 'GMT+7';
  } catch {
    // fallback if Intl not supported
  }

  if (options?.dateOnly) {
    return d.toLocaleDateString('th-TH', {
      timeZone: tz,
      day: '2-digit',
      month: options.dateStyle === 'medium' ? 'short' : '2-digit',
      year: 'numeric',
    });
  }

  const datePart = d.toLocaleDateString('th-TH', {
    timeZone: tz,
    day: '2-digit',
    month: options?.dateStyle === 'medium' ? 'short' : '2-digit',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString('th-TH', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: options?.showSeconds ? '2-digit' : undefined,
    hour12: false,
  });

  if (options?.timeOnly) {
    return `${timePart} (${tzAbbr})`;
  }

  return `${datePart} ${timePart} (${tzAbbr})`;
}

