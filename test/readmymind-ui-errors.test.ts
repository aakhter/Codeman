import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(new URL('../src/web/public/readmymind-ui.js', import.meta.url), 'utf8');

interface ReadMyMindRequestResult {
  ok: boolean;
  data?: { suggestions: Array<{ prompt: string; why: string; kind: string }> };
  error?: string;
}

function loadPrototype(document: object = {}): Record<string, (...args: unknown[]) => unknown> {
  class CodemanApp {}
  const context = vm.createContext({ CodemanApp, document });
  vm.runInContext(`${SOURCE}\nglobalThis.__prototype = CodemanApp.prototype;`, context, {
    filename: 'readmymind-ui.js',
  });
  return context.__prototype as Record<string, (...args: unknown[]) => unknown>;
}

describe('Read My Mind API errors', () => {
  it('preserves a structured non-2xx API error for the modal', async () => {
    const prototype = loadPrototype();
    const _api = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({
        success: false,
        errorCode: 'OPERATION_FAILED',
        error: 'Recreate this restored Codex session.',
      }),
    });

    const result = (await prototype._readMyMindRequest.call(
      { _api },
      '/api/sessions/session-1/readmymind',
      {}
    )) as ReadMyMindRequestResult;

    expect(_api).toHaveBeenCalledWith('/api/sessions/session-1/readmymind', { method: 'POST', body: {} });
    expect(result).toEqual({ ok: false, error: 'Recreate this restored Codex session.' });
  });

  it('unwraps successful suggestion data', async () => {
    const prototype = loadPrototype();
    const data = {
      suggestions: [{ prompt: 'Run the focused test.', why: 'Verify the fix.', kind: 'verify' }],
    };
    const _api = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true, data }),
    });

    await expect(
      prototype._readMyMindRequest.call({ _api }, '/api/sessions/session-1/readmymind', {})
    ).resolves.toEqual({ ok: true, data });
  });

  it.each([
    ['network failure', null],
    ['malformed JSON', { ok: false, json: vi.fn().mockRejectedValue(new Error('bad json')) }],
  ])('uses a stable fallback for %s', async (_label, response) => {
    const prototype = loadPrototype();
    const _api = vi.fn().mockResolvedValue(response);

    await expect(
      prototype._readMyMindRequest.call({ _api }, '/api/sessions/session-1/readmymind', {})
    ).resolves.toEqual({ ok: false, error: 'Read My Mind prediction failed. Please try again.' });
  });

  it('renders a request error with textContent and restores the generic empty-state copy', () => {
    const loading = { style: { display: '' } };
    const result = { style: { display: '' } };
    const error = {
      style: { display: 'none' },
      textContent: 'No suggestion this time. Add a steer note and Rethink to try again.',
      dataset: {} as Record<string, string>,
    };
    const steerRow = { style: { display: '' } };
    const rethink = { disabled: false };
    const modal = {
      querySelector(selector: string) {
        return new Map([
          ['.readmymind-loading', loading],
          ['.readmymind-result', result],
          ['.readmymind-error', error],
        ]).get(selector);
      },
    };
    const document = {
      getElementById(id: string) {
        return new Map([
          ['readMyMindModal', modal],
          ['readMyMindSteerRow', steerRow],
          ['readMyMindRethink', rethink],
        ]).get(id);
      },
    };
    const prototype = loadPrototype(document);
    const app = { _rmm: { errorMessage: 'Recreate this restored Codex session.' } };

    prototype._rmmSetPhase.call(app, 'error');
    expect(error.textContent).toBe('Recreate this restored Codex session.');
    expect(error.style.display).toBe('');

    app._rmm.errorMessage = '';
    prototype._rmmSetPhase.call(app, 'loading');
    expect(error.textContent).toBe('No suggestion this time. Add a steer note and Rethink to try again.');
  });
});
