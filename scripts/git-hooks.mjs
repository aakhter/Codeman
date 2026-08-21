/**
 * @fileoverview Git hook bodies + install policy, shared by scripts/postinstall.js and
 * pinned by test/git-hooks.test.ts. COD-293 (Q11, option L1).
 *
 * Why a pre-push hook at all: nothing gates the `local` branch. GitHub Actions only fires
 * for the GitHub remotes and only on master/main, and the Bitbucket pipeline is inert. So
 * downstream commits land with no automated check, which is how 11 broken jsdom files and
 * two un-excluded browser tests reached the branch.
 *
 * Why pre-PUSH and not pre-commit: a commit is cheap and local, a push is what other
 * machines pick up. And why the STATIC tier only — the full suite is ~7 minutes, which
 * nobody tolerates per push, so it would be bypassed within a day. The seven checks below
 * measured ~11s total, which is affordable enough to survive.
 *
 * ⚠️ This installer is deliberately MARKER-OWNED, unlike the older pre-commit installer in
 * postinstall.js which overwrites whatever it finds. A developer's own pre-push hook must
 * survive `npm install`.
 */

/** Ownership marker. Bump the version suffix when the body changes meaningfully. */
export const PRE_PUSH_MARKER = '# codeman-managed-hook: pre-push v1';

/** Checks that make up the fast tier, in cheapest-first order so failures surface sooner. */
export const PRE_PUSH_CHECKS = [
  'check:lockfile',
  'check:browser-excludes',
  'check:frontend-syntax',
  'check:public-assets',
  'format:check',
  'lint',
  'typecheck',
];

/**
 * Render the pre-push hook script.
 *
 * POSIX sh, not bash: this ships to whatever shell the contributor's git uses.
 */
export function renderPrePushHook() {
  const runs = PRE_PUSH_CHECKS.map(
    (check) => `run_check ${check}`
  ).join('\n');

  return `#!/bin/sh
${PRE_PUSH_MARKER}
# Installed by scripts/postinstall.js. Edit scripts/git-hooks.mjs, not this file —
# it is regenerated on npm install. Delete the marker line above to take ownership
# and this installer will leave your version alone.
#
# Skip once:  CODEMAN_SKIP_PREPUSH=1 git push
# Skip always: remove this file.

[ "$CODEMAN_SKIP_PREPUSH" = "1" ] && exit 0

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo_root" || exit 0

# Nothing to check without dependencies (fresh clone, or a worktree that never ran
# npm install). Warn rather than blocking the push on a setup detail.
if [ ! -d node_modules ]; then
  echo "pre-push: node_modules missing, skipping checks (run 'npm install' to enable them)."
  exit 0
fi

# git feeds us "<localref> <localsha> <remoteref> <remotesha>" per ref. A deletion has an
# all-zero local sha and no tree worth checking; if every ref is a deletion, skip.
has_content=0
while read -r _localref localsha _remoteref _remotesha; do
  [ -z "$localsha" ] && continue
  case "$localsha" in
    0000000000000000000000000000000000000000) ;;
    *) has_content=1 ;;
  esac
done
[ "$has_content" = "0" ] && exit 0

failed=''
run_check() {
  if ! npm run --silent "$1" >/tmp/codeman-prepush-$$.log 2>&1; then
    echo ""
    echo "pre-push: FAILED  npm run $1"
    tail -n 25 /tmp/codeman-prepush-$$.log
    failed="$failed $1"
  fi
  rm -f /tmp/codeman-prepush-$$.log
}

echo "pre-push: running static checks (~15s)…"
${runs}

if [ -n "$failed" ]; then
  echo ""
  echo "pre-push: blocked by:$failed"
  echo "Fix, or push anyway with:  CODEMAN_SKIP_PREPUSH=1 git push"
  exit 1
fi

echo "pre-push: static checks passed."
exit 0
`;
}

/**
 * Decide what to do with an existing hook file.
 *
 * @param {{ existing: string | null, next: string }} args
 * @returns {'write' | 'up-to-date' | 'skip-foreign'}
 */
export function planHookInstall({ existing, next }) {
  if (existing === null || existing === undefined || existing.trim() === '') return 'write';
  if (!existing.includes(PRE_PUSH_MARKER)) return 'skip-foreign';
  return existing === next ? 'up-to-date' : 'write';
}
