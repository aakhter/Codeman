/**
 * @fileoverview Read My Mind predictor output-contract tests
 * (src/readmymind-predictor.ts).
 *
 * The Codex runner uses real temporary files while mocking only the process
 * boundary, so lifecycle, isolation, and output handling stay deterministic.
 */
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { PassThrough } from 'node:stream';
import { delimiter, join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(), spawn: vi.fn() };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    mkdtempSync: vi.fn(actual.mkdtempSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

vi.mock('../src/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/index.js')>();
  return { ...actual, resolveCodexDir: vi.fn(() => null) };
});

import { execSync, spawn } from 'node:child_process';
import { parsePredictionOutput } from '../src/readmymind-predictor.js';
import { readMyMindPredictor } from '../src/readmymind-predictor.js';
import { resolveCodexDir } from '../src/utils/index.js';

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const VALID = JSON.stringify({
  suggestions: [
    { prompt: 'run the tests', why: 'the assistant just finished a fix', kind: 'verify' },
    { prompt: 'COM', why: 'changesets are pending', kind: 'continue' },
  ],
});

describe('parsePredictionOutput', () => {
  it('parses the strict contract', () => {
    const suggestions = parsePredictionOutput(VALID);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toEqual({
      prompt: 'run the tests',
      why: 'the assistant just finished a fix',
      kind: 'verify',
    });
  });

  it('tolerates fenced or prosed wrapping around the JSON object', () => {
    expect(parsePredictionOutput('```json\n' + VALID + '\n```')).toHaveLength(2);
    expect(parsePredictionOutput('Here you go:\n' + VALID)).toHaveLength(2);
  });

  it('throws cleanly on garbage', () => {
    expect(() => parsePredictionOutput('no json here at all')).toThrow(/no JSON object/);
    expect(() => parsePredictionOutput('{ "definitely": not json }')).toThrow(/malformed JSON/);
  });

  it('throws on a shape mismatch, never a half-suggestion', () => {
    expect(() => parsePredictionOutput('{"suggestions": []}')).toThrow(/contract/);
    expect(() => parsePredictionOutput('{"ideas": ["x"]}')).toThrow(/contract/);
    expect(() => parsePredictionOutput(JSON.stringify({ suggestions: [{ prompt: 'x', kind: 'guess' }] }))).toThrow(
      /contract/
    );
    const four = { suggestions: Array(4).fill({ prompt: 'x', kind: 'continue' }) };
    expect(() => parsePredictionOutput(JSON.stringify(four))).toThrow(/contract/);
  });

  it('collapses embedded newlines to single-line prompts (multi-line breaks Ink)', () => {
    const out = parsePredictionOutput(
      JSON.stringify({ suggestions: [{ prompt: 'fix the bug\nthen run tests', kind: 'continue' }] })
    );
    expect(out[0].prompt).toBe('fix the bug then run tests');
  });

  it('defaults a missing why and drops empty prompts', () => {
    const out = parsePredictionOutput(JSON.stringify({ suggestions: [{ prompt: 'ok', kind: 'continue' }] }));
    expect(out[0].why).toBe('');

    expect(() =>
      parsePredictionOutput(JSON.stringify({ suggestions: [{ prompt: '  \n ', kind: 'continue' }] }))
    ).toThrow(/empty/);
  });

  it('bounds runaway fields instead of failing them', () => {
    const out = parsePredictionOutput(
      JSON.stringify({ suggestions: [{ prompt: 'p'.repeat(5000), why: 'w'.repeat(5000), kind: 'redirect' }] })
    );
    expect(out[0].prompt.length).toBe(1000);
    expect(out[0].why.length).toBe(300);
  });
});

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

interface Invocation {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
  stdin: string;
}

const spawnMock = vi.mocked(spawn);
const execSyncMock = vi.mocked(execSync);
const chmodSyncMock = vi.mocked(chmodSync);
const mkdtempSyncMock = vi.mocked(mkdtempSync);
const rmSyncMock = vi.mocked(rmSync);
const resolveCodexDirMock = vi.mocked(resolveCodexDir);
let processKill: ReturnType<typeof vi.spyOn>;
let originalEnv: NodeJS.ProcessEnv;
let nextPid = 41_000;

function outputPath(args: string[]): string {
  const index = args.indexOf('--output-last-message');
  expect(index).toBeGreaterThan(-1);
  return args[index + 1];
}

