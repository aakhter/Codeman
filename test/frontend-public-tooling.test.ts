import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format } from 'prettier';
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

  it('keeps the public stylesheets syntactically valid', async () => {
    for (const filename of ['styles.css', 'mobile.css']) {
      const css = readFileSync(resolve(repoRoot, 'src/web/public', filename), 'utf8');

      await expect(format(css, { parser: 'css', filepath: filename })).resolves.toEqual(expect.any(String));
    }
  });

  it('uses the same message wrapper for brief and full response views', () => {
    const appJs = readFileSync(resolve(repoRoot, 'src/web/public/app.js'), 'utf8');

    // The brief view builds its single message with _buildResponseViewerMessage.
    expect(appJs).toContain("body.appendChild(this._buildResponseViewerMessage(lastResponse, 'assistant'");
    // ⚠️ A numeric `turn` gates continuation rendering. Only the Claude reader
    // emits turns; Codex, the external-CLI pane parser and an older server emit
    // adjacent same-role messages with none, and must keep one badge per card.
    // Downstream renders the FULL view through _renderResponseViewerMessages
    // (transcript blocks + per-message copy actions), so the continuation rule
    // lives there rather than in an inline _buildResponseViewerMessage loop.
    expect(appJs).toContain(
      "!!previous && previous.role === msg.role && typeof msg.turn === 'number' && previous.turn === msg.turn"
    );
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
