(function (global) {
  'use strict';

  const DEDUPE_MS = 250;
  const VIEWPORT_TYPES = new Set(['mobile', 'tablet', 'desktop']);
  const FOCUS_REASONS = new Set(['focus', 'focusin', 'session-select']);
  const PASSIVE_TOUCH_OPTIONS = { passive: true };

  function create(deps) {
    const documentTarget = deps.documentTarget || global.document;
    const windowTarget = deps.windowTarget || global;
    const terminalTarget = deps.terminalTarget;
    const isVisible = deps.isVisible || (() => documentTarget.visibilityState === 'visible');
    const isFocused = deps.isFocused || (() => documentTarget.hasFocus());
    const now =
      deps.now ||
      (() =>
        global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now());

    let destroyed = false;
    let suppressionDepth = 0;
    let pending = false;
    let pendingSessionId = null;
    let pendingRequiresFocus = false;
    let lastSignature = null;
    let lastSentAt = 0;
    let wasVisible = isVisible();

    function validDimensions(dimensions) {
      return Boolean(
        dimensions &&
        Number.isInteger(dimensions.cols) &&
        dimensions.cols >= 1 &&
        dimensions.cols <= 500 &&
        Number.isInteger(dimensions.rows) &&
        dimensions.rows >= 1 &&
        dimensions.rows <= 200 &&
        VIEWPORT_TYPES.has(dimensions.viewportType)
      );
    }

    function activate(reason, requiresFocus = FOCUS_REASONS.has(reason), bypassDedupe = false) {
      if (destroyed || suppressionDepth > 0 || !isVisible()) return false;
      if (requiresFocus && !isFocused()) return false;
      const sessionId = deps.activeSessionId();
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
      const dimensions = deps.dimensions();
      if (!validDimensions(dimensions)) return false;

      const signature = `${sessionId}:${dimensions.viewportType}:${dimensions.cols}x${dimensions.rows}`;
      const currentTime = now();
      const elapsed = currentTime - lastSentAt;
      const explicitRestore = reason === 'restore-terminal-size';
      if (
        !bypassDedupe &&
        !explicitRestore &&
        signature === lastSignature &&
        Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        elapsed < DEDUPE_MS
      )
        return false;

      let sent = false;
      try {
        sent = Boolean(deps.send({ t: 'va', c: dimensions.cols, r: dimensions.rows, v: dimensions.viewportType }));
      } catch {
        sent = false;
      }
      if (!sent) {
        pending = true;
        pendingSessionId = sessionId;
        pendingRequiresFocus = requiresFocus;
        return false;
      }

      pending = false;
      pendingSessionId = null;
      pendingRequiresFocus = false;
      lastSignature = signature;
      lastSentAt = currentTime;
      return true;
    }

    function onVisibilityChange() {
      const visible = isVisible();
      const becameVisible = visible && !wasVisible;
      wasVisible = visible;
      if (becameVisible) activate('visibility');
    }

    function onWindowFocus() {
      activate('focus');
    }

    function onPointerDown() {
      activate('pointerdown');
    }

    function onTouchStart() {
      activate('touchstart');
    }

    function onFocusIn() {
      activate('focusin');
    }

    const listeners = [
      [documentTarget, 'visibilitychange', onVisibilityChange],
      [windowTarget, 'focus', onWindowFocus],
      [terminalTarget, 'pointerdown', onPointerDown],
      [terminalTarget, 'touchstart', onTouchStart, PASSIVE_TOUCH_OPTIONS],
      [terminalTarget, 'focusin', onFocusIn],
    ];
    for (const [target, type, listener, options] of listeners) target.addEventListener(type, listener, options);

    function runWithoutActivation(callback) {
      suppressionDepth += 1;
      try {
        return callback();
      } finally {
        suppressionDepth -= 1;
      }
    }

    function flushPending(reason) {
      if (destroyed || !pending) return false;
      const sessionId = deps.activeSessionId();
      if (sessionId !== pendingSessionId) return false;
      // This is a proven-unsent activation, so an old socket's recent matching
      // signature must not suppress delivery on the fresh socket.
      return activate(reason, pendingRequiresFocus, true);
    }

    function hasPending(sessionId = deps.activeSessionId()) {
      return !destroyed && pending && sessionId === pendingSessionId;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pending = false;
      pendingSessionId = null;
      pendingRequiresFocus = false;
      for (const [target, type, listener, options] of listeners) target.removeEventListener(type, listener, options);
    }

    return { activate, flushPending, hasPending, runWithoutActivation, destroy };
  }

  global.CodemanTerminalViewerActivity = { create };
})(globalThis);
