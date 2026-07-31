/**
 * COD-124 (Unit 3) — frontend park/resume UI logic.
 *
 * Loads src/web/public/terminal-ui.js into a vm context (pattern borrowed
 * from test/terminal-document-link-provider.test.ts) and exercises the pure
 * helpers plus the _parkSession/_resumeSession orchestration directly against
 * CodemanApp.prototype, without a real DOM/browser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi, beforeEach } from 'vitest';

type Proto = Record<string, (...args: any[]) => any>;

function loadTerminalUiPrototype() {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const confirmSpy = vi.fn(() => true);
  const context = vm.createContext({
    console: { ...console, debug: vi.fn(), log: vi.fn() },
    CodemanApp: class CodemanApp {},
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: vi.fn(), documentElement: { dataset: {} } },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      confirm: confirmSpy,
      document: { documentElement: { dataset: {} } },
    },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return { proto: (context as { __proto: Proto }).__proto, confirmSpy };
}

function makeFakeApp(proto: Proto, apiPostImpl: (path: string, body: unknown) => Promise<unknown>) {
  return {
    ...proto,
    _apiPost: vi.fn(apiPostImpl),
    showToast: vi.fn(),
    _onSessionListMaybeChanged: vi.fn(),
  };
}

function fakeResponse(status: number, ok: boolean, jsonBody?: unknown) {
  return {
    status,
    ok,
    json: async () => jsonBody,
  };
}

describe('COD-124 park/resume UI — _formatIdleDuration (pure)', () => {
  let proto: Proto;
  beforeEach(() => {
    proto = loadTerminalUiPrototype().proto;
  });

  it('returns empty string for invalid/negative input', () => {
    expect(proto._formatIdleDuration(NaN)).toBe('');
    expect(proto._formatIdleDuration(-5)).toBe('');
  });

  it('formats sub-minute durations as "<1m"', () => {
    expect(proto._formatIdleDuration(30_000)).toBe('<1m');
  });

  it('formats minutes only under an hour', () => {
    expect(proto._formatIdleDuration(12 * 60_000)).toBe('12m');
  });

  it('formats hours + minutes under a day', () => {
    expect(proto._formatIdleDuration(3 * 3_600_000 + 40 * 60_000)).toBe('3h 40m');
  });

  it('omits the minutes remainder when exactly on the hour', () => {
    expect(proto._formatIdleDuration(2 * 3_600_000)).toBe('2h');
  });

  it('formats days + hours at/after 24h', () => {
    expect(proto._formatIdleDuration(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h');
  });

  it('omits the hours remainder when exactly on the day', () => {
    expect(proto._formatIdleDuration(3 * 86_400_000)).toBe('3d');
  });
});

describe('COD-124 park/resume UI — _resumeFidelityLabel (pure)', () => {
  let proto: Proto;
  beforeEach(() => {
    proto = loadTerminalUiPrototype().proto;
  });

  it('claude mode always resumes the conversation', () => {
    expect(proto._resumeFidelityLabel({ mode: 'claude' })).toBe('Resumes the conversation');
    expect(proto._resumeFidelityLabel({ mode: 'claude', nativeResumeId: undefined })).toBe('Resumes the conversation');
  });

  it('codex with a captured nativeResumeId resumes via the codex session id', () => {
    expect(proto._resumeFidelityLabel({ mode: 'codex', nativeResumeId: 'abc-123' })).toBe(
      'Resumes via Codex session id'
    );
  });

  it('codex without a captured nativeResumeId is a fresh relaunch', () => {
    expect(proto._resumeFidelityLabel({ mode: 'codex' })).toBe('Fresh relaunch — conversation not restored');
  });

  it('other modes (opencode/gemini/shell) are a fresh relaunch', () => {
    expect(proto._resumeFidelityLabel({ mode: 'opencode' })).toBe('Fresh relaunch — conversation not restored');
    expect(proto._resumeFidelityLabel({ mode: 'gemini' })).toBe('Fresh relaunch — conversation not restored');
    expect(proto._resumeFidelityLabel({ mode: 'shell' })).toBe('Fresh relaunch — conversation not restored');
  });

  it('mode is matched case-insensitively', () => {
    expect(proto._resumeFidelityLabel({ mode: 'Claude' })).toBe('Resumes the conversation');
  });
});

describe('COD-124 park/resume UI — _isNonRestorableResume (pure)', () => {
  let proto: Proto;
  beforeEach(() => {
    proto = loadTerminalUiPrototype().proto;
  });

  it('claude and codex-with-nativeResumeId are restorable', () => {
    expect(proto._isNonRestorableResume({ mode: 'claude' })).toBe(false);
    expect(proto._isNonRestorableResume({ mode: 'codex', nativeResumeId: 'x' })).toBe(false);
  });

  it('codex without nativeResumeId and other modes are non-restorable', () => {
    expect(proto._isNonRestorableResume({ mode: 'codex' })).toBe(true);
    expect(proto._isNonRestorableResume({ mode: 'opencode' })).toBe(true);
  });
});

describe('COD-124 park/resume UI — obligation labels + confirm message (pure)', () => {
  let proto: Proto;
  beforeEach(() => {
    proto = loadTerminalUiPrototype().proto;
  });

  it('maps known obligation codes to plain language', () => {
    expect(proto._parkObligationLabel('respawn')).toBe('Respawn cycling is armed');
    expect(proto._parkObligationLabel('autoResume')).toBe('Auto-resume timer is armed');
    expect(proto._parkObligationLabel('ralph')).toBe('Ralph loop is armed');
  });

  it('falls back to the raw code for an unrecognized obligation', () => {
    expect(proto._parkObligationLabel('somethingNew')).toBe('somethingNew');
  });

  it('builds a confirm message listing every obligation in plain language', () => {
    const msg = proto._buildParkConfirmMessage(['respawn', 'autoResume']);
    expect(msg).toContain('Respawn cycling is armed');
    expect(msg).toContain('Auto-resume timer is armed');
    expect(msg).toContain('Park anyway?');
  });
});

describe('COD-124 park/resume UI — _armedObligationLabels (pure, AC6)', () => {
  let proto: Proto;
  beforeEach(() => {
    proto = loadTerminalUiPrototype().proto;
  });

  it('returns no labels when nothing is armed', () => {
    expect(proto._armedObligationLabels({})).toEqual([]);
  });

  it('flags an armed auto-resume timer', () => {
    expect(proto._armedObligationLabels({ autoResumeEnabled: true, autoResumeAt: 12345 })).toEqual([
      'Auto-resume timer is armed',
    ]);
  });

  it('requires both autoResumeEnabled and autoResumeAt to flag auto-resume', () => {
    expect(proto._armedObligationLabels({ autoResumeEnabled: true })).toEqual([]);
    expect(proto._armedObligationLabels({ autoResumeAt: 12345 })).toEqual([]);
  });

  it('flags an armed ralph loop', () => {
    expect(proto._armedObligationLabels({ ralphEnabled: true })).toEqual(['Ralph loop is armed']);
  });

  it('flags both when both are armed', () => {
    expect(proto._armedObligationLabels({ autoResumeEnabled: true, autoResumeAt: 1, ralphEnabled: true })).toEqual([
      'Auto-resume timer is armed',
      'Ralph loop is armed',
    ]);
  });
});

describe('COD-124 park/resume UI — _parkSession orchestration (409 + force flow)', () => {
  it('parks directly on a clean 200 (no obligations)', async () => {
    const { proto } = loadTerminalUiPrototype();
    const apiPost = vi.fn(async () => fakeResponse(200, true));
    const app = makeFakeApp(proto, apiPost);
    const session = { sessionId: 's1', status: 'active' };

    const ok = await proto._parkSession.call(app, session);

    expect(ok).toBe(true);
    expect(session.status).toBe('parked');
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/api/sessions/s1/park', {});
    expect(app.showToast).toHaveBeenCalledWith('Session parked', 'success');
    expect(app._onSessionListMaybeChanged).toHaveBeenCalled();
  });

  it('on 409 with obligations, confirms and re-calls with {force:true} when accepted', async () => {
    const { proto, confirmSpy } = loadTerminalUiPrototype();
    confirmSpy.mockReturnValue(true);
    let call = 0;
    const apiPost = vi.fn(async (_path: string, body: any) => {
      call += 1;
      if (call === 1) return fakeResponse(409, false, { error: 'blocked', obligations: ['respawn', 'ralph'] });
      expect(body).toEqual({ force: true });
      return fakeResponse(200, true);
    });
    const app = makeFakeApp(proto, apiPost);
    const session = { sessionId: 's2', status: 'active' };

    const ok = await proto._parkSession.call(app, session);

    expect(ok).toBe(true);
    expect(session.status).toBe('parked');
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain('Respawn cycling is armed');
    expect(confirmSpy.mock.calls[0][0]).toContain('Ralph loop is armed');
  });

  it('on 409 with obligations, does not force-park when the confirm is declined (silent cancel, no error toast)', async () => {
    const { proto, confirmSpy } = loadTerminalUiPrototype();
    confirmSpy.mockReturnValue(false);
    const apiPost = vi.fn(async () => fakeResponse(409, false, { error: 'blocked', obligations: ['autoResume'] }));
    const app = makeFakeApp(proto, apiPost);
    const session = { sessionId: 's3', status: 'active' };

    const ok = await proto._parkSession.call(app, session);

    expect(ok).toBe(false);
    expect(session.status).toBe('active');
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(app.showToast).not.toHaveBeenCalled();
  });

  it('surfaces a failure toast when the final response is not ok', async () => {
    const { proto } = loadTerminalUiPrototype();
    const apiPost = vi.fn(async () => fakeResponse(500, false));
    const app = makeFakeApp(proto, apiPost);
    const session = { sessionId: 's4', status: 'active' };

    const ok = await proto._parkSession.call(app, session);

    expect(ok).toBe(false);
    expect(app.showToast).toHaveBeenCalledWith('Park failed', 'error');
  });
});

describe('COD-124 park/resume UI — _resumeSession orchestration', () => {
  it('resumes a claude session without confirming (restorable)', async () => {
    const { proto, confirmSpy } = loadTerminalUiPrototype();
    const apiPost = vi.fn(async () => fakeResponse(200, true));
    const app = makeFakeApp(proto, apiPost);
    const session = { sessionId: 's5', status: 'parked', mode: 'claude' };

    const ok = await proto._resumeSession.call(app, session);

    expect(ok).toBe(true);
    expect(session.status).toBe('active');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(apiPost).toHaveBeenCalledWith('/api/sessions/s5/resume', {});
    expect(app.showToast).toHaveBeenCalledWith('Session resumed', 'success');
  });

  it('confirms before a non-restorable resume, and aborts if declined', async () => {
    const { proto, confirmSpy } = loadTerminalUiPrototype();
    confirmSpy.mockReturnValue(false);
    const apiPost = vi.fn(async () => fakeResponse(200, true));
    const app = makeFakeApp(proto, apiPost);
    const session = { sessionId: 's6', status: 'parked', mode: 'codex' };

    const ok = await proto._resumeSession.call(app, session);

    expect(ok).toBe(false);
    expect(session.status).toBe('parked');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('proceeds with a non-restorable resume when confirmed', async () => {
    const { proto, confirmSpy } = loadTerminalUiPrototype();
    confirmSpy.mockReturnValue(true);
    const apiPost = vi.fn(async () => fakeResponse(200, true));
    const app = makeFakeApp(proto, apiPost);
    const session = { sessionId: 's7', status: 'parked', mode: 'opencode' };

    const ok = await proto._resumeSession.call(app, session);

    expect(ok).toBe(true);
    expect(session.status).toBe('active');
    expect(apiPost).toHaveBeenCalledWith('/api/sessions/s7/resume', {});
  });
});
