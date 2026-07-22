/**
 * @fileoverview Session source types for COD-65 Reference / source manager.
 *
 * A SessionSource is a user-pinned reference (file, URL, or highlighted text)
 * attached to a session so the agent can easily cite or operate on it.
 */

export type SessionSourceType = 'file' | 'url' | 'highlight';

export interface SessionSource {
  /** Stable identity — client-generated UUID or server-minted on POST */
  id: string;
  /** Session this source belongs to */
  sessionId: string;
  /** Discriminator for how to render and act on the source */
  type: SessionSourceType;
  /** Human-readable label (filename, page title, or excerpt prefix) */
  title: string;
  /** URL — present for type === 'url' */
  url?: string;
  /** Workspace-relative file path — present for type === 'file' */
  relativePath?: string;
  /** Highlighted/quoted text — present for type === 'highlight' */
  content?: string;
  /** Epoch ms when the source was added */
  addedAt: number;
}
