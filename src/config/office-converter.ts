/**
 * @fileoverview PURE policy for the LibreOffice-based office converter (COD-426).
 *
 * Two independent surfaces used to disagree about "which LibreOffice": the
 * converters spawned the bare name `soffice` (PATH-resolved), while
 * `codeman doctor` probed `['libreoffice', 'soffice']` — libreoffice FIRST — so
 * on a host with both, doctor reported one binary green while previews ran a
 * different, broken one. This module is the ONE ordered candidate list, the ONE
 * env override, and the ONE place the actionable failure wording lives.
 *
 * Everything here is pure (no IO, no spawns): the runtime half lives in
 * `src/office-converter-runtime.ts`.
 *
 * @module config/office-converter
 */

/** Ordered candidate binaries, most specific first. Single-sourced into the doctor registry. */
export const OFFICE_CONVERTER_BINS = ['libreoffice', 'soffice'] as const;

/** Env var naming an explicit converter binary (absolute path, or a name on PATH). */
export const OFFICE_CONVERTER_BIN_ENV = 'CODEMAN_SOFFICE_BIN';

/** Env var overriding the capability-probe timeout, in milliseconds. */
export const OFFICE_PROBE_TIMEOUT_ENV = 'CODEMAN_OFFICE_PROBE_TIMEOUT_MS';

/**
 * Probe budget. Deliberately far below the 5-minute conversion timeout: the
 * whole point of the probe is that an unusable converter fails FAST instead of
 * presenting as a multi-minute hang on the preview endpoint.
 */
export const OFFICE_PROBE_TIMEOUT_DEFAULT_MS = 20_000;
export const OFFICE_PROBE_TIMEOUT_MIN_MS = 1_000;
export const OFFICE_PROBE_TIMEOUT_MAX_MS = 120_000;

/** How long a "usable" verdict is trusted before re-probing. */
export const OFFICE_PROBE_SUCCESS_TTL_MS = 30 * 60_000;
/** Shorter, so repairing the host is picked up without restarting the server. */
export const OFFICE_PROBE_FAILURE_TTL_MS = 5 * 60_000;

/**
 * Candidate binaries to try, in order. A non-empty (trimmed) override wins
 * outright — if the user names a binary, silently falling back to another one
 * would re-create exactly the doctor/converter divergence this module removes.
 */
export function officeConverterCandidates(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  const override = env[OFFICE_CONVERTER_BIN_ENV]?.trim();
  if (override) return [override];
  return [...OFFICE_CONVERTER_BINS];
}

/** Parse + clamp the probe timeout (same idiom as MAX_PREVIEW_CACHE_FILES). */
export function officeProbeTimeoutMs(env: NodeJS.ProcessEnv | Record<string, string | undefined>): number {
  const text = env[OFFICE_PROBE_TIMEOUT_ENV]?.trim();
  if (!text) return OFFICE_PROBE_TIMEOUT_DEFAULT_MS;
  const raw = Number(text);
  if (!Number.isFinite(raw)) return OFFICE_PROBE_TIMEOUT_DEFAULT_MS;
  const floored = Math.floor(raw);
  if (floored < OFFICE_PROBE_TIMEOUT_MIN_MS) return OFFICE_PROBE_TIMEOUT_MIN_MS;
  if (floored > OFFICE_PROBE_TIMEOUT_MAX_MS) return OFFICE_PROBE_TIMEOUT_MAX_MS;
  return floored;
}

/**
 * Remedy wording. `codeman doctor` renders these same reasons in its own
 * output, where telling the reader to run `codeman doctor` is circular — so the
 * doctor hint is opt-out via `suggestDoctor`.
 */
function remedy(suggestDoctor: boolean): string {
  const point = `point ${OFFICE_CONVERTER_BIN_ENV} at a working LibreOffice binary`;
  return suggestDoctor ? `Run \`codeman doctor\` to check it, or ${point}.` : `Reinstall LibreOffice, or ${point}.`;
}

/**
 * The structured failure. Kept separate from its rendered text because the same
 * probe feeds two audiences with different remedies (the preview surface and
 * `codeman doctor`), and two pre-rendered strings would be two things to keep
 * in sync.
 */
export type OfficeConverterFailure =
  | { kind: 'missing'; candidates: readonly string[] }
  | { kind: 'unusable'; bin: string; detail?: string };

/** Render a failure for one audience. The ONE place this wording lives. */
export function officeConverterReason(failure: OfficeConverterFailure, suggestDoctor = true): string {
  return failure.kind === 'missing'
    ? officeConverterMissingReason(failure.candidates, suggestDoctor)
    : officeConverterUnusableReason(failure.bin, failure.detail, suggestDoctor);
}

/** Actionable message for "no converter binary resolved at all". */
export function officeConverterMissingReason(candidates: readonly string[], suggestDoctor = true): string {
  return `No LibreOffice converter found (tried: ${candidates.join(', ')}). Install LibreOffice. ${remedy(suggestDoctor)}`;
}

/**
 * Actionable message for "the binary is there but cannot convert". LibreOffice
 * exits 0 even when it fails, so this verdict comes from "no PDF was produced",
 * never from an exit code.
 */
export function officeConverterUnusableReason(bin: string, detail?: string, suggestDoctor = true): string {
  const because = detail?.trim() ? ` (${detail.trim()})` : '';
  return `LibreOffice at ${bin} could not convert a test document${because}. ${remedy(suggestDoctor)}`;
}
