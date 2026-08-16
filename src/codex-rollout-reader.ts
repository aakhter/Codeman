/**
 * @fileoverview Shared Codex rollout parsing for the response viewer and Read My Mind.
 *
 * Rollout selection intentionally lives in `checkpoint-conversation-identity.ts`.
 * This module only parses already-resolved rollout data or reads a supplied path.
 */

import { open, stat } from 'node:fs/promises';
import type { PredictionToolCall } from './readmymind-context.js';
import { MAX_READMYMIND_ASSISTANT_CHARS } from './readmymind-signal-limits.js';
import { summarizeReadMyMindToolInput } from './readmymind-tool-summary.js';

/** Read My Mind only needs the append-only end of a resolved rollout. */
export const CODEX_ROLLOUT_TAIL_BYTES = 256 * 1024;
export const MAX_CODEX_ROLLOUT_TOOLS = 10;

export interface CodexRolloutMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface CodexRolloutSignals {
  lastAssistantText: string | null;
  recentPrompts: Array<{ text: string; timestamp?: string }>;
  recentTools: PredictionToolCall[];
}

export interface CodexRolloutParseResult {
  lastAssistantText: string;
  lastAssistantTimestamp: string;
  messages: CodexRolloutMessage[];
  signals: CodexRolloutSignals;
}

/** Select only the projections a caller needs while sharing one parser. */
export interface CodexRolloutParseOptions {
  includeMessages?: boolean;
  includeSignals?: boolean;
}

interface RolloutPayload {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  message?: unknown;
  images?: unknown;
  local_images?: unknown;
  name?: unknown;
  arguments?: unknown;
  input?: unknown;
}

interface RolloutEntry {
  timestamp?: unknown;
  type?: unknown;
  payload?: RolloutPayload;
}

/** Excludes Codex-injected context from user-turn projections. */
export function isCodexInjectedContext(text: string): boolean {
  return (
    /^# AGENTS\.md instructions\b/i.test(text) ||
    /^<environment_context\b/i.test(text) ||
    /^<turn_aborted\b/i.test(text) ||
    /^<codex_internal_context\b/i.test(text) ||
    /^<recommended_plugins\b/i.test(text) ||
    /^<user_instructions\b/i.test(text) ||
    /^# Options\b/i.test(text)
  );
}

function extractCodexBlockText(content: unknown, kinds: string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        kinds.includes((block as { type?: unknown }).type as string) &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
    .join('\n\n');
}

function toolInput(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse Codex JSONL records into response-viewer history and Read My Mind
 * signals. It is pure so fixture tests can cover modern, legacy, and partial
 * rollout records without selecting a rollout file.
 */
export function parseCodexRollout(
  lines: Iterable<string>,
  { includeMessages = true, includeSignals = true }: CodexRolloutParseOptions = {}
): CodexRolloutParseResult {
  let lastAssistantText = '';
  let lastAssistantTimestamp = '';
  const messages: CodexRolloutMessage[] = [];
  const recentPrompts: Array<{ text: string; timestamp?: string }> = [];
  // A legacy user row may only be the twin of a preceding modern event in the
  // same turn. Clearing this map at assistant/new-user boundaries prevents a
  // later event with identical text from deleting older legacy history.
  const pendingModernUserTexts = new Map<string, number>();
  const tools: PredictionToolCall[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: RolloutEntry;
    try {
      entry = JSON.parse(line) as RolloutEntry;
    } catch {
      continue;
    }
    const payload = entry.payload;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    if (!payload || typeof entry.type !== 'string' || typeof payload.type !== 'string') continue;

    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      const prompt = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (prompt && isCodexInjectedContext(prompt)) continue;
      pendingModernUserTexts.clear();
      if (prompt) pendingModernUserTexts.set(prompt, 1);
      const imageCount =
        (Array.isArray(payload.images) ? payload.images.length : 0) +
        (Array.isArray(payload.local_images) ? payload.local_images.length : 0);
      const text =
        imageCount > 0 ? (prompt ? `${prompt}\n\n*[image ×${imageCount}]*` : `*[image ×${imageCount}]*`) : prompt;
      if (text && includeMessages) messages.push({ role: 'user', text, timestamp });
      if (prompt && includeSignals) recentPrompts.push({ text: prompt, timestamp });
      continue;
    }

    if (entry.type !== 'response_item') continue;
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      if (includeSignals && typeof payload.name === 'string' && payload.name) {
        const input = toolInput(payload.arguments) ?? toolInput(payload.input);
        tools.push({ name: payload.name, detail: summarizeReadMyMindToolInput(input) });
        if (tools.length > MAX_CODEX_ROLLOUT_TOOLS) tools.shift();
      }
      continue;
    }
    if (payload.type !== 'message' || typeof payload.role !== 'string') continue;

    if (payload.role === 'assistant') {
      const text = extractCodexBlockText(payload.content, ['output_text', 'text']);
      if (!text) continue;
      pendingModernUserTexts.clear();
      lastAssistantText = text;
      lastAssistantTimestamp = timestamp ?? '';
      if (includeMessages) messages.push({ role: 'assistant', text, timestamp });
    } else if (payload.role === 'user') {
      const text = extractCodexBlockText(payload.content, ['input_text', 'text']).trim();
      if (!text || isCodexInjectedContext(text)) continue;
      const matchingModernTurns = pendingModernUserTexts.get(text) || 0;
      if (matchingModernTurns > 0) {
        if (matchingModernTurns === 1) pendingModernUserTexts.delete(text);
        else pendingModernUserTexts.set(text, matchingModernTurns - 1);
        continue;
      }
      if (includeMessages) messages.push({ role: 'user', text, timestamp });
      if (includeSignals) recentPrompts.push({ text, timestamp });
    }
  }

  return {
    lastAssistantText,
    lastAssistantTimestamp,
    messages,
    signals: {
      lastAssistantText:
        includeSignals && lastAssistantText ? lastAssistantText.slice(0, MAX_READMYMIND_ASSISTANT_CHARS) : null,
      recentPrompts,
      recentTools: tools,
    },
  };
}

/**
 * Tail-read Read My Mind signals from an already-resolved rollout path. This
 * never discovers or selects rollout files, and partial first records are
 * discarded when the bounded read starts mid-file.
 */
export async function readCodexRolloutSignals(rolloutPath: string): Promise<CodexRolloutSignals | null> {
  let handle;
  try {
    const info = await stat(rolloutPath);
    const offset = Math.max(0, info.size - CODEX_ROLLOUT_TAIL_BYTES);
    const length = info.size - offset;
    if (length <= 0) return { lastAssistantText: null, recentPrompts: [], recentTools: [] };

    handle = await open(rolloutPath, 'r');
    let startsMidRecord = false;
    if (offset > 0) {
      const precedingByte = Buffer.alloc(1);
      const { bytesRead } = await handle.read(precedingByte, 0, 1, offset - 1);
      startsMidRecord = bytesRead === 1 && precedingByte[0] !== 0x0a;
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (startsMidRecord) lines.shift();
    return parseCodexRollout(lines, { includeMessages: false }).signals;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
