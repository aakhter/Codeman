/**
 * @fileoverview Read My Mind predictor: isolated one-shot provider execution
 * over the assembled prediction context (docs/readmymind-plan.md).
 *
 * Reuses the AiCheckerBase spawn mechanics (prompt file to dodge E2BIG, a
 * throwaway detached tmux session, done-marker polling, timeout, shell-safety
 * validation) but stays standalone: the base class is verdict-shaped
 * (positive/negative/cooldown) and prediction is freeform JSON, so subclassing
 * would abuse `reasoning` as a payload.
 *
 * The predictor is deliberately dumb, text in / JSON out; all intelligence
 * about WHAT to include lives in the testable assembler
 * (`readmymind-context.ts`). Output parsing (`parsePredictionOutput`) is pure
 * and strict: garbage output is a clean error, never a half-suggestion, and
 * suggestion prompts are collapsed to single lines server-side (multi-line
 * breaks Ink).
 *
 * Exported as a mutable singleton (`readMyMindPredictor`) so route tests can
 * stub `predict` without spawning anything.
 */

import { execSync, spawn as childSpawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isValidModelName, isValidMuxName } from './ai-checker-base.js';
import { getAugmentedPath } from './utils/index.js';
import { getErrorMessage } from './types.js';

// ========== Contract ==========

export type SuggestionKind = 'continue' | 'verify' | 'redirect';

export interface ReadMyMindSuggestion {
  /** The proposed next prompt: single line, bounded. */
  prompt: string;
  /** One-sentence rationale. */
  why: string;
  kind: SuggestionKind;
}

export interface PredictionResult {
  suggestions: ReadMyMindSuggestion[];
  durationMs: number;
}

/** Opus headroom over a ~30 KB prompt (decided in the design doc). */
export const READMYMIND_TIMEOUT_MS = 90_000;

const MAX_SUGGESTION_CHARS = 1_000;
const MAX_WHY_CHARS = 300;
const DONE_MARKER = '__RMM_DONE__';
const POLL_INTERVAL_MS = 500;
const CODEX_OUTPUT_POLL_INTERVAL_MS = 25;
const CODEX_STREAM_LIMIT_BYTES = 256 * 1024;
const CODEX_FINAL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const CODEX_KILL_GRACE_MS = 250;

const CODEX_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'why', 'kind'],
        properties: {
          prompt: { type: 'string' },
          why: { type: 'string' },
          kind: { type: 'string', enum: ['continue', 'verify', 'redirect'] },
        },
      },
    },
  },
};

/** Lenient on extra keys (zod strips unknowns), strict on shape. */
const SuggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        prompt: z.string(),
        why: z.string().optional(),
        kind: z.enum(['continue', 'verify', 'redirect']),
      })
    )
    .min(1)
    .max(3),
});

/** Collapse to one line: embedded newlines break Ink's composer. */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * Parse the model's raw output into validated suggestions. Strict by design:
 * anything that does not contain the JSON contract is an Error, never a
 * half-suggestion. Tolerates fenced/prosed wrapping by extracting the
 * outermost object literal before parsing.
 */
export function parsePredictionOutput(raw: string): ReadMyMindSuggestion[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Predictor returned no JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Predictor returned malformed JSON');
  }

  const result = SuggestionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Predictor output did not match the suggestions contract');
  }

  const suggestions = result.data.suggestions
    .map((s) => ({
      prompt: singleLine(s.prompt).slice(0, MAX_SUGGESTION_CHARS),
      why: singleLine(s.why ?? '').slice(0, MAX_WHY_CHARS),
      kind: s.kind,
    }))
    .filter((s) => s.prompt.length > 0);

  if (suggestions.length === 0) {
    throw new Error('Predictor returned only empty suggestions');
  }
  return suggestions;
}

// ========== Spawn/poll runner ==========

