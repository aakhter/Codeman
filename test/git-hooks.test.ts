/**
 * @fileoverview COD-293 (Q11 option L1): the tiered pre-push gate that postinstall installs.
 *
 * Two properties matter more than the hook's contents, because the existing pre-commit
 * installer gets both wrong and this one must not copy it:
 *   1. It is MARKER-OWNED — a hook the user wrote by hand is never overwritten.
 *   2. The hooks directory is resolved via `git rev-parse --git-path hooks`, since in a
 *      worktree `.git` is a FILE and `../.git/hooks` does not exist. CLAUDE.local.md makes
 *      worktree-per-issue the standard workflow, so this is the common case, not an edge one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRE_PUSH_MARKER, renderPrePushHook, planHookInstall } from '../scripts/git-hooks.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

describe('pre-push hook body', () => {
  const hook = renderPrePushHook();

  it('carries the ownership marker', () => {
    expect(hook).toContain(PRE_PUSH_MARKER);
  });

  it('runs the full static tier and nothing slow', () => {
    for (const check of [
      'check:lockfile',
      'typecheck',
      'lint',
      'check:frontend-syntax',
      'check:public-assets',
      'check:browser-excludes',
      'format:check',
    ]) {
      expect(hook).toContain(`run_check ${check}`);
    }
    // …and run_check is what actually shells out, so the list above is not decorative.
    expect(hook).toContain('npm run --silent "$1"');
    // The whole point of the tier: the ~7 minute suites stay out of a per-push hook.
    expect(hook).not.toContain('test:ci');
    expect(hook).not.toContain('test:browser');
  });

  it('has an escape hatch that does not require --no-verify', () => {
    expect(hook).toContain('CODEMAN_SKIP_PREPUSH');
  });

  it('skips a delete-only push instead of gating it', () => {
    // git feeds pre-push "<localref> <localsha> <remoteref> <remotesha>"; a deletion sends
    // an all-zero local sha and has no tree to check.
    expect(hook).toMatch(/0{40}/);
  });

  it('degrades instead of failing the push when dependencies are absent', () => {
    expect(hook).toContain('node_modules');
  });
});

describe('planHookInstall', () => {
  const hook = renderPrePushHook();

  it('writes when no hook exists', () => {
    expect(planHookInstall({ existing: null, next: hook })).toBe('write');
  });

  it('refuses to clobber a hook it does not own', () => {
    expect(planHookInstall({ existing: '#!/bin/sh\nmake lint\n', next: hook })).toBe('skip-foreign');
  });

  it('refreshes its own hook when the body changed', () => {
    const stale = `#!/bin/sh\n${PRE_PUSH_MARKER}\necho old\n`;
    expect(planHookInstall({ existing: stale, next: hook })).toBe('write');
  });

  it('is idempotent when already current', () => {
    expect(planHookInstall({ existing: hook, next: hook })).toBe('up-to-date');
  });

  it('treats an empty file as absent rather than foreign', () => {
    expect(planHookInstall({ existing: '   \n', next: hook })).toBe('write');
  });
});

describe('postinstall wiring', () => {
  const postinstall = read('scripts/postinstall.js');

  it('installs the pre-push hook from the shared module', () => {
    expect(postinstall).toContain('git-hooks.mjs');
    expect(postinstall).toContain('planHookInstall');
  });

  it('resolves the hooks dir through git, so worktrees work', () => {
    expect(postinstall).toContain('rev-parse --git-path hooks');
  });
});
