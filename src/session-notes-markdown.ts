/** @fileoverview Versioned session-note frontmatter codec and full-file revision hashing. */

import { createHash } from 'node:crypto';
import type { SessionNote, SessionNoteMetadata } from './types/session-notes.js';

export function noteRevision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function serializeSessionNote(metadata: SessionNoteMetadata, markdown: string): Buffer {
  return Buffer.from(`---\n${JSON.stringify(metadata)}\n---\n${markdown}`, 'utf8');
}

export function parseSessionNote(bytes: Buffer): SessionNote {
  const raw = bytes.toString('utf8');
  const match = /^---\r?\n([^]*?)\r?\n---\r?\n/.exec(raw);
  if (!match) throw new Error('Missing versioned JSON frontmatter');
  const metadata: SessionNoteMetadata = JSON.parse(match[1]);
  const strings = [
    'id',
    'ownerKey',
    'projectId',
    'sessionId',
    'sessionTitle',
    'title',
    'workingDir',
    'executionLocation',
  ] as const;
  if (
    !metadata ||
    metadata.version !== 1 ||
    strings.some((key) => typeof metadata[key] !== 'string') ||
    !Array.isArray(metadata.sessionAliases) ||
    metadata.sessionAliases.some((id) => typeof id !== 'string') ||
    !Number.isFinite(metadata.createdAt) ||
    !Number.isFinite(metadata.updatedAt)
  )
    throw new Error('Invalid session note metadata');
  return { metadata, markdown: raw.slice(match[0].length), revision: noteRevision(bytes) };
}
