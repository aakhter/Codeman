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

interface ParsedMessage extends CodexRolloutMessage {
  legacyUser?: boolean;
  textForPrompt?: string;
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
export function parseCodexRollout(lines: Iterable<string>): CodexRolloutParseResult {
  let lastAssistantText = '';
  let lastAssistantTimestamp = '';
  const messages: ParsedMessage[] = [];
  const eventUserTexts = new Map<string, number>();
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
      if (prompt) eventUserTexts.set(prompt, (eventUserTexts.get(prompt) || 0) + 1);
      const imageCount =
        (Array.isArray(payload.images) ? payload.images.length : 0) +
        (Array.isArray(payload.local_images) ? payload.local_images.length : 0);
      const text =
        imageCount > 0 ? (prompt ? `${prompt}\n\n*[image ×${imageCount}]*` : `*[image ×${imageCount}]*`) : prompt;
      if (text) messages.push({ role: 'user', text, timestamp, textForPrompt: prompt || undefined });
      continue;
    }

    if (entry.type !== 'response_item') continue;
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      if (typeof payload.name === 'string' && payload.name) {
        const input = toolInput(payload.arguments) ?? toolInput(payload.input);
        tools.push({ name: payload.name, detail: summarizeReadMyMindToolInput(input) });
      }
      continue;
    }
    if (payload.type !== 'message' || typeof payload.role !== 'string') continue;

    if (payload.role === 'assistant') {
      const text = extractCodexBlockText(payload.content, ['output_text', 'text']);
      if (!text) continue;
      lastAssistantText = text;
      lastAssistantTimestamp = timestamp ?? '';
      messages.push({ role: 'assistant', text, timestamp });
    } else if (payload.role === 'user') {
      const text = extractCodexBlockText(payload.content, ['input_text', 'text']).trim();
      if (text && !isCodexInjectedContext(text)) {
        messages.push({ role: 'user', text, timestamp, legacyUser: true, textForPrompt: text });
      }
    }
  }

  const thread = messages.filter((message) => {
    if (!message.legacyUser) return true;
    const matchingModernTurns = eventUserTexts.get(message.textForPrompt ?? '') || 0;
    if (matchingModernTurns === 0) return true;
    eventUserTexts.set(message.textForPrompt ?? '', matchingModernTurns - 1);
    return false;
  });

  return {
    lastAssistantText,
    lastAssistantTimestamp,
    messages: thread.map(({ role, text, timestamp }) => ({ role, text, timestamp })),
    signals: {
      lastAssistantText: lastAssistantText ? lastAssistantText.slice(0, MAX_READMYMIND_ASSISTANT_CHARS) : null,
      recentPrompts: thread
        .filter((message) => message.role === 'user' && Boolean(message.textForPrompt))
        .map((message) => ({ text: message.textForPrompt!, timestamp: message.timestamp })),
      recentTools: tools.slice(-MAX_CODEX_ROLLOUT_TOOLS),
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
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (offset > 0) lines.shift();
    return parseCodexRollout(lines).signals;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
