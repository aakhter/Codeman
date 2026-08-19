import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { loginShellArgs, resolveLocalShell } from './shell-resolver.js';

export type CliResolutionSource = 'process-path' | 'common-directory' | 'login-shell';

export interface CliResolutionDiagnostics {
  binary: string;
  processPath: string;
  shellPath: string;
  shellArgs: string[];
  searchDirs: string[];
}

export interface CliResolverHost {
  processPath: string;
  shellPath: string;
  shellArgs: string[];
  findOnProcessPath(binary: string): string | null;
  findInLoginShell(binary: string): string | null;
  exists(path: string): boolean;
}

export interface CandidateValidation<T> {
  accepted: boolean;
  metadata?: T;
}

export interface CliResolution<T = undefined> {
  binaryPath: string;
  directory: string;
  source: CliResolutionSource;
  metadata?: T;
}

export interface CliExecutableResolver<T = undefined> {
  resolve(): CliResolution<T> | null;
  diagnostics(): CliResolutionDiagnostics;
}

function lastAbsoluteLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isAbsolute(lines[index])) return lines[index];
  }
  return null;
}

export function createProductionCliResolverHost(): CliResolverHost {
  const shellPath = resolveLocalShell();
  const shellArgs = loginShellArgs(shellPath).trim().split(/\s+/).filter(Boolean);
  const run = (file: string, args: string[]): string => {
    try {
      return execFileSync(file, args, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  };

  return {
    processPath: process.env.PATH ?? '',
    shellPath,
    shellArgs,
    findOnProcessPath: (binary) => lastAbsoluteLine(run('which', [binary])),
    findInLoginShell: (binary) => {
      if (process.env.VITEST) return null;
      return lastAbsoluteLine(run(shellPath, [...shellArgs, '-c', `command -v -- ${binary}`]));
    },
    exists: existsSync,
  };
}

export function createCliExecutableResolver<T = undefined>(
  options: {
    binary: string;
    searchDirs: string[];
    validateCandidate?: (path: string) => CandidateValidation<T>;
  },
  host: CliResolverHost = createProductionCliResolverHost()
): CliExecutableResolver<T> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.binary)) {
    throw new Error(`Unsafe CLI binary name: ${options.binary}`);
  }

  let cached: CliResolution<T> | null = null;
  const accept = (path: string | null, source: CliResolutionSource): CliResolution<T> | null => {
    if (!path || !isAbsolute(path) || !host.exists(path)) return null;
    const validation = options.validateCandidate?.(path) ?? ({ accepted: true } as CandidateValidation<T>);
    if (!validation.accepted) return null;
    return {
      binaryPath: path,
      directory: dirname(path),
      source,
      metadata: validation.metadata,
    };
  };

  return {
    resolve() {
      if (cached) return cached;

      cached = accept(host.findOnProcessPath(options.binary), 'process-path');
      if (cached) return cached;

      for (const dir of options.searchDirs) {
        cached = accept(join(dir, options.binary), 'common-directory');
        if (cached) return cached;
      }

      cached = accept(host.findInLoginShell(options.binary), 'login-shell');
      return cached;
    },
    diagnostics: () => ({
      binary: options.binary,
      processPath: host.processPath,
      shellPath: host.shellPath,
      shellArgs: [...host.shellArgs],
      searchDirs: [...options.searchDirs],
    }),
  };
}

export function formatCliNotFoundMessage(base: string, diagnostics: CliResolutionDiagnostics): string {
  const shell = [diagnostics.shellPath, ...diagnostics.shellArgs].filter(Boolean).join(' ') || '(none)';
  const dirs = diagnostics.searchDirs.length > 0 ? diagnostics.searchDirs.join(', ') : '(none)';
  return `${base}\nServer PATH: ${diagnostics.processPath || '(empty)'}\nLogin shell: ${shell}\nChecked directories: ${dirs}`;
}
