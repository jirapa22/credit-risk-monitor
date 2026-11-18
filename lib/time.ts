/**
 * Shared application-wide date & time formatter.
 *
 * All stored timestamps must remain ISO 8601 UTC.
 * Display renders in the client's local timezone (via Intl) and explicitly indicates
 * the timezone name/abbreviation (e.g. "17/11/2026 22:12 (ICT)").
 */
export function formatAppDateTime(
  isoStr: string | number | Date | null | undefined,
  options?: {
    dateStyle?: 'short' | 'medium' | 'full';
    showSeconds?: boolean;
    dateOnly?: boolean;
    timeOnly?: boolean;
  },
): string {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '—';

  let tzAbbr = 'UTC';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    tzAbbr =
      new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
        .formatToParts(d)
        .find(p => p.type === 'timeZoneName')?.value || tz;
  } catch {
    // fallback if Intl not supported
  }

  if (options?.dateOnly) {
    return d.toLocaleDateString('th-TH', {
      day: '2-digit',
      month: options.dateStyle === 'medium' ? 'short' : '2-digit',
      year: 'numeric',
    });
  }

  const datePart = d.toLocaleDateString('th-TH', {
    day: '2-digit',
    month: options?.dateStyle === 'medium' ? 'short' : '2-digit',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString('th-TH', {
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

