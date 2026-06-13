/**
 * @fileoverview Regression guard for the terminal link-provider regexes in
 * `src/web/public/terminal-ui.js`.
 *
 * The link provider runs its patterns against every hovered terminal line
 * (logical lines — xterm re-joins wrapped rows, so inputs reach multiple KB).
 * A pattern with ambiguous backtracking freezes the entire tab on hover:
 * 0.9.10's `cmdPattern` used `(?:[^\s\/]*\s+)*` (empty-matchable token,
 * unbounded), which went exponential on real Claude output — wrapped
 * `git commit -m "$(cat <<'EOF'` heredoc lines hung the main thread for
 * minutes per hover.
 *
 * This test extracts the pattern literals FROM THE SHIPPED SOURCE (no copies
 * that can drift) and asserts they stay linear-time on those killer shapes,
 * and that `cmdPattern` still links the command+path forms it exists for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'src', 'web', 'public', 'terminal-ui.js'), 'utf-8');

/** Extract `const <name> = /.../g;` from the shipped source and build the RegExp. */
function shippedPattern(name: string): RegExp {
  const m = SOURCE.match(new RegExp(`const ${name} =\\s*\\n?\\s*(/(?:[^/\\\\\\n]|\\\\.)+/[a-z]*)`));
  if (!m) throw new Error(`pattern ${name} not found in terminal-ui.js`);
  const lit = m[1];
  const lastSlash = lit.lastIndexOf('/');
  return new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));
}

const PATTERN_NAMES = ['urlPattern', 'cmdPattern', 'extPattern', 'bashPattern'];

/** Lines that made 0.9.10's cmdPattern backtrack exponentially (>2s each). */
const KILLER_LINES = [
  // wrapped git-commit heredoc from real Claude tool output (the 0.9.10 freeze)
  `      /Users/arbbot/codeman-cases/topagent-control commit -m "$(cat <<'EOF'${' '.repeat(3000)}`,
  // aligned table row: trigger word + multi-space-separated columns + mid-token slash
  'watch  ' + 'col   '.repeat(40) + ' BTC/USDT',
  // trigger word followed by many tokens and no token-initial path
  'cat ' + 'word '.repeat(800) + 'no-path-here',
  // long URL-ish and path-ish soup for the other patterns
  'https://example.com/' + 'a/'.repeat(1500) + ' ' + '/home/x/'.repeat(400) + '.'.repeat(2000),
  'Bash(' + 'x'.repeat(4000),
];

describe('terminal link-provider regexes (shipped source)', () => {
  it('all patterns stay linear-time on killer lines', () => {
    const patterns = PATTERN_NAMES.map((n) => [n, shippedPattern(n)] as const);
    const start = Date.now();
    for (const [, re] of patterns) {
      for (const line of KILLER_LINES) {
        re.lastIndex = 0;
        while (re.exec(line) !== null) {
          /* drain all matches like the provider does */
        }
      }
    }
    const elapsed = Date.now() - start;
    // 20 pattern×line runs over multi-KB inputs: linear patterns finish in a few
    // ms; the 0.9.10 cmdPattern alone needed minutes for ONE line.
    expect(elapsed).toBeLessThan(500);
  });

  it('cmdPattern still links command + path forms', () => {
    const cmd = shippedPattern('cmdPattern');
    const cases: Array<[string, string]> = [
      ['tail -f /var/log/app.log', '/var/log/app.log'],
      ['cat -n /tmp/x.json', '/tmp/x.json'],
      ['grep -rn pattern /home/user/src', '/home/user/src'],
      ['watch ls /opt/data', '/opt/data'],
      ['head -c 100 /etc/hosts', '/etc/hosts'],
    ];
    for (const [line, want] of cases) {
      cmd.lastIndex = 0;
      const m = cmd.exec(line);
      expect(m, line).not.toBeNull();
      expect(m![2]).toBe(want);
    }
  });

  it('cmdPattern arg group cannot match empty tokens (the exponential trigger)', () => {
    // structural guard: the dangerous construct is an empty-matchable token
    // inside a repeated group — `[^\s\/]*\s+` repeated. Check the pattern
    // literal itself (not the whole file — the warning comment quotes it).
    const lit = shippedPattern('cmdPattern').source;
    expect(lit).not.toContain('[^\\s\\/]*\\s+)*');
  });
});
