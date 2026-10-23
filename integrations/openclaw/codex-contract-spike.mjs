/** Read-only phase-0 format probe, not the durable request observer. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function inspectCodexContract(jsonl, expected) {
  const lines = jsonl.split('\n');
  lines.pop();
  let rows;
  try {
    rows = lines.filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return { supported: false, reason: 'malformed_record' };
  }
  const meta = rows.filter((r) => r.type === 'session_meta');
  if (
    meta.length !== 1 ||
    meta[0].payload?.id !== expected.conversationId ||
    meta[0].payload?.originator !== expected.originator
  )
    return { supported: false, reason: 'conversation_mismatch' };
  const events = rows.filter((r) => r.type === 'event_msg').map((r) => r.payload);
  const starts = events.filter((p) => p?.type === 'task_started');
  if (starts.length !== 1 || !starts[0].turn_id) return { supported: false, reason: 'ambiguous_turn' };
  const turnId = starts[0].turn_id;
  const items = events.filter((p) => p?.type === 'item_completed');
  if (items.some((p) => p.turn_id !== turnId || p.thread_id !== expected.conversationId))
    return { supported: false, reason: 'interleaved_identity' };
  const users = items.filter((p) => p.item?.type === 'UserMessage');
  if (
    users.length !== 1 ||
    users[0].item.content?.map((c) => (c.type === 'text' ? c.text : '')).join('') !== expected.prompt
  )
    return { supported: false, reason: 'acceptance_unproven' };
  const finals = items.filter((p) => p.item?.type === 'AgentMessage' && p.item.phase === 'final_answer');
  const completions = events.filter((p) => p?.type === 'task_complete');
  const text =
    finals.length === 1 ? finals[0].item.content?.map((c) => (c.type === 'Text' ? c.text : '')).join('') : undefined;
  const completed = Boolean(
    text &&
    completions.length === 1 &&
    completions[0].turn_id === turnId &&
    completions[0].last_agent_message === text &&
    events.indexOf(completions[0]) > events.indexOf(finals[0]) &&
    events.indexOf(finals[0]) > events.indexOf(users[0])
  );
  return { supported: true, accepted: true, completed, turnId, finalPhase: finals[0]?.item.phase };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, conversationId, originator, prompt] = process.argv.slice(2);
  console.log(JSON.stringify(inspectCodexContract(readFileSync(file, 'utf8'), { conversationId, originator, prompt })));
}
