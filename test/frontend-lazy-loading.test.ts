import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const indexHtml = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const loaderPath = resolve(publicDir, 'lazy-feature-loader.js');
const loaderSource = existsSync(loaderPath) ? readFileSync(loaderPath, 'utf8') : '';

type HarnessOptions = { failFirst?: boolean };

function createHarness(options: HarnessOptions = {}) {
  const appended: Array<Record<string, any>> = [];
  const opened = vi.fn((value?: string) => `opened:${value ?? ''}`);
  const toast = vi.fn();
  const errors: unknown[][] = [];
  let attempts = 0;
  const CodemanApp = function CodemanApp(this: any) {};
  const context = vm.createContext({
    CodemanApp,
    console: { ...console, error: (...args: unknown[]) => errors.push(args) },
    setTimeout,
    clearTimeout,
  }) as any;
  context.window = context;
  context.document = {
    createElement: () => ({ async: true, src: '', dataset: {}, onload: null, onerror: null, remove: vi.fn() }),
    head: {
      appendChild(script: Record<string, any>) {
        appended.push(script);
        attempts += 1;
        queueMicrotask(() => {
          if (options.failFirst && attempts === 1) {
            script.onerror?.(new Error('simulated load failure'));
            return;
          }
          CodemanApp.prototype.showRalphWizard = opened;
          CodemanApp.prototype.handlePlanSubagentEvent = vi.fn();
          CodemanApp.prototype.cancelPlanGeneration = vi.fn();
          script.onload?.();
        });
      },
    },
  };
  vm.runInContext(loaderSource, context, { filename: 'lazy-feature-loader.js' });
  const app = new (CodemanApp as any)();
  app.showToast = toast;
  return { app, appended, errors, opened, toast };
}

describe('frontend optional feature loading', () => {
  it('keeps core startup scripts eager and removes Ralph wizard from the critical graph', () => {
    expect(indexHtml).toContain('<script defer src="lazy-feature-loader.js"></script>');
    expect(indexHtml).not.toContain('<script defer src="ralph-wizard.js"></script>');
    for (const asset of [
      'constants.js',
      'app.js',
      'terminal-ui.js',
      'settings-ui.js',
      'session-ui.js',
      'api-client.js',
    ]) {
      expect(indexHtml).toContain(`<script defer src="${asset}"></script>`);
    }
  });

  it('loads the optional feature once and executes the original action', async () => {
    const { app, appended, opened } = createHarness();
    const result = await app.showRalphWizard('keyboard');
    expect(appended.map((script) => script.src)).toEqual(['ralph-wizard.js']);
    expect(opened).toHaveBeenCalledWith('keyboard');
    expect(result).toBe('opened:keyboard');
  });

  it('shares one promise across concurrent first actions', async () => {
    const { app, appended, opened } = createHarness();
    const results = await Promise.all([app.showRalphWizard('one'), app.showRalphWizard('two')]);
    expect(appended).toHaveLength(1);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(results).toEqual(['opened:one', 'opened:two']);
  });

  it('restores a retryable UI and reports an actionable load failure', async () => {
    const { app, appended, errors, opened, toast } = createHarness({ failFirst: true });
    await expect(app.showRalphWizard()).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith('Could not load Ralph wizard. Check your connection and try again.', 'error');
    expect(errors.flat().join(' ')).toContain('ralph-wizard.js');
    await expect(app.showRalphWizard('retry')).resolves.toBe('opened:retry');
    expect(appended).toHaveLength(2);
    expect(opened).toHaveBeenCalledWith('retry');
  });

  it('keeps background and inline entry points callable before the feature arrives', () => {
    const { app } = createHarness();
    expect(app.showRalphWizard).toEqual(expect.any(Function));
    expect(app.handlePlanSubagentEvent).toEqual(expect.any(Function));
    expect(app.cancelPlanGeneration).toEqual(expect.any(Function));
  });
});