export interface PredictOptions {
  /** Codeman session id; only its first 8 chars name the throwaway tmux session. */
  sessionId: string;
  /** The assembled context prompt (readmymind-context.ts). */
  prompt: string;
  /** Explicit provider selected from the authorized server-side session. */
  provider: ReadMyMindProvider;
  timeoutMs?: number;
}

export interface CodexProviderEnvironment {
  CODEX_HOME?: string;
  OPENAI_API_KEY?: string;
  CODEX_API_KEY?: string;
}

export type ReadMyMindProvider =
  | { kind: 'claude'; model: string }
  | { kind: 'codex'; model?: string; env: Readonly<CodexProviderEnvironment> };

async function runClaudePrediction(options: PredictOptions & { provider: { kind: 'claude'; model: string } }) {
  const { sessionId, prompt } = options;
  const { model } = options.provider;
  const timeoutMs = options.timeoutMs ?? READMYMIND_TIMEOUT_MS;

  if (!isValidModelName(model)) {
    throw new Error(`Invalid model name: ${String(model).substring(0, 50)}`);
  }

  const shortId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'rmm';
  const timestamp = Date.now();
  const outFile = join(tmpdir(), `codeman-rmm-${shortId}-${timestamp}.txt`);
  const stderrFile = join(tmpdir(), `codeman-rmm-stderr-${shortId}-${timestamp}.txt`);
  const promptFile = join(tmpdir(), `codeman-rmm-prompt-${shortId}-${timestamp}.txt`);
  const muxName = `codeman-rmm-${shortId}`;
  if (!isValidMuxName(muxName)) {
    throw new Error(`Invalid mux name generated: ${muxName.substring(0, 50)}`);
  }

  writeFileSync(outFile, '');
  writeFileSync(stderrFile, '');
  // Prompt via file + stdin: ~30 KB exceeds argv comfort (E2BIG).
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  const modelArg = `--model "${model.replace(/"/g, '\\"')}"`;
  const claudeCmd = `cat "${promptFile}" | claude -p ${modelArg} --output-format text`;
  const fullCmd = `export PATH="${getAugmentedPath()}"; ${claudeCmd} > "${outFile}" 2> "${stderrFile}"; echo "${DONE_MARKER}" >> "${outFile}"; rm -f "${promptFile}"`;

  const startTime = Date.now();
  let pollTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const cleanup = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    pollTimer = null;
    timeoutTimer = null;
    try {
      execSync(`tmux kill-session -t "${muxName}" 2>/dev/null`, { timeout: 2000 });
    } catch {
      // Session already gone.
    }
    for (const file of [outFile, stderrFile, promptFile]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  try {
    try {
      execSync(`tmux kill-session -t "${muxName}" 2>/dev/null`, { timeout: 3000 });
    } catch {
      // No leftover session: fine.
    }
    const muxProcess = childSpawn('tmux', ['new-session', '-d', '-s', muxName, 'bash', '-c', fullCmd], {
      detached: true,
      stdio: 'ignore',
    });
    muxProcess.unref();
  } catch (err) {
    cleanup();
    throw new Error(`Failed to spawn prediction tmux session: ${getErrorMessage(err)}`);
  }

  return new Promise<PredictionResult>((resolve, reject) => {
    let settled = false;

    pollTimer = setInterval(() => {
      if (settled) return;
      try {
        if (!existsSync(outFile)) return;
        const content = readFileSync(outFile, 'utf-8');
        if (!content.includes(DONE_MARKER)) return;
        settled = true;
        const durationMs = Date.now() - startTime;
        const output = content.replace(DONE_MARKER, '').trim();
        if (!output) {
          const stderr = readStderr(stderrFile);
          cleanup();
          reject(new Error(`Predictor produced no output${stderr ? `: ${stderr}` : ''}`));
          return;
        }
        try {
          const suggestions = parsePredictionOutput(output);
          cleanup();
          resolve({ suggestions, durationMs });
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(getErrorMessage(err)));
        }
      } catch {
        // Output file mid-write or already removed: keep polling.
      }
    }, POLL_INTERVAL_MS);

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Prediction timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function buildCodexEnvironment(providerEnv: Readonly<CodexProviderEnvironment>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: getAugmentedPath() };
  const runtimeKeys = [
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
  ] as const;
  for (const key of runtimeKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  const providerKeys = ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const;
  for (const key of providerKeys) {
    const value = providerEnv[key] !== undefined ? providerEnv[key] : process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isMissingExecutableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function classifyCodexExit(stderr: string): Error {
  const rejectsRequiredIsolation =
    /(?:unexpected|unknown|unrecognized|unsupported|invalid)\s+(?:argument|option|flag)/i.test(stderr) ||
    /(?:unknown|unrecognized|unsupported|invalid)\s+(?:configuration|config)\s+(?:key|field|option)/i.test(stderr) ||
    /(?:unknown|unrecognized|unsupported)\s+(?:field|key)\b/i.test(stderr) ||
    /strict[-_ ]config[^\n]*(?:unknown|unrecognized|unsupported|invalid)/i.test(stderr);
  if (rejectsRequiredIsolation) {
    return new Error('The installed Codex CLI must be updated before Read My Mind can run safely.');
  }
  return new Error('Codex prediction failed; check Codex authentication or configuration.');
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The detached group has already exited.
  }
}

function readBoundedCodexOutput(outputFile: string): string {
  const buffer = Buffer.alloc(CODEX_FINAL_OUTPUT_LIMIT_BYTES + 1);
  const fd = openSync(outputFile, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(fd);
  }
  if (bytesRead > CODEX_FINAL_OUTPUT_LIMIT_BYTES) {
    throw new Error('Codex prediction exceeded the output limit.');
  }
  return buffer.toString('utf8', 0, bytesRead).trim();
}

async function runCodexPrediction(
  options: PredictOptions & { provider: { kind: 'codex'; model?: string; env: Readonly<CodexProviderEnvironment> } }
): Promise<PredictionResult> {
  const { prompt, provider } = options;
  const timeoutMs = options.timeoutMs ?? READMYMIND_TIMEOUT_MS;
  if (provider.model !== undefined && !isValidModelName(provider.model)) {
    throw new Error(`Invalid model name: ${String(provider.model).substring(0, 50)}`);
  }

  const privateDir = mkdtempSync(join(tmpdir(), 'codeman-rmm-codex-'));
  const schemaFile = join(privateDir, 'schema.json');
  const outputFile = join(privateDir, 'output.json');
  try {
    chmodSync(privateDir, 0o700);
    writeFileSync(schemaFile, JSON.stringify(CODEX_OUTPUT_SCHEMA), { mode: 0o600 });
    writeFileSync(outputFile, '', { mode: 0o600 });
  } catch {
    rmSync(privateDir, { recursive: true, force: true });
    throw new Error('Codex prediction could not create its private workspace.');
  }

  const args = [
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
    schemaFile,
    '--output-last-message',
    outputFile,
    '--cd',
    privateDir,
  ];
  if (provider.model !== undefined) args.push('--model', provider.model);
  args.push('-');

  const startTime = Date.now();
  let child: ChildProcess;
  try {
    child = childSpawn('codex', args, {
      cwd: privateDir,
      detached: true,
      env: buildCodexEnvironment(provider.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    rmSync(privateDir, { recursive: true, force: true });
    if (isMissingExecutableError(error)) {
      throw new Error('Codex CLI is unavailable; install Codex and restart Codeman.');
    }
    throw new Error('Codex prediction could not start; check Codex authentication or configuration.');
  }

  return new Promise<PredictionResult>((resolve, reject) => {
    let settled = false;
    let aborting = false;
    let abortError: Error | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrChunks: Buffer[] = [];
    let timeoutTimer: NodeJS.Timeout | null = null;
    let outputPollTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (outputPollTimer) clearInterval(outputPollTimer);
      if (killTimer) clearTimeout(killTimer);
      timeoutTimer = null;
      outputPollTimer = null;
      killTimer = null;
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdin?.removeListener('error', onStdinError);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      try {
        rmSync(privateDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup, matching the existing Claude runner.
      }
    };

    const finish = (error: Error | null, result?: PredictionResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result as PredictionResult);
    };

    const abort = (error: Error): void => {
      if (settled || aborting) return;
      aborting = true;
      abortError = error;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (outputPollTimer) clearInterval(outputPollTimer);
      timeoutTimer = null;
      outputPollTimer = null;
      terminateProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        terminateProcessGroup(child, 'SIGKILL');
        finish(error);
      }, CODEX_KILL_GRACE_MS);
    };

    function onStdout(chunk: Buffer | string): void {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > CODEX_STREAM_LIMIT_BYTES) {
        abort(new Error('Codex prediction exceeded the output limit.'));
      }
    }

    function onStderr(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrBytes > CODEX_STREAM_LIMIT_BYTES) {
        abort(new Error('Codex prediction exceeded the output limit.'));
        return;
      }
      stderrChunks.push(buffer);
    }

    function onStdinError(): void {
      // The exit/error handler owns the public classification.
    }

    function onError(error: Error): void {
      if (isMissingExecutableError(error)) {
        finish(new Error('Codex CLI is unavailable; install Codex and restart Codeman.'));
      } else {
        finish(new Error('Codex prediction could not start; check Codex authentication or configuration.'));
      }
    }

    function onClose(code: number | null): void {
      if (settled) return;
      if (aborting) {
        finish(abortError ?? new Error('Codex prediction failed.'));
        return;
      }
      if (code !== 0) {
        finish(classifyCodexExit(Buffer.concat(stderrChunks).toString('utf8')));
        return;
      }

      try {
        if (statSync(outputFile).size > CODEX_FINAL_OUTPUT_LIMIT_BYTES) {
          finish(new Error('Codex prediction exceeded the output limit.'));
          return;
        }
        const raw = readBoundedCodexOutput(outputFile);
        if (!raw) {
          finish(new Error('Codex prediction returned no output.'));
          return;
        }
        const suggestions = parsePredictionOutput(raw);
        finish(null, { suggestions, durationMs: Date.now() - startTime });
      } catch (error) {
        if (error instanceof Error && error.message === 'Codex prediction exceeded the output limit.') {
          finish(error);
        } else {
          finish(new Error('Codex prediction returned invalid output.'));
        }
      }
    }

    child.once('error', onError);
    child.once('close', onClose);
    child.stdin?.on('error', onStdinError);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    outputPollTimer = setInterval(() => {
      if (settled || aborting) return;
      try {
        if (statSync(outputFile).size > CODEX_FINAL_OUTPUT_LIMIT_BYTES) {
          abort(new Error('Codex prediction exceeded the output limit.'));
        }
      } catch {
        // The child may atomically replace the output; close handling validates it.
      }
    }, CODEX_OUTPUT_POLL_INTERVAL_MS);
    timeoutTimer = setTimeout(() => {
      abort(new Error(`Codex prediction timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdin?.end(prompt);
  });
}

async function runPrediction(options: PredictOptions): Promise<PredictionResult> {
  if (options.provider.kind === 'claude') {
    return runClaudePrediction(options as PredictOptions & { provider: { kind: 'claude'; model: string } });
  }
  return runCodexPrediction(
    options as PredictOptions & {
      provider: { kind: 'codex'; model?: string; env: Readonly<CodexProviderEnvironment> };
    }
  );
}

function readStderr(stderrFile: string): string {
  try {
    return existsSync(stderrFile) ? readFileSync(stderrFile, 'utf-8').trim().substring(0, 200) : '';
  } catch {
    return '';
  }
}

/**
 * Mutable singleton: routes call `readMyMindPredictor.predict(...)`; tests
 * stub the property (`vi.spyOn(readMyMindPredictor, 'predict')`).
 */
export const readMyMindPredictor = {
  predict: runPrediction,
};
