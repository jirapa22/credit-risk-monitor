/**
 * Step 10b.3 — Guard test against hard-coded feature names, column names, and score keys.
 *
 * Scans every `.ts` file in `lib/` and `app/api/`.
 * Forbidden tokens:
 *   monthly_income, loan_amount, dti_ratio, default_flag, customer_id, application_date, aScore
 *
 * Allowed ONLY in:
 *   - `lib/defaults.ts`
 *   - Comment lines (trimmed line starts with `//`, `*`, or `/*`)
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN_DIRS = ['lib', join('app', 'api')];
const ALLOWED_FILES = new Set(['lib/defaults.ts']);
const FORBIDDEN_TOKENS = [
  'monthly_income',
  'loan_amount',
  'dti_ratio',
  'default_flag',
  'customer_id',
  'application_date',
  'aScore',
] as const;

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

describe('Step 10b.3 — No hard-coded feature/column names in lib/ and app/api/', () => {
  it('contains zero forbidden tokens outside lib/defaults.ts and comments', () => {
    const files = SCAN_DIRS.flatMap(d => collectTsFiles(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const absPath of files) {
      const relPath = relative(ROOT, absPath).replace(/\\/g, '/');
      if (ALLOWED_FILES.has(relPath)) continue;

      const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed || isCommentLine(trimmed)) return;

        // Strip trailing `// ...` comment only if it is not inside quotes, or check code portion before `//`
        for (const token of FORBIDDEN_TOKENS) {
          const re = new RegExp(`\\b${token}\\b`);
          if (re.test(line)) {
            violations.push(`${relPath}:${idx + 1} [${token}] -> ${trimmed}`);
          }
        }
      });
    }

    if (violations.length > 0) {
      console.error('Hard-code violations found:\n' + violations.join('\n'));
    }
    expect(violations).toEqual([]);
  });

  it('confirms unused legacy app/utils/dataGenerator.ts has been removed', () => {
    expect(existsSync(join(ROOT, 'app', 'utils', 'dataGenerator.ts'))).toBe(false);
  });
});

