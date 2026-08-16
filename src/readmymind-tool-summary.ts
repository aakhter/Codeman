/** Shared, deliberately narrow summaries of tool-call input for Read My Mind. */

const TOOL_DETAIL_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description'] as const;
const MAX_TOOL_DETAIL_CHARS = 80;

/** One-line argument summary for a tool call, e.g. `Edit src/foo.ts` or `Bash npm test`. */
export function summarizeReadMyMindToolInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of TOOL_DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL_DETAIL_CHARS);
    }
  }
  return undefined;
}