function schemaPath(args: string[]): string {
  const index = args.indexOf('--output-schema');
  expect(index).toBeGreaterThan(-1);
  return args[index + 1];
}

function installChild(
  behavior: (invocation: Invocation) => void,
  capture?: (invocation: Invocation) => void
): Invocation[] {
  const invocations: Invocation[] = [];
  spawnMock.mockImplementation((command, args = [], options = {}) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: nextPid++,
      unref: vi.fn(),
      kill: vi.fn(),
    }) as FakeChild;
    const invocation: Invocation = {
      command,
      args: [...args],
      options,
      child,
      stdin: '',
    };
    child.stdin.on('data', (chunk: Buffer) => {
      invocation.stdin += chunk.toString('utf8');
    });
    child.stdin.once('finish', () => {
      capture?.(invocation);
      behavior(invocation);
    });
    invocations.push(invocation);
    return child as unknown as ChildProcess;
  });
  return invocations;
}

function succeed(invocation: Invocation, output = VALID): void {
  writeFileSync(outputPath(invocation.args), output, { mode: 0o600 });
  invocation.child.emit('close', 0, null);
}

function codexOptions(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-123',
    prompt: 'private prediction prompt',
    provider: { kind: 'codex' as const, env: {} },
    ...overrides,
  };
}

beforeEach(() => {
  originalEnv = { ...process.env };
  spawnMock.mockReset();
  execSyncMock.mockReset();
  chmodSyncMock.mockClear();
  mkdtempSyncMock.mockClear();
  rmSyncMock.mockClear();
  resolveCodexDirMock.mockReset();
  resolveCodexDirMock.mockReturnValue(null);
  processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  process.env = originalEnv;
  processKill.mockRestore();
  vi.useRealTimers();
});

