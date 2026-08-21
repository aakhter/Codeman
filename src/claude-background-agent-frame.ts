export interface ClaudeVisibleFrameEvidence {
  source: string;
  claudeRuntimeVersion?: string;
  text: string;
}

export type ClaudeBackgroundAgentFrameResult =
  | { status: 'positive'; reason: 'matching_visible_renderer'; renderedCount: number }
  | {
      status: 'negative';
      reason:
        | 'untrusted_source'
        | 'unsupported_runtime_version'
        | 'non_positive_expected_count'
        | 'renderer_not_found'
        | 'renderer_not_in_bottom_region'
        | 'renderer_not_in_status_scaffold'
        | 'non_positive_count'
        | 'count_mismatch';
      renderedCount?: number;
    };

const SUPPORTED_RUNTIME_VERSION = '2.1.237';
const VISIBLE_FRAME_SOURCE = 'tmux_visible_frame';
const BOTTOM_REGION_ROWS = 12;
const RENDERER_PATTERN = /^\s*✳\s+Waiting for (\d+) background agents to finish\s*$/;
const SEPARATOR_PATTERN = /^\s*─{4,}\s*$/;
const EMPTY_COMPOSER_PATTERN = /^\s*❯\s*$/;
const TOKEN_COUNT_PATTERN = '(?:0|[1-9]\\d{0,2}(?:,\\d{3})*)';
const STATUS_PATTERN = new RegExp(
  `^\\s*(?:Fable|Opus|Sonnet|Haiku)\\s+\\d+(?:\\.\\d+)?` +
    `(?:\\s+\\(\\d+(?:\\.\\d+)?[kKmM]?\\s+context\\))?` +
    `\\s+in:${TOKEN_COUNT_PATTERN}\\s+out:${TOKEN_COUNT_PATTERN}\\s+ctx:(?:100|[1-9]?\\d)%\\s*$`
);

function hasObservedStatusScaffold(lines: readonly string[], rendererIndex: number): boolean {
  const following = lines.slice(rendererIndex + 1).filter((line) => line.trim().length > 0);
  return (
    following.length >= 4 &&
    SEPARATOR_PATTERN.test(following[0]) &&
    EMPTY_COMPOSER_PATTERN.test(following[1]) &&
    SEPARATOR_PATTERN.test(following[2]) &&
    STATUS_PATTERN.test(following[3])
  );
}

/** Evaluate only the verified renderer in a source-tagged current tmux frame. */
export function evaluateClaudeBackgroundAgentFrame(
  frame: ClaudeVisibleFrameEvidence,
  expectedWatcherLiveCount: number
): ClaudeBackgroundAgentFrameResult {
  if (frame.source !== VISIBLE_FRAME_SOURCE) return { status: 'negative', reason: 'untrusted_source' };
  if (frame.claudeRuntimeVersion !== SUPPORTED_RUNTIME_VERSION) {
    return { status: 'negative', reason: 'unsupported_runtime_version' };
  }
  if (!Number.isSafeInteger(expectedWatcherLiveCount) || expectedWatcherLiveCount <= 0) {
    return { status: 'negative', reason: 'non_positive_expected_count' };
  }

  const lines = frame.text.split(/\r?\n/);
  const bottomRegionStart = Math.max(0, lines.length - BOTTOM_REGION_ROWS);
  const hasRenderer = lines.some((line) => RENDERER_PATTERN.test(line));
  if (!hasRenderer) return { status: 'negative', reason: 'renderer_not_found' };

  let rendererIndex = -1;
  for (let index = lines.length - 1; index >= bottomRegionStart; index -= 1) {
    if (RENDERER_PATTERN.test(lines[index]) && hasObservedStatusScaffold(lines, index)) {
      rendererIndex = index;
      break;
    }
  }
  if (rendererIndex < 0) {
    const hasBottomRenderer = lines.slice(bottomRegionStart).some((line) => RENDERER_PATTERN.test(line));
    return {
      status: 'negative',
      reason: hasBottomRenderer ? 'renderer_not_in_status_scaffold' : 'renderer_not_in_bottom_region',
    };
  }

  const match = RENDERER_PATTERN.exec(lines[rendererIndex]);
  const renderedCount = Number(match?.[1]);
  if (!Number.isSafeInteger(renderedCount) || renderedCount <= 0) {
    return { status: 'negative', reason: 'non_positive_count', renderedCount };
  }
  if (renderedCount !== expectedWatcherLiveCount) {
    return { status: 'negative', reason: 'count_mismatch', renderedCount };
  }
  return { status: 'positive', reason: 'matching_visible_renderer', renderedCount };
}
