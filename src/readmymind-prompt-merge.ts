/** Pure prompt-history merge for local Codex Read My Mind context. */

import { sanitizePromptText } from './intent-store.js';
import type { CodexRolloutSignals } from './codex-rollout-reader.js';
import type { PredictionPromptEntry } from './readmymind-context.js';

const MAX_MERGED_PROMPTS = 20;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

export interface MergedReadMyMindPrompts {
  recentPrompts: PredictionPromptEntry[];
  /** Latest real source timestamp; synthetic placement for undated prompts never affects away context. */
  latestValidTimestamp?: number;
}

function parseIsoTimestamp(value: string | undefined): number | undefined {
  const match = value?.match(ISO_TIMESTAMP);
  if (!value || !match) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = '',
    zone,
    sign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(
    Number
  );
  const millisecond = Number(fraction.slice(0, 3).padEnd(3, '0'));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;

  const nominal = new Date(0);
  nominal.setUTCFullYear(year, month - 1, day);
  nominal.setUTCHours(hour, minute, second, millisecond);
  if (
    nominal.getUTCFullYear() !== year ||
    nominal.getUTCMonth() !== month - 1 ||
    nominal.getUTCDate() !== day ||
    nominal.getUTCHours() !== hour ||
    nominal.getUTCMinutes() !== minute ||
    nominal.getUTCSeconds() !== second
  ) {
    return undefined;
  }

  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  if (offsetHour > 23 || offsetMinute > 59) return undefined;
  const offsetDirection = zone === 'Z' || sign === '+' ? 1 : -1;
  const expected = nominal.getTime() - offsetDirection * (offsetHour * 60 + offsetMinute) * 60_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed === expected ? parsed : undefined;
}

/**
 * Merge persisted intent prompts with transient rollout prompts. Repeated text
 * is intentional evidence and remains repeated; this helper never writes back
 * to the intent store.
 */
export function mergeReadMyMindPrompts(
  intentPrompts: readonly PredictionPromptEntry[],
  rolloutPrompts: Readonly<CodexRolloutSignals['recentPrompts']>
): MergedReadMyMindPrompts {
  const entries: Array<{ ts?: number; text: string; order: number }> = [];
  let order = 0;

  for (const prompt of intentPrompts) {
    entries.push({
      ts: Number.isFinite(prompt.ts) ? prompt.ts : undefined,
      text: prompt.text,
      order: order++,
    });
  }
  for (const prompt of rolloutPrompts) {
    const text = sanitizePromptText(prompt.text);
    if (text === null) continue;
    entries.push({ ts: parseIsoTimestamp(prompt.timestamp), text, order: order++ });
  }

  const validTimestamps = entries.flatMap((entry) => (entry.ts === undefined ? [] : [entry.ts]));
  const latestValidTimestamp = validTimestamps.length > 0 ? Math.max(...validTimestamps) : undefined;
  const undatedTimestamp = latestValidTimestamp ?? 0;
  const recentPrompts = entries
    .sort((left, right) => (left.ts ?? undatedTimestamp) - (right.ts ?? undatedTimestamp) || left.order - right.order)
    .slice(-MAX_MERGED_PROMPTS)
    .map(({ ts, text }) => ({ ts: ts ?? undatedTimestamp, text }));

  return { recentPrompts, latestValidTimestamp };
}