describe('readMyMindPredictor provider dispatch', () => {
  it('keeps Claude on the existing detached tmux path and never invokes Codex', async () => {
    installChild(() => {});

    await expect(
      readMyMindPredictor.predict({
        sessionId: 'claude-session',
        prompt: 'claude prompt',
        provider: { kind: 'claude', model: 'claude-opus-4-5-20251101' },
        timeoutMs: 5,
      })
    ).rejects.toThrow('Prediction timed out after 5ms');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('tmux');
    expect(resolveCodexDirMock).not.toHaveBeenCalled();
  });

  it('keeps Codex on the direct spawn path and never invokes tmux', async () => {
    installChild(succeed);

    await readMyMindPredictor.predict(codexOptions());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('codex');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('spawns the resolver-discovered Codex binary and prepends its directory to PATH', async () => {
    const codexDir = join('/fallback', 'codex', 'bin');
    process.env.PATH = ['/usr/local/sbin', '/usr/bin'].join(delimiter);
    resolveCodexDirMock.mockReturnValueOnce(codexDir);
    const invocations = installChild(succeed);

    await readMyMindPredictor.predict(codexOptions());

    expect(invocations[0].command).toBe(join(codexDir, 'codex'));
    expect(String(invocations[0].options.env?.PATH).split(delimiter)).toEqual([
      codexDir,
      '/usr/local/sbin',
      '/usr/bin',
    ]);
  });
});

describe('Codex predictor invocation isolation', () => {
  it('pins the complete argument vector and global approval-flag ordering', async () => {
    const invocations = installChild(succeed);
    await readMyMindPredictor.predict(codexOptions());

    const invocation = invocations[0];
    const schema = schemaPath(invocation.args);
    const output = outputPath(invocation.args);
    const cwd = String(invocation.options.cwd);
    expect(invocation.args).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--disable',
      'shell_tool',
      '--config',
      'project_doc_max_bytes=0',
      '--config',
      'agents.enabled=false',
      '--config',
      'tools.web_search=false',
      '--config',
      'shell_environment_policy.inherit=none',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--output-schema',
      schema,
      '--output-last-message',
      output,
      '--cd',
      cwd,
      '-',
    ]);
    expect(invocation.options.detached).toBe(true);
    expect(invocation.options.shell).not.toBe(true);
  });

  it('uses a private cwd and files, passes the prompt only on stdin, and cleans up', async () => {
    let cwd = '';
    installChild(succeed, (invocation) => {
      cwd = String(invocation.options.cwd);
      expect(cwd.startsWith(process.cwd())).toBe(false);
      expect(lstatSync(cwd).mode & 0o777).toBe(0o700);
      expect(lstatSync(schemaPath(invocation.args)).mode & 0o777).toBe(0o600);
      expect(lstatSync(outputPath(invocation.args)).mode & 0o777).toBe(0o600);
      expect(readdirSync(cwd).sort()).toEqual(['output.json', 'schema.json']);
      expect(JSON.parse(readFileSync(schemaPath(invocation.args), 'utf8'))).toMatchObject({
        properties: { suggestions: { minItems: 1, maxItems: 3 } },
      });
      expect(invocation.stdin).toBe('private prediction prompt');
      expect(invocation.args.join(' ')).not.toContain('private prediction prompt');
      expect(invocation.args.join(' ')).not.toContain('provider-secret');
    });

    await readMyMindPredictor.predict(
      codexOptions({ provider: { kind: 'codex', env: { OPENAI_API_KEY: 'provider-secret' } } })
    );

    expect(existsSync(cwd)).toBe(false);
  });

  it('omits an absent model and passes a validated launch-time model', async () => {
    const invocations = installChild(succeed);
    await readMyMindPredictor.predict(codexOptions());
    await readMyMindPredictor.predict(codexOptions({ provider: { kind: 'codex', model: 'gpt-5.2-codex', env: {} } }));

    expect(invocations[0].args).not.toContain('--model');
    const modelIndex = invocations[1].args.indexOf('--model');
    expect(invocations[1].args.slice(modelIndex, modelIndex + 2)).toEqual(['--model', 'gpt-5.2-codex']);

    await expect(
      readMyMindPredictor.predict(codexOptions({ provider: { kind: 'codex', model: 'bad model; echo nope', env: {} } }))
    ).rejects.toThrow(/Invalid model name/);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('builds a closed environment with provider precedence and process fallback', async () => {
    process.env.CODEX_HOME = '/process/codex';
    process.env.OPENAI_API_KEY = 'process-openai';
    process.env.CODEX_API_KEY = 'process-codex';
    process.env.CODEX_UNSAFE_EXTRA = 'must-not-leak';
    process.env.SERVER_DATABASE_SECRET = 'must-not-leak';
    process.env.HTTPS_PROXY = 'https://proxy.example';
    const invocations = installChild(succeed);

    await readMyMindPredictor.predict(
      codexOptions({
        provider: {
          kind: 'codex',
          env: { CODEX_HOME: '/provider/codex', OPENAI_API_KEY: 'provider-openai' },
        },
      })
    );

    const env = invocations[0].options.env;
    expect(env).toMatchObject({
      CODEX_HOME: '/provider/codex',
      OPENAI_API_KEY: 'provider-openai',
      CODEX_API_KEY: 'process-codex',
      HTTPS_PROXY: 'https://proxy.example',
    });
    expect(env?.PATH).toBeTruthy();
    expect(env).not.toHaveProperty('CODEX_UNSAFE_EXTRA');
    expect(env).not.toHaveProperty('SERVER_DATABASE_SECRET');
    expect(
      Object.keys(env ?? {}).every((key) =>
        [
          'PATH',
          'HOME',
          'TMPDIR',
          'LANG',
          'LC_ALL',
          'SSL_CERT_FILE',
          'SSL_CERT_DIR',
          'NODE_EXTRA_CA_CERTS',
          'HTTP_PROXY',
          'HTTPS_PROXY',
          'NO_PROXY',
          'http_proxy',
          'https_proxy',
          'no_proxy',
          'CODEX_HOME',
          'OPENAI_API_KEY',
          'CODEX_API_KEY',
        ].includes(key)
      )
    ).toBe(true);
    expect(process.env.CODEX_HOME).toBe('/process/codex');
  });
});

describe('Codex predictor output and lifecycle', () => {
  it('reads only the final-output file and applies existing Zod normalization', async () => {
    installChild((invocation) => {
      invocation.child.stdout.write('{"suggestions":[{"prompt":"wrong","kind":"continue"}]}');
      succeed(
        invocation,
        JSON.stringify({
          suggestions: [{ prompt: 'run tests\nthen inspect', why: '  because\nneeded ', kind: 'verify', extra: true }],
        })
      );
    });

    const result = await readMyMindPredictor.predict(codexOptions());
    expect(result.suggestions).toEqual([{ prompt: 'run tests then inspect', why: 'because needed', kind: 'verify' }]);
  });

  it.each([
    ['', /returned no output/i],
    ['not json', /invalid output/i],
    ['{"suggestions":[]}', /invalid output/i],
  ])('rejects empty, malformed, and wrong-contract final output', async (output, expected) => {
    let cwd = '';
    installChild(
      (invocation) => succeed(invocation, output),
      (invocation) => {
        cwd = String(invocation.options.cwd);
      }
    );

    await expect(readMyMindPredictor.predict(codexOptions())).rejects.toThrow(expected);
    expect(existsSync(cwd)).toBe(false);
  });

  it.each([
    ['error: unexpected argument --ignore-rules', /must be updated/i],
    ['strict config rejected unknown field agents.enabled', /must be updated/i],
    ['error: unknown feature: shell_tool', /must be updated/i],
    ['error: unsupported feature shell_tool', /must be updated/i],
    ["error: invalid value 'workspace-write' for '--sandbox <SANDBOX>'", /must be updated/i],
    ["error: invalid value 'true' for 'tools.web_search'", /must be updated/i],
    ['configuration error: authentication required; token=secret', /authentication or configuration/i],
    ['authentication failed: unknown key id', /authentication or configuration/i],
  ])('classifies nonzero exits without exposing stderr and never retries', async (stderr, expected) => {
    let cwd = '';
    installChild(
      (invocation) => {
        invocation.child.stderr.write(stderr);
        invocation.child.emit('close', 2, null);
      },
      (invocation) => {
        cwd = String(invocation.options.cwd);
      }
    );

    const prediction = readMyMindPredictor.predict(codexOptions());
    await expect(prediction).rejects.toThrow(expected);
    await expect(prediction).rejects.not.toThrow(/token=secret|--ignore-rules/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(existsSync(cwd)).toBe(false);
  });

  it('reports an unavailable binary cleanly and removes the private directory', async () => {
    let cwd = '';
    installChild(
      (invocation) => {
        const error = Object.assign(new Error('spawn codex ENOENT /secret/path'), { code: 'ENOENT' });
        invocation.child.emit('error', error);
      },
      (invocation) => {
        cwd = String(invocation.options.cwd);
      }
    );

    await expect(readMyMindPredictor.predict(codexOptions())).rejects.toThrow(/Codex CLI is unavailable/i);
    expect(existsSync(cwd)).toBe(false);
  });

  it('cleans up when spawn throws synchronously', async () => {
    let cwd = '';
    let command = '';
    resolveCodexDirMock.mockReturnValueOnce(null);
    spawnMock.mockImplementationOnce((spawnCommand, _args, options = {}) => {
      command = spawnCommand;
      cwd = String(options.cwd);
      throw Object.assign(new Error('spawn ENOENT /secret/path'), { code: 'ENOENT' });
    });

    await expect(readMyMindPredictor.predict(codexOptions())).rejects.toThrow(/Codex CLI is unavailable/i);
    expect(command).toBe('codex');
    expect(existsSync(cwd)).toBe(false);
  });

  it('sanitizes a path-bearing private-directory creation error', async () => {
    mkdtempSyncMock.mockImplementationOnce(() => {
      throw new Error('EACCES creating /secret/server/tmp/codeman-rmm-codex-123');
    });

    const prediction = readMyMindPredictor.predict(codexOptions());
    await expect(prediction).rejects.toThrow('Codex prediction could not create its private workspace.');
    await expect(prediction).rejects.not.toThrow(/\/secret\/server/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps setup errors sanitized when best-effort removal also fails', async () => {
    let privateDir = '';
    mkdtempSyncMock.mockImplementationOnce((prefix) => {
      privateDir = actualFs.mkdtempSync(prefix);
      return privateDir;
    });
    chmodSyncMock.mockImplementationOnce(() => {
      throw new Error(`chmod failed for ${privateDir}`);
    });
    rmSyncMock.mockImplementationOnce(() => {
      throw new Error(`rm failed for ${privateDir}`);
    });

    try {
      const prediction = readMyMindPredictor.predict(codexOptions());
      await expect(prediction).rejects.toThrow('Codex prediction could not create its private workspace.');
      await expect(prediction).rejects.not.toThrow(privateDir);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      actualFs.rmSync(privateDir, { recursive: true, force: true });
    }
  });

  it('preserves unavailable-binary classification when best-effort removal fails', async () => {
    let privateDir = '';
    spawnMock.mockImplementationOnce((_command, _args, options = {}) => {
      privateDir = String(options.cwd);
      throw Object.assign(new Error(`spawn ENOENT from ${privateDir}`), { code: 'ENOENT' });
    });
    rmSyncMock.mockImplementationOnce(() => {
      throw new Error(`rm failed for ${privateDir}`);
    });

    try {
      const prediction = readMyMindPredictor.predict(codexOptions());
      await expect(prediction).rejects.toThrow('Codex CLI is unavailable; install Codex and restart Codeman.');
      await expect(prediction).rejects.not.toThrow(privateDir);
    } finally {
      actualFs.rmSync(privateDir, { recursive: true, force: true });
    }
  });

  it('does not turn successful prediction into an error when final cleanup fails', async () => {
    let privateDir = '';
    installChild(succeed, (invocation) => {
      privateDir = String(invocation.options.cwd);
    });
    rmSyncMock.mockImplementationOnce(() => {
      throw new Error(`rm failed for ${privateDir}`);
    });

    try {
      await expect(readMyMindPredictor.predict(codexOptions())).resolves.toMatchObject({
        suggestions: expect.any(Array),
      });
      expect(rmSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      actualFs.rmSync(privateDir, { recursive: true, force: true });
    }
  });

  it.each(['stdout', 'stderr'] as const)(
    'caps streaming %s at 256 KiB and kills only the child group',
    async (stream) => {
      let childPid = 0;
      let cwd = '';
      installChild(
        (invocation) => {
          childPid = invocation.child.pid;
          invocation.child[stream].write(Buffer.alloc(256 * 1024 + 1, 'x'));
        },
        (invocation) => {
          cwd = String(invocation.options.cwd);
        }
      );

      await expect(readMyMindPredictor.predict(codexOptions())).rejects.toThrow(/output limit/i);
      expect(processKill).toHaveBeenCalledWith(-childPid, 'SIGTERM');
      expect(processKill).toHaveBeenCalledWith(-childPid, 'SIGKILL');
      expect(existsSync(cwd)).toBe(false);
    }
  );

  it('caps the monitored final-output file at 64 KiB', async () => {
    let childPid = 0;
    let cwd = '';
    installChild(
      (invocation) => {
        childPid = invocation.child.pid;
        writeFileSync(outputPath(invocation.args), Buffer.alloc(64 * 1024 + 1, 'x'));
      },
      (invocation) => {
        cwd = String(invocation.options.cwd);
      }
    );

    await expect(readMyMindPredictor.predict(codexOptions({ timeoutMs: 2_000 }))).rejects.toThrow(/output limit/i);
    expect(processKill).toHaveBeenCalledWith(-childPid, 'SIGTERM');
    expect(processKill).toHaveBeenCalledWith(-childPid, 'SIGKILL');
    expect(existsSync(cwd)).toBe(false);
  });

  it('times out, terminates the detached process group, and cleans up', async () => {
    let childPid = 0;
    let cwd = '';
    installChild(
      (invocation) => {
        childPid = invocation.child.pid;
      },
      (invocation) => {
        cwd = String(invocation.options.cwd);
      }
    );

    await expect(readMyMindPredictor.predict(codexOptions({ timeoutMs: 5 }))).rejects.toThrow(/timed out after 5ms/i);
    expect(processKill).toHaveBeenCalledWith(-childPid, 'SIGTERM');
    expect(processKill).toHaveBeenCalledWith(-childPid, 'SIGKILL');
    expect(existsSync(cwd)).toBe(false);
  });

  it('still escalates and settles once when the leader closes during abort grace', async () => {
    vi.useFakeTimers();
    let childPid = 0;
    let cwd = '';
    installChild(
      (invocation) => {
        childPid = invocation.child.pid;
        invocation.child.stdout.write(Buffer.alloc(256 * 1024 + 1, 'x'));
        invocation.child.emit('close', null, 'SIGTERM');
      },
      (invocation) => {
        cwd = String(invocation.options.cwd);
      }
    );

    let settlements = 0;
    const observed = readMyMindPredictor.predict(codexOptions()).then(
      () => {
        settlements += 1;
        return new Error('unexpected resolution');
      },
      (error: unknown) => {
        settlements += 1;
        return error;
      }
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(processKill).toHaveBeenCalledWith(-childPid, 'SIGTERM');
    expect(processKill).not.toHaveBeenCalledWith(-childPid, 'SIGKILL');
    expect(settlements).toBe(0);
    expect(existsSync(cwd)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(await observed).toEqual(expect.objectContaining({ message: expect.stringMatching(/output limit/i) }));
    expect(processKill).toHaveBeenCalledWith(-childPid, 'SIGKILL');
    expect(settlements).toBe(1);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
    expect(existsSync(cwd)).toBe(false);
  });
});
