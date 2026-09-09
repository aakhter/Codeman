/**
 * @fileoverview COD-426: `codeman doctor` must not report a LibreOffice that
 * cannot convert anything as green. The refinement is a PURE helper (the sync
 * probe engine must never spawn a conversion), applied by the async `doctor`
 * command after `checkAll`.
 */
import { describe, it, expect } from 'vitest';
import type { ToolResult } from '../src/utils/dependency-checker.js';
import { applyOfficeConverterProbe, renderTable, renderJson } from '../src/utils/dependency-report.js';

function libreoffice(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    id: 'libreoffice',
    label: 'LibreOffice',
    category: 'office',
    required: false,
    usedBy: ['document preview'],
    status: 'ok',
    version: '7.6.7',
    path: '/usr/bin/libreoffice',
    ...overrides,
  };
}

const other: ToolResult = {
  id: 'tmux',
  label: 'tmux',
  category: 'core',
  required: true,
  usedBy: [],
  status: 'ok',
  version: '3.4',
  path: '/usr/bin/tmux',
};

describe('applyOfficeConverterProbe', () => {
  it('downgrades a green LibreOffice to error, carrying the probe reason', () => {
    const out = applyOfficeConverterProbe([other, libreoffice()], {
      usable: false,
      bin: '/usr/bin/libreoffice',
      reason: 'LibreOffice at /usr/bin/libreoffice could not convert a test document.',
    });
    const lo = out.find((r) => r.id === 'libreoffice')!;
    expect(lo.status).toBe('error');
    expect(lo.reason).toContain('could not convert');
    expect(out.find((r) => r.id === 'tmux')).toEqual(other);
  });

  it('reports the binary the probe actually resolved, not the one which() found first', () => {
    const out = applyOfficeConverterProbe([libreoffice()], {
      usable: false,
      bin: '/usr/local/bin/soffice',
      reason: 'nope',
    });
    expect(out[0]!.path).toBe('/usr/local/bin/soffice');
  });

  it('leaves results untouched when the converter is usable', () => {
    const input = [other, libreoffice()];
    expect(applyOfficeConverterProbe(input, { usable: true, bin: '/usr/bin/libreoffice' })).toEqual(input);
  });

  it('leaves results untouched when no probe was run', () => {
    const input = [other, libreoffice()];
    expect(applyOfficeConverterProbe(input, null)).toEqual(input);
  });

  it('does not resurrect a missing/skipped LibreOffice as an error row', () => {
    for (const status of ['missing', 'skipped'] as const) {
      const out = applyOfficeConverterProbe([libreoffice({ status, path: undefined, version: undefined })], {
        usable: false,
        bin: null,
        reason: 'nothing found',
      });
      expect(out[0]!.status).toBe(status);
    }
  });

  it('is a no-op when the registry filter excluded LibreOffice (--category core)', () => {
    expect(applyOfficeConverterProbe([other], { usable: false, bin: null, reason: 'x' })).toEqual([other]);
  });

  it('does not mutate the input array or its entries', () => {
    const input = [libreoffice()];
    applyOfficeConverterProbe(input, { usable: false, bin: '/usr/bin/libreoffice', reason: 'x' });
    expect(input[0]!.status).toBe('ok');
  });
});

describe('the downgrade is visible in both output modes', () => {
  const downgraded = applyOfficeConverterProbe([other, libreoffice()], {
    usable: false,
    bin: '/usr/bin/libreoffice',
    reason: 'LibreOffice at /usr/bin/libreoffice could not convert a test document.',
  });

  it('shows the reason in the table instead of a bare version', () => {
    const table = renderTable(downgraded, 'linux');
    expect(table).toContain('could not convert');
    expect(table).not.toContain('7.6.7');
  });

  it('carries status + reason through --json', () => {
    const json = renderJson(downgraded, 'linux');
    const lo = json.tools.find((t) => t.id === 'libreoffice')!;
    expect(lo.status).toBe('error');
    expect(lo.reason).toContain('could not convert');
    expect(json.summary.ok).toBe(1);
    // LibreOffice is optional, so a broken converter must not fail the exit code.
    expect(json.summary.exitCode).toBe(0);
  });
});
