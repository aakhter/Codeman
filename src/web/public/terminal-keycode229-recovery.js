/**
 * Recover explicit keyCode 229 terminal input when a browser reports a key but
 * never mutates xterm's helper textarea. xterm remains authoritative whenever
 * it emits canonical data or the browser enters a real composition lifecycle.
 */
(function (global) {
  'use strict';

  const LATE_INPUT_WINDOW_MS = 250;
  const MAX_RECOVERED_RECORDS = 32;

  function terminalDataForEvent(event) {
    if (!event || event.type !== 'keydown' || event.keyCode !== 229 || event.isComposing) return null;
    if (event.ctrlKey || event.altKey || event.metaKey) return null;
    try {
      if (event.getModifierState?.('AltGraph')) return null;
    } catch {
      return null;
    }

    const key = event.key;
    if (key === 'Enter') return '\r';
    if (key === 'Process' || key === 'Unidentified' || key === 'Dead') return null;
    if (typeof key !== 'string' || Array.from(key).length !== 1) return null;
    const codePoint = key.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return null;
    return key;
  }

  function create(options) {
    const textarea = options?.textarea;
    const emitRecovered = options?.emitRecovered;
    if (!textarea?.addEventListener || !textarea?.removeEventListener || typeof emitRecovered !== 'function') {
      return null;
    }

    const enqueueMicrotask = options.queueMicrotask || global.queueMicrotask.bind(global);
    const setTimer = options.setTimer || global.setTimeout.bind(global);
    const clearTimer = options.clearTimer || global.clearTimeout.bind(global);
    const now = options.now || (() => global.performance?.now?.() ?? Date.now());

    let destroyed = false;
    let keyToken = 0;
    const pending = [];
    const recovered = [];

    function removePending(candidate) {
      const index = pending.indexOf(candidate);
      if (index !== -1) pending.splice(index, 1);
      if (candidate.timer !== null) {
        try {
          clearTimer(candidate.timer);
        } catch {}
        candidate.timer = null;
      }
      candidate.active = false;
    }

    function cancelPending(predicate = () => true) {
      for (const candidate of [...pending]) {
        if (predicate(candidate)) removePending(candidate);
      }
    }

    function pruneRecovered() {
      const current = now();
      for (let index = recovered.length - 1; index >= 0; index -= 1) {
        if (recovered[index].expiresAt < current) recovered.splice(index, 1);
      }
    }

    function handleKeyEvent(event) {
      if (destroyed || event?.type !== 'keydown') return;
      keyToken += 1;
      const data = terminalDataForEvent(event);
      if (data === null) return;

      const candidate = { token: keyToken, data, active: true, timer: null };
      pending.push(candidate);
      try {
        // The custom key handler runs before xterm's CompositionHelper. Queueing
        // our timer from a microtask places it after xterm's own zero-delay
        // textarea diff, while keeping the recovery delay to one browser task.
        enqueueMicrotask(() => {
          if (destroyed || !candidate.active) return;
          try {
            candidate.timer = setTimer(() => {
              if (destroyed || !candidate.active) return;
              removePending(candidate);
              pruneRecovered();
              recovered.push({
                token: candidate.token,
                data: candidate.data,
                expiresAt: now() + LATE_INPUT_WINDOW_MS,
                claimedByInput: false,
              });
              if (recovered.length > MAX_RECOVERED_RECORDS) {
                recovered.splice(0, recovered.length - MAX_RECOVERED_RECORDS);
              }
              try {
                emitRecovered(candidate.data);
              } catch {
                // Recovery is fail-open: never interfere with xterm after an
                // application callback failure.
              }
            }, 0);
          } catch {
            removePending(candidate);
          }
        });
      } catch {
        removePending(candidate);
      }
    }

    function onCanonicalInput(event) {
      if (destroyed) return;
      const token = keyToken;
      cancelPending((candidate) => candidate.token === token);
      const inputData = typeof event?.data === 'string' ? event.data : null;
      if (inputData === null) return;
      const matchingRecovery = recovered.find((record) => record.token === token && record.data === inputData);
      if (matchingRecovery) matchingRecovery.claimedByInput = true;
    }

    function resetForCompositionOrFocusLoss() {
      if (destroyed) return;
      keyToken += 1;
      cancelPending();
      recovered.splice(0);
    }

    function consumeTerminalData(data) {
      if (destroyed) return false;
      pruneRecovered();

      const canonical = pending.find(
        (candidate) => candidate.active && candidate.token === keyToken && candidate.data === data
      );
      if (canonical) {
        removePending(canonical);
        return false;
      }

      const duplicateIndex = recovered.findIndex(
        (record) => record.token === keyToken && record.data === data && record.claimedByInput
      );
      if (duplicateIndex === -1) return false;
      recovered.splice(duplicateIndex, 1);
      return true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelPending();
      recovered.splice(0);
      try {
        textarea.removeEventListener('beforeinput', onCanonicalInput, true);
        textarea.removeEventListener('input', onCanonicalInput, true);
        textarea.removeEventListener('compositionstart', resetForCompositionOrFocusLoss, true);
        textarea.removeEventListener('blur', resetForCompositionOrFocusLoss, true);
      } catch {}
    }

    try {
      textarea.addEventListener('beforeinput', onCanonicalInput, true);
      textarea.addEventListener('input', onCanonicalInput, true);
      textarea.addEventListener('compositionstart', resetForCompositionOrFocusLoss, true);
      textarea.addEventListener('blur', resetForCompositionOrFocusLoss, true);
    } catch {
      destroy();
      return null;
    }

    return Object.freeze({ handleKeyEvent, consumeTerminalData, destroy });
  }

  global.CodemanKeyCode229Recovery = Object.freeze({ create, terminalDataForEvent });
})(typeof window !== 'undefined' ? window : globalThis);
