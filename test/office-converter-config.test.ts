/**
 * @fileoverview Unit tests for the PURE office-converter policy module: which
 * binaries are candidates (and how CODEMAN_SOFFICE_BIN overrides them), how the
 * probe timeout is parsed/clamped, and the actionable failure messages.
 */
import { describe, it, expect } from 'vitest';
import {
  OFFICE_CONVERTER_BINS,
  OFFICE_CONVERTER_BIN_ENV,
  OFFICE_PROBE_TIMEOUT_ENV,
  OFFICE_PROBE_TIMEOUT_DEFAULT_MS,
  OFFICE_PROBE_TIMEOUT_MIN_MS,
  OFFICE_PROBE_TIMEOUT_MAX_MS,
  OFFICE_PROBE_SUCCESS_TTL_MS,
  OFFICE_PROBE_FAILURE_TTL_MS,
  officeConverterCandidates,
  officeProbeTimeoutMs,
  officeConverterMissingReason,
  officeConverterUnusableReason,
  officeConverterReason,
} from '../src/config/office-converter.js';

describe('officeConverterCandidates', () => {
  it('defaults to the ordered shared candidate list', () => {
    expect(officeConverterCandidates({})).toEqual([...OFFICE_CONVERTER_BINS]);
    expect(OFFICE_CONVERTER_BINS).toEqual(['libreoffice', 'soffice']);
  });

  it('lets a non-empty override win outright', () => {
    expect(officeConverterCandidates({ [OFFICE_CONVERTER_BIN_ENV]: '/opt/lo/soffice' })).toEqual(['/opt/lo/soffice']);
  });

  it('trims the override and ignores blank ones', () => {
    expect(officeConverterCandidates({ [OFFICE_CONVERTER_BIN_ENV]: '  /opt/lo/soffice  ' })).toEqual([
      '/opt/lo/soffice',
    ]);
    expect(officeConverterCandidates({ [OFFICE_CONVERTER_BIN_ENV]: '   ' })).toEqual([...OFFICE_CONVERTER_BINS]);
    expect(officeConverterCandidates({ [OFFICE_CONVERTER_BIN_ENV]: undefined })).toEqual([...OFFICE_CONVERTER_BINS]);
  });

  it('returns a fresh array so callers cannot mutate the shared list', () => {
    const first = officeConverterCandidates({});
    first.push('nope');
    expect(officeConverterCandidates({})).toEqual([...OFFICE_CONVERTER_BINS]);
  });
});

describe('officeProbeTimeoutMs', () => {
  it('defaults when unset or unparseable', () => {
    expect(officeProbeTimeoutMs({})).toBe(OFFICE_PROBE_TIMEOUT_DEFAULT_MS);
    expect(OFFICE_PROBE_TIMEOUT_DEFAULT_MS).toBe(20_000);
    expect(officeProbeTimeoutMs({ [OFFICE_PROBE_TIMEOUT_ENV]: 'soon' })).toBe(OFFICE_PROBE_TIMEOUT_DEFAULT_MS);
    expect(officeProbeTimeoutMs({ [OFFICE_PROBE_TIMEOUT_ENV]: '' })).toBe(OFFICE_PROBE_TIMEOUT_DEFAULT_MS);
  });

  it('honours a sane override', () => {
    expect(officeProbeTimeoutMs({ [OFFICE_PROBE_TIMEOUT_ENV]: '5000' })).toBe(5000);
    expect(officeProbeTimeoutMs({ [OFFICE_PROBE_TIMEOUT_ENV]: '5000.9' })).toBe(5000);
  });

  it('clamps to the floor and ceiling', () => {
    expect(officeProbeTimeoutMs({ [OFFICE_PROBE_TIMEOUT_ENV]: '1' })).toBe(OFFICE_PROBE_TIMEOUT_MIN_MS);
    expect(officeProbeTimeoutMs({ [OFFICE_PROBE_TIMEOUT_ENV]: '-9' })).toBe(OFFICE_PROBE_TIMEOUT_MIN_MS);
    expect(officeProbeTimeoutMs({ [OFFICE_PROBE_TIMEOUT_ENV]: String(10 ** 9) })).toBe(OFFICE_PROBE_TIMEOUT_MAX_MS);
  });

  it('keeps the probe timeout far below the 5-minute conversion timeout', () => {
    expect(OFFICE_PROBE_TIMEOUT_MAX_MS).toBeLessThan(5 * 60_000);
  });
});

