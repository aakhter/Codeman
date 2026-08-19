import type { Session } from '../session.js';
import type { TerminalMultiplexer } from '../mux-interface.js';

/** Build the shared visible-pane-first capture used by approval ingestion paths. */
export function buildPaneCapture(
  session: Pick<Session, 'muxName' | 'terminalBuffer'>,
  mux: Pick<TerminalMultiplexer, 'capturePaneBuffer'>
): () => string | null {
  return () => {
    const muxName = session.muxName;
    const frame = muxName ? (mux.capturePaneBuffer?.(muxName) ?? null) : null;
    return frame ?? session.terminalBuffer.slice(-8192) ?? null;
  };
}
