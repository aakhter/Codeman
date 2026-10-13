/**
 * @fileoverview COD-257 regression: App Settings waits for server-authoritative settings before rendering.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function makeLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  };
}

function makeElement() {
  return {
    checked: false,
    value: '',
    textContent: '',
    type: '',
    className: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
    // The settings rail (upstream) queries the modal for its entries and wires a
    // delegated click handler on them; without these the gate test dies inside
    // openAppSettings before it can assert on the checkpoint default.
    querySelector: () => null,
    addEventListener() {},
    scrollTo() {},
  };
}

describe('App Settings authoritative checkpoint gate', () => {
  it('waits for server settings and renders false instead of stale local true', async () => {
    const CodemanApp = function CodemanApp(this: Record<string, unknown>) {};
    const localStorage = makeLocalStorage();
    const elements: Record<string, ReturnType<typeof makeElement>> = {};
    const modal = makeElement();
    const context = vm.createContext({
      CodemanApp,
      localStorage,
      // settings-ui.js reads this as a global; in the browser voice-input.js (loaded
      // earlier in the classic-script order) defines it. This vm loads settings-ui.js
      // alone, so it has to be supplied or openAppSettings throws a ReferenceError.
      DEFAULT_VOICE_KEYTERMS: 'Codeman, tmux, Claude',
      DEFAULT_TOAST_DURATION_MS: 4000,
      AUTO_CLOSE_NOTIFICATION_MS: 5000,
      MobileDetection: { getDeviceType: () => 'desktop', isHandheldDevice: () => false, isTouchDevice: () => false },
      VoiceInput: {
        _getDeepgramConfig: () => ({}),
        getActiveProviderName: () => 'Web Speech',
        // Added upstream (voice provider status rows); openAppSettings calls them.
        refreshClaudeStatus: () => Promise.resolve(),
        refreshDeepgramStatus: () => Promise.resolve(),
      },
      KeyboardAccessoryBar: { setMode() {} },
      FocusTrap: class {
        activate() {}
      },
      document: {
        getElementById: (id: string) => {
          if (id === 'appSettingsModal') return modal;
          return (elements[id] ??= makeElement());
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
      },
      window: {},
      console,
    });
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8'), context, {
      filename: 'settings-ui.js',
    });

    const app = new (CodemanApp as unknown as new () => Record<string, any>)();
    app.$ = (id: string) => elements[id];
    app.loadWebhook = async () => {};
    app._updatePushUI = () => {};
    app._refreshHeadroomStatus = () => {};
    app.renderShortcutSettingsList = () => {};
    // Lives in app.js, which this harness does not load; openAppSettings uses the
    // return value, so a bare no-op would only move the failure downstream.
    app.resolveSessionSidebarFontSize = (value: unknown) => {
      const size = Number(value);
      return Number.isInteger(size) && size >= 11 && size <= 18 ? size : 14;
    };
    app.renderAuthoringActions = () => {};
    app.loadModelConfigForSettings = () => {};
    app._initUpdatesSection = () => {};
    app.switchSettingsTab = () => {};
    app.loadTunnelStatus = () => {};
    app.saveAppSettingsToStorage({ checkpointDefaultEnabled: true });
    app._settingsSyncPromise = app.loadAppSettingsFromServer(Promise.resolve({ checkpointDefaultEnabled: false }));

    await app.openAppSettings();

    expect(elements.appSettingsCheckpointDefault.checked).toBe(false);
  });
});