describe('verdict TTLs', () => {
  it('caches a failure for a shorter time than a success so a repaired host recovers', () => {
    expect(OFFICE_PROBE_FAILURE_TTL_MS).toBeLessThan(OFFICE_PROBE_SUCCESS_TTL_MS);
    expect(OFFICE_PROBE_SUCCESS_TTL_MS).toBe(30 * 60_000);
    expect(OFFICE_PROBE_FAILURE_TTL_MS).toBe(5 * 60_000);
  });
});

describe('failure messages', () => {
  it('names the candidates tried and the env override when nothing resolves', () => {
    const msg = officeConverterMissingReason(['libreoffice', 'soffice']);
    expect(msg).toContain('libreoffice');
    expect(msg).toContain('soffice');
    expect(msg).toContain(OFFICE_CONVERTER_BIN_ENV);
    expect(msg).toContain('codeman doctor');
  });

  it('names the binary that failed and includes the detail', () => {
    const msg = officeConverterUnusableReason('/usr/local/bin/soffice', 'source file could not be loaded');
    expect(msg).toContain('/usr/local/bin/soffice');
    expect(msg).toContain('source file could not be loaded');
    expect(msg).toContain(OFFICE_CONVERTER_BIN_ENV);
    expect(msg).toContain('codeman doctor');
  });

  it('reads fine with no detail', () => {
    const msg = officeConverterUnusableReason('/usr/bin/libreoffice');
    expect(msg).toContain('/usr/bin/libreoffice');
    expect(msg).not.toContain('undefined');
  });
});

describe('single-sourcing into the doctor registry', () => {
  it('the libreoffice entry probes exactly the shared candidate list, in order', async () => {
    const { dependencyRegistry } = await import('../src/config/dependency-registry.js');
    const entry = dependencyRegistry().find((t) => t.id === 'libreoffice');
    expect(entry).toBeDefined();
    const resolver = entry!.resolvers[0]!.resolver;
    expect(resolver.kind).toBe('path');
    if (resolver.kind !== 'path') throw new Error('unreachable');
    expect(resolver.bins).toEqual([...OFFICE_CONVERTER_BINS]);
    // Same array object identity is NOT required, but the values must be single-sourced:
    // a hand-maintained copy here is exactly the drift COD-426 removes.
    expect(resolver.bins).not.toBe(OFFICE_CONVERTER_BINS);
  });
});

describe('remedy wording is rendered per audience (COD-426)', () => {
  const failure = { kind: 'unusable' as const, bin: '/usr/bin/libreoffice' };

  it('suggests `codeman doctor` to a runtime/preview reader', () => {
    expect(officeConverterReason(failure)).toContain('codeman doctor');
  });

  it('never tells a `codeman doctor` reader to run `codeman doctor`', () => {
    const msg = officeConverterReason(failure, false);
    expect(msg).not.toContain('codeman doctor');
    // …but it must still be actionable.
    expect(msg).toContain('CODEMAN_SOFFICE_BIN');
    expect(msg).toContain('Reinstall LibreOffice');
  });

  it('applies the same rule to the missing-binary failure', () => {
    const missing = { kind: 'missing' as const, candidates: ['libreoffice', 'soffice'] };
    expect(officeConverterReason(missing)).toContain('codeman doctor');
    expect(officeConverterReason(missing, false)).not.toContain('codeman doctor');
  });
});
