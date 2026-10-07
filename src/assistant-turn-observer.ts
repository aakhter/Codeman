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
