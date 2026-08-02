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
      MobileDetection: { getDeviceType: () => 'desktop', isHandheldDevice: () => false, isTouchDevice: () => false },
      VoiceInput: {
        _getDeepgramConfig: () => ({}),
        getActiveProviderName: () => 'Web Speech',
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
      },
      window: {},
      console,
    });
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8'), context, {
      filename: 'settings-ui.js',
    });

    const app = new (CodemanApp as unknown as new () => Record<string, any>)();
    app._updatePushUI = () => {};
    app._refreshHeadroomStatus = () => {};
    app.renderShortcutSettingsList = () => {};
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
