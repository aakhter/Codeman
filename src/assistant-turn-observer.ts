/** Exact native Codex turn projection. Idle timers and viewer text are never completion evidence. */
export type TurnObservation =
  | { state: 'waiting' }
  | { state: 'running'; turnId: string }
  | { state: 'completed'; turnId: string; text: string }
  | { state: 'unknown'; reason: string };

export function observeAssistantTurn(jsonl: string, conversationId: string, prompt: string): TurnObservation {
  const lines = jsonl.split('\n');
  lines.pop(); // Only fully flushed records are evidence.
  let rows: Array<{ type?: string; payload?: Record<string, unknown> }>;
  try {
    rows = lines.filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return { state: 'unknown', reason: 'Malformed transcript record' };
  }
  const events = rows.filter((row) => row.type === 'event_msg').map((row) => row.payload ?? {});
  const starts = events.filter((p) => p.type === 'task_started');
  if (starts.length > 1) return { state: 'unknown', reason: 'Unexpected concurrent or desktop turn' };
  if (!starts.length)
    return events.some((p) => p.type === 'item_completed' || p.type === 'task_complete')
      ? { state: 'unknown', reason: 'Missing native turn start' }
      : { state: 'waiting' };
  const turnId = starts[0].turn_id;
  if (typeof turnId !== 'string' || !turnId) return { state: 'unknown', reason: 'Unsupported native turn identity' };
  const items = events.filter((p) => p.type === 'item_completed');
  if (items.some((p) => p.turn_id !== turnId || p.thread_id !== conversationId))
    return { state: 'unknown', reason: 'Transcript identity changed' };
  const item = (p: Record<string, unknown>) =>
    p.item as { type?: string; phase?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  const users = items.filter((p) => item(p)?.type === 'UserMessage');
  if (!users.length) return { state: 'waiting' };
  if (
    users.length !== 1 ||
    events.indexOf(users[0]) < events.indexOf(starts[0]) ||
    item(users[0])?.content?.some((c) => c.type !== 'text' || typeof c.text !== 'string') ||
    item(users[0])
      ?.content?.map((c) => c.text)
      .join('') !== prompt
  )
    return { state: 'unknown', reason: 'Prompt acceptance does not match this request' };
  const finals = items.filter((p) => item(p)?.type === 'AgentMessage' && item(p)?.phase === 'final_answer');
  const completions = events.filter((p) => p.type === 'task_complete');
  if (events.some((p) => ['task_aborted', 'turn_aborted', 'task_interrupted'].includes(String(p.type))))
    return { state: 'unknown', reason: 'Native turn was interrupted' };
  if (finals.length > 1 || completions.length > 1) return { state: 'unknown', reason: 'Ambiguous completion' };
  if (!completions.length) return { state: 'running', turnId };
  const final = finals[0];
  const text =
    final && item(final)?.content?.every((c) => c.type === 'Text' && typeof c.text === 'string')
      ? item(final)
          ?.content?.map((c) => c.text)
          .join('')
      : undefined;
  if (
    !text ||
    text.length > 1000000 ||
    completions[0].turn_id !== turnId ||
    completions[0].last_agent_message !== text ||
    events.indexOf(completions[0]) < events.indexOf(final) ||
    events.indexOf(final) < events.indexOf(users[0])
  )
    return { state: 'unknown', reason: 'Unsupported or mismatched final completion' };
  return { state: 'completed', turnId, text };
}

interface ClaudeRow {
  type?: string;
  subtype?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  error?: unknown;
  message?: { id?: string; content?: string | Array<{ type?: string; text?: string }>; stop_reason?: string };
}
function nativeRows<T>(jsonl: string): T[] | undefined {
  const lines = jsonl.split('\n');
  lines.pop();
  try {
    return lines.filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch {
    return undefined;
  }
}
function claudePrompt(row: ClaudeRow): string | undefined {
  if (row.type !== 'user' || row.isMeta || row.isSidechain) return undefined;
  const content = row.message?.content;
  if (typeof content === 'string') {
    // Claude serializes a terminal paste using a paired native wrapper. Compare
    // its entire enclosed text; never accept a substring or arbitrary markup.
    const pasted = content.match(/^\n\n<pasted_content id="([0-9a-f]+)">\n([\s\S]*)\n<\/pasted_content id="\1">\n$/);
    return pasted ? pasted[2] : content;
  }
  if (Array.isArray(content) && content.length && content.every((p) => p.type === 'text' && typeof p.text === 'string'))
    return content.map((p) => p.text).join('');
  return undefined;
}
/** Claude's user UUID, parent chain, final model stop and native turn_duration prove a turn. */
export function observeClaudeAssistantTurn(jsonl: string, conversationId: string, prompt: string): TurnObservation {
  const parsed = nativeRows<ClaudeRow>(jsonl);
  if (!parsed) return { state: 'unknown', reason: 'Malformed Claude transcript record' };
  const rows = parsed.filter((r) => !r.isSidechain);
  if (
    rows.some(
      (r) =>
        ['user', 'assistant', 'system', 'attachment'].includes(r.type ?? '') &&
        r.sessionId &&
        r.sessionId !== conversationId
    )
  )
    return { state: 'unknown', reason: 'Claude conversation identity changed' };
  const users = rows.filter((r) => claudePrompt(r) !== undefined);
  if (!users.length)
    return rows.some((r) => r.type === 'assistant')
      ? { state: 'unknown', reason: 'Missing Claude prompt acceptance' }
      : { state: 'waiting' };
  if (
    users.length !== 1 ||
    claudePrompt(users[0]) !== prompt ||
    !users[0].uuid ||
    users[0].sessionId !== conversationId
  )
    return { state: 'unknown', reason: 'Claude prompt acceptance does not match this request' };
  const user = users[0],
    turnId = user.uuid!,
    chain = new Set([turnId]);
  let final: ClaudeRow | undefined;
  for (const r of rows.slice(rows.indexOf(user) + 1)) {
    if (['assistant', 'user', 'attachment'].includes(r.type ?? '') || (r.type === 'system' && r.parentUuid)) {
      if (
        (r.type !== 'system' && !r.uuid) ||
        !r.parentUuid ||
        !chain.has(r.parentUuid) ||
        r.sessionId !== conversationId
      )
        return { state: 'unknown', reason: 'Claude native parent chain changed' };
      if (r.uuid) chain.add(r.uuid);
    }
    if (r.type === 'assistant') {
      if (r.isApiErrorMessage || r.error) return { state: 'unknown', reason: 'Claude native response failed' };
      if (['end_turn', 'stop_sequence'].includes(r.message?.stop_reason ?? '')) final = r;
    }
  }
  const completions = rows.filter((r) => r.type === 'system' && r.subtype === 'turn_duration');
  if (completions.length > 1) return { state: 'unknown', reason: 'Ambiguous Claude native completion' };
  if (!completions.length) return { state: 'running', turnId };
  if (!final || rows.indexOf(completions[0]) < rows.indexOf(final) || !Array.isArray(final.message?.content))
    return { state: 'unknown', reason: 'Claude completion has no matching final answer' };
  const finalBlocks = rows.filter(
    (r) => r.type === 'assistant' && r.message?.id === final!.message?.id && r.message?.id
  );
  const text = (finalBlocks.length ? finalBlocks : [final])
    .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
  if (!text || text.length > 1000000) return { state: 'unknown', reason: 'Unsupported Claude final answer' };
  return { state: 'completed', turnId, text };
}
interface OpenCodeRow {
  type?: string;
  payload?: {
    id?: string;
    sessionID?: string;
    role?: string;
    parentID?: string;
    finish?: string;
    error?: unknown;
    time?: { created?: number; completed?: number };
    parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>;
  };
}
/** OpenCode's exact user message, assistant parentID and persisted finish/time.completed prove completion. */
export function observeOpenCodeAssistantTurn(jsonl: string, conversationId: string, prompt: string): TurnObservation {
  const rows = nativeRows<OpenCodeRow>(jsonl);
  if (!rows) return { state: 'unknown', reason: 'Malformed OpenCode native record' };
  const messages = rows.map((r) => r.payload);
  if (
    rows.some((r) => r.type !== 'opencode_message') ||
    messages.some((m) => !m?.id || m.sessionID !== conversationId || !Array.isArray(m.parts))
  )
    return { state: 'unknown', reason: 'OpenCode conversation identity changed' };
  const users = messages.filter((m) => m?.role === 'user');
  if (!users.length)
    return messages.length ? { state: 'unknown', reason: 'Missing OpenCode prompt acceptance' } : { state: 'waiting' };
  const user = users[0]!;
  if (
    users.length !== 1 ||
    user
      .parts!.filter((p) => p.type === 'text' && !p.synthetic)
      .map((p) => p.text ?? '')
      .join('') !== prompt
  )
    return { state: 'unknown', reason: 'OpenCode prompt acceptance does not match this request' };
  const turnId = user.id!,
    answers = messages.filter((m) => m?.role === 'assistant');
  if (answers.some((m) => m?.parentID !== turnId || m.error))
    return { state: 'unknown', reason: 'OpenCode response parent or native outcome changed' };
  if (messages.some((m) => m?.role !== 'user' && m?.role !== 'assistant'))
    return { state: 'unknown', reason: 'Unsupported OpenCode message role' };
  const final = answers.at(-1);
  if (!final || !final.time?.completed || !final.finish || ['tool-calls', 'unknown'].includes(final.finish))
    return { state: 'running', turnId };
  if (!['stop', 'end_turn'].includes(final.finish))
    return { state: 'unknown', reason: 'OpenCode native turn did not finish normally' };
  if (answers.some((m) => !m?.time?.completed) || final.time.completed < (user.time?.created ?? Infinity))
    return { state: 'unknown', reason: 'OpenCode native completion is ambiguous' };
  const text = final
    .parts!.filter((p) => p.type === 'text' && !p.synthetic)
    .map((p) => p.text ?? '')
    .join('');
  if (!text || text.length > 1000000) return { state: 'unknown', reason: 'Unsupported OpenCode final answer' };
  return { state: 'completed', turnId, text };
}

export function claudeAssistantReady(jsonl: string, conversationId: string): boolean {
  const rows = nativeRows<ClaudeRow>(jsonl);
  if (!rows) return false;
  const user = [...rows].reverse().find((r) => claudePrompt(r) !== undefined);
  if (!user) return !rows.some((r) => ['user', 'assistant'].includes(r.type ?? '') && !r.isSidechain);
  return (
    observeClaudeAssistantTurn(
      rows
        .slice(rows.indexOf(user))
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      conversationId,
      claudePrompt(user)!
    ).state === 'completed'
  );
}
export function openCodeAssistantReady(jsonl: string, conversationId: string): boolean {
  const rows = nativeRows<OpenCodeRow>(jsonl);
  if (!rows) return false;
  const user = [...rows].reverse().find((r) => r.payload?.role === 'user');
  if (!user) return !rows.length;
  const text = user.payload?.parts
    ?.filter((p) => p.type === 'text' && !p.synthetic)
    .map((p) => p.text ?? '')
    .join('');
  return (
    text !== undefined &&
    observeOpenCodeAssistantTurn(
      rows
        .slice(rows.indexOf(user))
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      conversationId,
      text
    ).state === 'completed'
  );
}
