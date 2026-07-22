/**
 * @fileoverview Resolve the Agy CLI binary across common install paths.
 *
 * Mirrors gemini-cli-resolver.ts. Finds the `agy` binary and provides
 * an augmented PATH directory for tmux sessions.
 *
 * @module utils/agy-cli-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Common directories where the Agy CLI binary may be installed */
const AGY_SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/usr/local/bin',
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), 'bin'),
];

/** Cached directory containing the agy binary (empty string = searched but not found) */
let _agyDir: string | null = null;

/**
 * Finds the directory containing the `agy` binary.
 * Checks `which agy` first, then falls back to common install locations.
 *
 * @returns Directory path, or null if not found
 */
export function resolveAgyDir(): string | null {
  if (_agyDir !== null) return _agyDir || null;

  try {
    const result = execSync('which agy', {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (result && existsSync(result)) {
      _agyDir = dirname(result);
      return _agyDir;
    }
  } catch {
    // Agy not in PATH, will check common locations
  }

  for (const dir of AGY_SEARCH_DIRS) {
    if (existsSync(join(dir, 'agy'))) {
      _agyDir = dir;
      return _agyDir;
    }
  }

  _agyDir = '';
  return null;
}

/**
 * Check if Agy CLI is available on the system.
 */
export function isAgyAvailable(): boolean {
  return resolveAgyDir() !== null;
}
