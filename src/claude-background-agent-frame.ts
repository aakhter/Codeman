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
        | 'non_positive_count'
        | 'count_mismatch';
      renderedCount?: number;
    };

const SUPPORTED_RUNTIME_VERSION = '2.1.237';
const VISIBLE_FRAME_SOURCE = 'tmux_visible_frame';
const BOTTOM_REGION_ROWS = 12;
const RENDERER_PATTERN = /^\s*✳\s+Waiting for (\d+) background agents to finish\s*$/;

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
    if (RENDERER_PATTERN.test(lines[index])) {
      rendererIndex = index;
      break;
    }
  }
  if (rendererIndex < 0) {
    return { status: 'negative', reason: 'renderer_not_in_bottom_region' };
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
