import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

describe('frontend public asset tooling', () => {
  it('exposes a public asset check script', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['check:public-assets']).toContain('scripts/check-public-assets.mjs');
  });

  it('keeps app.js free of literal NUL bytes', () => {
    const appJs = readFileSync(resolve(repoRoot, 'src/web/public/app.js'));

    expect(appJs.includes(0)).toBe(false);
  });

  it('uses the same message wrapper for brief and full response views', () => {
    const appJs = readFileSync(resolve(repoRoot, 'src/web/public/app.js'), 'utf8');

    // The brief view builds its single message with _buildResponseViewerMessage.
    expect(appJs).toContain("body.appendChild(this._buildResponseViewerMessage(lastResponse, 'assistant'");
    expect(appJs).toContain("div.className = 'rv-message ' + (isUser ? 'rv-msg-user' : 'rv-msg-assistant');");
    expect(appJs).toContain("renderedText.className = 'rv-text';");

    // The full view goes through _renderResponseViewerMessages instead: it
    // renders transcript BLOCKS (kind: prompt/response/…), which the two-role
    // builder cannot express, and attaches per-message copy actions. What
    // matters for this test — that both views share one markup/CSS contract —
    // is asserted on the classes it emits, not on the call it makes.
    const fullRenderer = appJs.slice(appJs.indexOf('_renderResponseViewerMessages(body, messages'));
    expect(fullRenderer).toContain("div.className = 'rv-message rv-msg-' + kind;");
    expect(fullRenderer).toContain("role.className = 'rv-role rv-role-' + kind;");
    expect(fullRenderer).toContain("text.className = 'rv-text';");
  });

  it('runs the public asset check script', () => {
    expect(() => {
      execFileSync('npm', ['run', 'check:public-assets', '--silent'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});
