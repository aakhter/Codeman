/**
 * @fileoverview IO half of the office-converter capability gate (COD-426).
 *
 * Resolves the ONE LibreOffice binary the converters and `codeman doctor` both
 * mean (see `config/office-converter.ts`), and answers the only question that
 * matters before spawning a 5-minute conversion: can this binary actually
 * convert anything?
 *
 * ⚠ LibreOffice EXITS 0 WHEN IT FAILS (it prints `Error: source file could not
 * be loaded` and produces nothing), so `usable` is decided purely by "a .pdf
 * appeared in the outdir" — never by an exit code.
 *
 * ⚠ The probe takes its own `runWithConversionLimit` slot, so probes cannot
 * bypass the converter resource guard. The limiter is NOT re-entrant, so every
 * caller must consult the probe strictly BEFORE taking its own slot; probing
 * from inside a held slot would deadlock.
 *
 * The verdict is cached (long on success, shorter on failure so a repaired host
 * is picked up without a restart) and in-flight-shared, so N concurrent
 * previews cost ONE probe.
 *
 * @module office-converter-runtime
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { OfficeConverterFailure } from './config/office-converter.js';
import {
  OFFICE_PROBE_FAILURE_TTL_MS,
  OFFICE_PROBE_SUCCESS_TTL_MS,
  officeConverterCandidates,
  officeConverterReason,
  officeProbeTimeoutMs,
} from './config/office-converter.js';
import { runWithConversionLimit } from './document-conversion-limiter.js';

const execFileAsync = promisify(execFile);

const WHICH_TIMEOUT_MS = 5_000;
const PROBE_WORK_DIR = join(tmpdir(), 'codeman-office-probe');
const PROBE_FIXTURE_NAME = 'codeman-office-probe.txt';
const PROBE_FIXTURE_BODY = 'Codeman office converter probe.\n';

/** Verdict for "can we convert documents with LibreOffice right now?". */
export type OfficeConverterVerdict =
  | { usable: true; bin: string }
  | { usable: false; bin: string | null; reason: string; failure: OfficeConverterFailure };

/** Injected boundary — everything that spawns or reads the environment. */
export interface OfficeConverterProbeIo {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now(): number;
  /** Resolve a bare binary name on PATH to an absolute path, mirroring dependency-checker's safeWhich. */
  which(bin: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  /** Run the converter. May reject; a rejection is a failure DETAIL, not the verdict. */
  run(bin: string, args: readonly string[], timeoutMs: number): Promise<void>;
  withLimit<T>(task: () => Promise<T>): Promise<T>;
}

async function whichAsync(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf-8',
      timeout: WHICH_TIMEOUT_MS,
    });
    const first = stdout.split(/\r?\n/)[0]?.trim();
    if (!first) return null;
    return (await fileExistsAsync(first)) ? first : null;
  } catch {
    return null;
  }
}

async function fileExistsAsync(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

const realIo: OfficeConverterProbeIo = {
  env: process.env,
  now: () => Date.now(),
  which: whichAsync,
  fileExists: fileExistsAsync,
  async run(bin, args, timeoutMs) {
    await execFileAsync(bin, [...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  },
  withLimit: runWithConversionLimit,
};

/**
 * First working candidate, as an absolute path. An absolute
 * CODEMAN_SOFFICE_BIN that exists is used verbatim, and an override that does
 * NOT exist resolves to null rather than silently falling back — a silent
 * fallback is exactly the divergence this gate exists to remove.
 */
export async function resolveOfficeConverterBin(io: OfficeConverterProbeIo = realIo): Promise<string | null> {
  for (const candidate of officeConverterCandidates(io.env)) {
    if (isAbsolute(candidate)) {
      if (await io.fileExists(candidate)) return candidate;
      continue;
    }
    const resolved = await io.which(candidate);
    if (resolved) return resolved;
  }
  return null;
}

interface CachedVerdict {
  verdict: OfficeConverterVerdict;
  expiresAt: number;
}

let cached: CachedVerdict | null = null;
let inFlight: Promise<OfficeConverterVerdict> | null = null;

/** Test/diagnostic hook: forget the cached verdict. */
export function resetOfficeConverterProbeCache(): void {
  cached = null;
  inFlight = null;
}

/** The last cached verdict, if it is still fresh. Never spawns. */
export function getCachedOfficeConverterVerdict(io: OfficeConverterProbeIo = realIo): OfficeConverterVerdict | null {
  if (cached && cached.expiresAt > io.now()) return cached.verdict;
  return null;
}

async function runProbe(io: OfficeConverterProbeIo): Promise<OfficeConverterVerdict> {
  const bin = await resolveOfficeConverterBin(io);
  if (!bin) {
    const failure: OfficeConverterFailure = { kind: 'missing', candidates: officeConverterCandidates(io.env) };
    return { usable: false, bin: null, reason: officeConverterReason(failure), failure };
  }

  let workDir: string | undefined;
  try {
    await fs.mkdir(PROBE_WORK_DIR, { recursive: true });
    workDir = await fs.mkdtemp(join(PROBE_WORK_DIR, 'probe-'));
    const profileDir = join(workDir, 'profile');
    await fs.mkdir(profileDir, { recursive: true });
    const fixturePath = join(workDir, PROBE_FIXTURE_NAME);
    await fs.writeFile(fixturePath, PROBE_FIXTURE_BODY, 'utf-8');

    let detail: string | undefined;
    // The probe takes its OWN limiter slot; it is never called from inside one.
    await io.withLimit(async () => {
      try {
        await io.run(
          bin,
          [
            '--headless',
            '--nologo',
            '--nofirststartwizard',
            `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
            '--convert-to',
            'pdf',
            '--outdir',
            workDir as string,
            fixturePath,
          ],
          officeProbeTimeoutMs(io.env)
        );
      } catch (err) {
        // Exit code is not the verdict — record it as detail and let the
        // "did a PDF appear?" check below decide.
        detail = err instanceof Error ? err.message : String(err);
      }
    });

    const produced = (await fs.readdir(workDir)).some((name) => name.toLowerCase().endsWith('.pdf'));
    if (produced) return { usable: true, bin };
    const failure: OfficeConverterFailure = { kind: 'unusable', bin, detail };
    return { usable: false, bin, reason: officeConverterReason(failure), failure };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const failure: OfficeConverterFailure = bin
      ? { kind: 'unusable', bin, detail }
      : { kind: 'missing', candidates: officeConverterCandidates(io.env) };
    return { usable: false, bin, reason: officeConverterReason(failure), failure };
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Cached, in-flight-shared capability check. Call this BEFORE taking a
 * conversion-limiter slot (see the deadlock note in the file header).
 */
export function probeOfficeConverter(io: OfficeConverterProbeIo = realIo): Promise<OfficeConverterVerdict> {
  const fresh = getCachedOfficeConverterVerdict(io);
  if (fresh) return Promise.resolve(fresh);
  if (inFlight) return inFlight;

  const pending = runProbe(io)
    .then((verdict) => {
      cached = {
        verdict,
        expiresAt: io.now() + (verdict.usable ? OFFICE_PROBE_SUCCESS_TTL_MS : OFFICE_PROBE_FAILURE_TTL_MS),
      };
      return verdict;
    })
    .finally(() => {
      if (inFlight === pending) inFlight = null;
    });
  inFlight = pending;
  return pending;
}
