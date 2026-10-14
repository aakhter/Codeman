/**
 * @fileoverview COD-187 (live mirror) — structural guards over the frontend
 * sources. The mirror/history state machine lives in plain-JS app.js /
 * terminal-ui.js; these assertions pin the load-bearing gates so refactors
 * can't silently drop them (repo pattern: codex-snapshot-replay.test.ts).
 *
 * Port: N/A (source-text assertions only).
 */
import { describe, it, expect, vi } from 'vitest';
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

  it('periodically heals remote mirrors while preserving local and history views', () => {
    const start = appJs.indexOf('_remoteReconcileTick() {');
    const method = appJs.slice(start, appJs.indexOf('\n  }\n', start) + 5);
    const tick = new Function(`return ({${method}})._remoteReconcileTick`)();
    const refresh = vi.fn();
    const app = {
      activeSessionId: 'remote',
      terminal: {},
      _isLoadingBuffer: false,
      _isMirrorSession: () => true,
      sessions: new Map([['remote', { remote: {} }]]),
      _viewMode: 'live',
      _refreshMirrorFrame: refresh,
    };
    tick.call(app);
    expect(refresh).toHaveBeenCalledExactlyOnceWith('remote');
    refresh.mockClear();
    app._viewMode = 'history';
    tick.call(app);
    expect(refresh).not.toHaveBeenCalled();
    app._viewMode = 'live';
    app.sessions.clear();
    tick.call(app);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('invalidates mirror capture deduplication after live output', () => {
    const start = appJs.indexOf('_onSessionTerminal(data) {');
    const end = appJs.indexOf('batchTerminalWrite(data.data)', start);
    expect(appJs.slice(start, end)).toContain('if (this._isMirrorSession(data.id)) this._lastMirrorFrame = null;');
  });

  it('the reconcile family reroutes mirror sessions to a frame refresh (never full history)', () => {
    const start = appJs.indexOf('async _reconcileForeignResize(sessionId) {');
    const body = appJs.slice(start, start + 1200);
    expect(body).toContain('_isMirrorSession(sessionId)');
    expect(body).toContain('_refreshMirrorFrame(sessionId)');
  });

  it('needsRefresh recovers mirror tabs via ?frame=1, not a history replay', () => {
    const start = appJs.indexOf('async _onSessionNeedsRefresh(');
    // Upstream's tile-grid and refresh-owner guards now come first, so read further in.
    const body = appJs.slice(start, start + 1600);
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
    const esc = body.indexOf("ev.key === 'Escape'", gate);
    expect(gate).toBeGreaterThan(-1);
    expect(esc).toBeGreaterThan(gate); // Escape check is inside the history gate
    expect(body.slice(esc, esc + 200)).toContain('return false');
  });

  it('all three scroll inputs funnel through _handleUserScrollIntent', () => {
    // The wheel handler never scrolls a mirror tab directly. The #205 merge
    // grew this listener (mouse-tracking/alt-buffer passthrough, the CLI-forward
    // branch and the opencode-mobile rAF batch all precede the funnel), so the
    // window has to cover the whole listener rather than its first 900 chars.
    const wheel = termUi.indexOf("addEventListener(\n      'wheel'");
    const wheelBody = termUi.slice(wheel, termUi.indexOf('{ passive: false, capture: true }', wheel));
    expect(wheelBody).toContain('_handleUserScrollIntent(lines)');
    // touchmove + momentum both call the funnel
    expect(termUi.split('_handleUserScrollIntent(lines)').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('typing exits history before flowing to the PTY (onData hook)', () => {
    // COD-388 extracted the onData body into `handleTerminalData` (registration
    // is now a one-line delegate), so the old anchor matched nothing and the
    // slice was the empty string — which `toContain` reports as a missing guard
    // rather than as a missing anchor. Anchor on the extracted function, and
    // assert the anchor itself so a future rename fails loudly instead of
    // silently passing an empty slice.
    const start = termUi.indexOf('const handleTerminalData = (data');
    expect(start, 'handleTerminalData definition must exist').toBeGreaterThanOrEqual(0);
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
    const carry = body.indexOf('scrollLines(-carryRows)');
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

  it('COD-291: a trackpad reversal cannot exit while the initial history buffer is loading', () => {
    expect(appJs).toContain('this._historyInitialLoadGen = 0;');

    const enter = appJs.slice(appJs.indexOf('async _enterHistoryView('), appJs.indexOf('async _expandHistoryFull()'));
    const allocate = enter.indexOf('const gen = ++this._historyLoadGen;');
    const markPending = enter.indexOf('this._historyInitialLoadGen = gen;');
    const finishWrite = enter.indexOf('this._finishBufferLoad(owner);');
    const clearPending = enter.indexOf('this._historyInitialLoadGen = 0;', finishWrite);
    expect(markPending).toBeGreaterThan(allocate);
    expect(clearPending).toBeGreaterThan(finishWrite);

    const funnel = termUi.slice(
      termUi.indexOf('_handleUserScrollIntent(lines) {'),
      termUi.indexOf('_handleUserScrollIntent(lines) {') + 2200
    );
    expect(funnel).toContain('this._historyInitialLoadGen !== this._historyLoadGen');

    const exit = appJs.slice(appJs.indexOf('_exitHistoryView() {'), appJs.indexOf('_showHistoryPill(text) {'));
    expect(exit).toContain('this._historyInitialLoadGen = 0;');
  });

  it('COD-291: fractional trackpad carry is converted to whole rows before xterm scrolling', () => {
    const enter = appJs.slice(appJs.indexOf('async _enterHistoryView('), appJs.indexOf('async _expandHistoryFull()'));
    expect(enter).toContain('const carryRows = Math.max(0, Math.trunc(carryLines));');
    expect(enter).toContain('if (carryRows > 0) this.terminal.scrollLines(-carryRows);');
    expect(enter).not.toContain('this.terminal.scrollLines(-carryLines)');
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

  it('COD-211: opencode click gestures are routed to foreground TUI mouse reports', () => {
    const click = termUi.slice(termUi.indexOf("'click'"), termUi.indexOf("'click'") + 300);
    expect(click).toContain("'click'");
    expect(click).toContain('_handleForegroundTuiClick(ev)');

    const helper = termUi.slice(
      termUi.indexOf('_handleForegroundTuiClick(ev) {'),
      termUi.indexOf('_handleForegroundTuiClick(ev) {') + 600
    );
    expect(helper).toContain('_shouldForwardScrollToForegroundTui()');
    expect(helper).toContain('_sendForegroundTuiClick(ev.clientX, ev.clientY)');
  });

  it('liveMirrorEnabled is per-device: stripped from the server PUT and in displayKeys', () => {
    expect(settingsUi).toContain('liveMirrorEnabled: _lmr,');
    // Slice to the END of the Set literal rather than a fixed 600-char window:
    // the upstream merge added a key, which pushed this past the old window while
    // membership was unchanged. The window length was never the thing under test.
    const dk = settingsUi.indexOf('const displayKeys = new Set([');
    const dkEnd = settingsUi.indexOf('])', dk);
    expect(dkEnd).toBeGreaterThan(dk);
    expect(settingsUi.slice(dk, dkEnd)).toContain("'liveMirrorEnabled'");
    expect(settingsUi).toContain('liveMirrorEnabled: true,');
  });
});
