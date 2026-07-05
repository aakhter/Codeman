/**
 * @fileoverview COD-187 (live mirror) — structural guards over the frontend
 * sources. The mirror/history state machine lives in plain-JS app.js /
 * terminal-ui.js; these assertions pin the load-bearing gates so refactors
 * can't silently drop them (repo pattern: codex-snapshot-replay.test.ts).
 *
 * Port: N/A (source-text assertions only).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appJs = readFileSync(resolve(import.meta.dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8');
const termUi = readFileSync(resolve(import.meta.dirname, '..', 'src', 'web', 'public', 'terminal-ui.js'), 'utf8');
const settingsUi = readFileSync(resolve(import.meta.dirname, '..', 'src', 'web', 'public', 'settings-ui.js'), 'utf8');

describe('COD-187 live-mirror structural guards', () => {
  it('history mode drops live output BEFORE the 128KB pending-cap accounting', () => {
    const start = appJs.indexOf('_onSessionTerminal(data) {');
    const body = appJs.slice(start, appJs.indexOf('batchTerminalWrite(data.data)', start));
    const dropIdx = body.indexOf("this._viewMode === 'history'");
    const capIdx = body.indexOf('131072');
    expect(dropIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(capIdx);
  });

  it('the 25s remote reconcile tick early-returns for mirror sessions', () => {
    const start = appJs.indexOf('_remoteReconcileTick() {');
    const body = appJs.slice(start, start + 700);
    expect(body).toContain('if (this._isMirrorSession(id)) return;');
  });

  it('the reconcile family reroutes mirror sessions to a frame refresh (never full history)', () => {
    const start = appJs.indexOf('async _reconcileForeignResize(sessionId) {');
    const body = appJs.slice(start, start + 1200);
    expect(body).toContain('_isMirrorSession(sessionId)');
    expect(body).toContain('_refreshMirrorFrame(sessionId)');
  });

  it('needsRefresh recovers mirror tabs via ?frame=1, not a history replay', () => {
    const start = appJs.indexOf('async _onSessionNeedsRefresh()');
    const body = appJs.slice(start, start + 900);
    expect(body).toContain('_isMirrorSession(this.activeSessionId)');
    expect(body).toContain('_refreshMirrorFrame');
  });

  it('_refreshMirrorFrame fetches frame=1 and only accepts source mux-frame', () => {
    const start = appJs.indexOf('async _refreshMirrorFrame(sessionId) {');
    const body = appJs.slice(start, start + 1500);
    expect(body).toContain('terminal?frame=1');
    expect(body).toContain("data.source !== 'mux-frame'");
  });

  it('scrollback has exactly three writers: selectSession, history enter, history exit', () => {
    const writers = appJs.split('options.scrollback =').length - 1;
    expect(writers).toBe(3);
    // selectSession: mirror -> 0, else user value
    expect(appJs).toContain(
      'this.terminal.options.scrollback = this._isMirrorSession(sessionId) ? 0 : this._userScrollback();'
    );
    // enter raises, exit trims
    const enter = appJs.indexOf('async _enterHistoryView(');
    expect(appJs.slice(enter, enter + 1200)).toContain('options.scrollback = this._userScrollback()');
    const exit = appJs.indexOf('_exitHistoryView() {');
    expect(appJs.slice(exit, exit + 1200)).toContain('options.scrollback = 0');
  });

  it('selectSession fetches ?frame=1 for mirror tabs and skips snapshot/cache restores', () => {
    expect(appJs).toContain('? `/api/sessions/${sessionId}/terminal?frame=1`');
    expect(appJs).toContain('let snapshot = mirror ? null : this._xtermSnapshots?.get(sessionId);');
    expect(appJs).toContain('const cachedBuffer = mirror ? undefined : this.terminalBufferCache.get(sessionId);');
  });

  it('Esc is swallowed ONLY in history mode (a leaked \\x1b cancels a codex turn)', () => {
    const start = termUi.indexOf('attachCustomKeyEventHandler');
    const body = termUi.slice(start, start + 1600);
    const gate = body.indexOf("this._viewMode === 'history'");
    const esc = body.indexOf("ev.key === 'Escape'");
    expect(gate).toBeGreaterThan(-1);
    expect(esc).toBeGreaterThan(gate); // Escape check is inside the history gate
    expect(body.slice(esc, esc + 200)).toContain('return false');
  });

  it('all three scroll inputs funnel through _handleUserScrollIntent', () => {
    // wheel handler no longer scrolls directly
    const wheel = termUi.indexOf("addEventListener(\n      'wheel'");
    const wheelBody = termUi.slice(wheel, wheel + 500);
    expect(wheelBody).toContain('_handleUserScrollIntent(lines)');
    // touchmove + momentum both call the funnel
    expect(termUi.split('_handleUserScrollIntent(lines)').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('typing exits history before flowing to the PTY (onData hook)', () => {
    const start = termUi.indexOf('this.terminal.onData((data) => {');
    const body = termUi.slice(start, start + 1200);
    expect(body).toContain("this._viewMode === 'history'");
    expect(body).toContain('_exitHistoryView');
  });

  it('COD-190: history entry is an atomic DEC-2026 swap with no-jump bottom landing', () => {
    const start = appJs.indexOf('async _enterHistoryView(');
    const body = appJs.slice(start, start + 4000);
    // one synchronized write — never a visible blank between clear and repaint
    expect(body).toContain('?2026h');
    expect(body).toContain('?2026l');
    expect(body).toContain('DEC_SYNC_STRIP_RE'); // embedded markers must not terminate our window
    expect(body).not.toContain('_resetTerminalForReplay'); // reset() would drop sync mode
    // land on the exact pixels the user was watching, then apply their gesture
    const bottom = body.indexOf('scrollToBottom()');
    const carry = body.indexOf('scrollLines(-carryLines)');
    expect(bottom).toBeGreaterThan(-1);
    expect(carry).toBeGreaterThan(bottom);
  });

  it('COD-190: first up-tick prefetches history (latency hidden behind the entry threshold)', () => {
    const funnel = termUi.slice(
      termUi.indexOf('_handleUserScrollIntent(lines) {'),
      termUi.indexOf('_handleUserScrollIntent(lines) {') + 2000
    );
    const prefetch = funnel.indexOf('_prefetchHistory?.()');
    const threshold = funnel.indexOf('HISTORY_ENTRY_LINES');
    expect(prefetch).toBeGreaterThan(-1);
    expect(prefetch).toBeLessThan(threshold); // fires BEFORE the threshold check
    // and the entry consumes it
    expect(appJs).toContain('this._historyPrefetch = null;');
    expect(appJs.indexOf('_prefetchHistory() {')).toBeGreaterThan(-1);
  });

  it('mirror gate covers claude/codex/gemini; the legacy _isTuiSession gate stays codex/gemini-only', () => {
    const mirror = appJs.slice(
      appJs.indexOf('_isMirrorSession(sessionId) {'),
      appJs.indexOf('_isMirrorSession(sessionId) {') + 500
    );
    expect(mirror).toContain("mode === 'claude'");
    const tui = appJs.slice(
      appJs.indexOf('_isTuiSession(sessionId) {'),
      appJs.indexOf('_isTuiSession(sessionId) {') + 300
    );
    expect(tui).not.toContain("'claude'"); // legacy (setting-OFF) repair paths must not change for claude
  });

  it('COD-209: opencode mode is not mirror-eligible; its own TUI owns scrollback/history', () => {
    const mirror = appJs.slice(
      appJs.indexOf('_isMirrorSession(sessionId) {'),
      appJs.indexOf('_isMirrorSession(sessionId) {') + 500
    );
    const eligible = appJs.slice(
      appJs.indexOf('_isMirrorEligible(sessionId) {'),
      appJs.indexOf('_isMirrorEligible(sessionId) {') + 500
    );
    expect(mirror).toContain('this._isMirrorEligible(sessionId)');
    expect(eligible).not.toContain("mode === 'opencode'");
  });

  it('COD-209: opencode scroll gestures send foreground TUI wheel reports instead of Codeman history', () => {
    const wheel = termUi.indexOf("addEventListener(\n      'wheel'");
    const wheelBody = termUi.slice(wheel, wheel + 900);
    expect(wheelBody).toContain('_handleForegroundTuiWheel(ev)');
    expect(wheelBody.indexOf('_handleForegroundTuiWheel(ev)')).toBeLessThan(wheelBody.indexOf('preventDefault'));

    const helper = termUi.slice(
      termUi.indexOf('_shouldForwardScrollToForegroundTui() {'),
      termUi.indexOf('_shouldForwardScrollToForegroundTui() {') + 500
    );
    expect(helper).toContain("session?.mode === 'opencode'");
    expect(helper).toContain("this._viewMode === 'live'");
  });

  it('liveMirrorEnabled is per-device: stripped from the server PUT and in displayKeys', () => {
    expect(settingsUi).toContain('liveMirrorEnabled: _lmr,');
    const dk = settingsUi.indexOf('const displayKeys = new Set([');
    expect(settingsUi.slice(dk, dk + 600)).toContain("'liveMirrorEnabled'");
    expect(settingsUi).toContain('liveMirrorEnabled: true,');
  });
});
