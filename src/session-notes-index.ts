/** @fileoverview Rebuildable notebook search and source-preserving Markdown checklist operations. */
import type { SessionNoteEntry } from './types/session-notes.js';

export class SessionNotesInputError extends Error {}

export interface SessionNotesFilter {
  q?: string;
  projectId?: string;
  sessionId?: string;
  unfinished?: boolean;
}
export interface ChecklistItem {
  line: number;
  checked: boolean;
  text: string;
  markerOffset: number;
}
/** Recognize task-list markers outside CommonMark fenced code, retaining byte-equivalent JS offsets. */
export function checklistItems(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  let fence: { marker: string; length: number } | undefined;
  let offset = 0;
  for (const [index, raw] of markdown.split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    const candidate = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (candidate && candidate[1][0] === fence.marker && candidate[1].length >= fence.length && !candidate[2].trim())
        fence = undefined;
    } else if (candidate && (candidate[1][0] !== '`' || !candidate[2].includes('`'))) {
      fence = { marker: candidate[1][0], length: candidate[1].length };
    } else {
      const task = /^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\](?:\s+|$))(.*)$/.exec(line);
      if (task)
        items.push({ line: index + 1, checked: task[2] !== ' ', text: task[4], markerOffset: offset + task[1].length });
    }
    offset += raw.length + 1;
  }
  return items;
}
export function setChecklistItem(markdown: string, line: number, checked: boolean): string {
  const item = checklistItems(markdown).find((candidate) => candidate.line === line);
  if (!item) throw new SessionNotesInputError('Checklist item not found');
  return markdown.slice(0, item.markerOffset) + (checked ? 'x' : ' ') + markdown.slice(item.markerOffset + 1);
}
export function filterSessionNotes(entries: SessionNoteEntry[], filter: SessionNotesFilter): SessionNoteEntry[] {
  const query = filter.q?.toLocaleLowerCase();
  return entries.filter((entry) => {
    if (filter.projectId && filter.projectId !== entry.projectId) return false;
    const note = entry.note;
    if (!note) return !query && !filter.sessionId && !filter.unfinished;
    if (
      filter.sessionId &&
      ![note.metadata.sessionId, ...note.metadata.sessionAliases, ...(entry.sessionAliases ?? [])].includes(
        filter.sessionId
      )
    )
      return false;
    if (query && !(note.metadata.title + '\n' + note.markdown).toLocaleLowerCase().includes(query)) return false;
    if (filter.unfinished && !checklistItems(note.markdown).some((item) => !item.checked)) return false;
    return true;
  });
}
