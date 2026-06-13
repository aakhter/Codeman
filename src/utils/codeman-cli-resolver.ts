/**
 * @fileoverview Resolve which Codeman CLI bin alias is available on PATH (COD-103).
 *
 * Codeman installs under two bin aliases (`aicodeman` and `codeman`; see
 * package.json "bin"). User-facing help text (the Agent Checkpoint hint and the
 * attachment-drawer empty state) must reference the alias the user actually has
 * on PATH, and warn when neither resolves.
 *
 * Mirrors the `codex-cli-resolver.ts` pattern: a `which` lookup first, result
 * cached. `aicodeman` is the canonical/primary alias and is preferred when both
 * resolve. The pure `resolveCodemanCliNameWith(lookup)` core is injection-testable
 * so the warn path is unit-testable without depending on the real machine PATH.
 *
 * @module utils/codeman-cli-resolver
 */

import { execSync } from 'node:child_process';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** The Codeman bin aliases, in preference order (canonical/primary first). */
export const CODEMAN_CLI_ALIASES = ['aicodeman', 'codeman'] as const;

export type CodemanCliName = (typeof CODEMAN_CLI_ALIASES)[number];

/** Cached resolved alias: a name, or '' once searched-and-not-found. */
let _codemanCliName: CodemanCliName | '' | null = null;

/**
 * Pure resolver core: returns the preferred alias for which `lookup` is true.
 * Prefers `aicodeman` over `codeman` when both resolve.
 *
 * @param lookup Predicate that reports whether a bin name is resolvable on PATH.
 * @returns The resolved alias, or null if neither resolves.
 */
export function resolveCodemanCliNameWith(lookup: (bin: string) => boolean): CodemanCliName | null {
  for (const alias of CODEMAN_CLI_ALIASES) {
    if (lookup(alias)) return alias;
  }
  return null;
}

/** Default PATH lookup: `which <bin>` exits 0 when the binary is resolvable. */
function whichLookup(bin: string): boolean {
  try {
    const result = execSync(`which ${bin}`, {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    return result.length > 0;
  } catch {
    // Not on PATH (non-zero exit).
    return false;
  }
}

/**
 * Resolve which Codeman CLI alias is available on the current PATH.
 * Prefers `aicodeman`. Result is cached for subsequent calls.
 *
 * @returns `'aicodeman'` | `'codeman'`, or null if neither is on PATH.
 */
export function resolveCodemanCliName(): CodemanCliName | null {
  if (_codemanCliName !== null) return _codemanCliName || null;
  const resolved = resolveCodemanCliNameWith(whichLookup);
  _codemanCliName = resolved ?? '';
  return resolved;
}

/** Whether any Codeman CLI alias is available on PATH. */
export function isCodemanCliOnPath(): boolean {
  return resolveCodemanCliName() !== null;
}
