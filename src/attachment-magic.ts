/**
 * @fileoverview Parses terminal magic links that request attachment cards.
 */

import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSupportedAttachmentExtension } from './attachment-registry.js';
import { stripAnsi } from './utils/index.js';

const MAGIC_LINK_RE = /codeman:\/\/attach\?([^\s<>"']+)/g;
const CODEX_SAVED_FILE_RE = /\bSaved to:\s*(file:\/\/[^\s<>"']+)/gi;
const GENERATED_ARTIFACT_LABEL_RE =
  /\b(?:Mockup|Screenshot|Artifact|Generated artifact|Generated image):\s*(?:\r?\n\s*)?(\/[^\r\n<>"']+)/gi;

export interface TerminalAttachmentRequest {
  path: string;
  source: 'external' | 'codex-generated';
}

export function parseAttachmentMagicLinks(data: string): string[] {
  return parseMagicAttachmentRequests(data).map((request) => request.path);
}

export interface ParseTerminalAttachmentOptions {
  /**
   * Also scan for codex's GENERATED-artifact announcements (`Saved to: file://…` and the
   * labeled variant). Off by default: those carry a deliberately relaxed trust policy, and
   * codex is the only CLI that announces artifacts this way, so enabling it for every mode
   * widened that policy to panes it was never reasoned about for. The caller passes the
   * registry capability (`transcript === 'codex-rollout'`) rather than a mode id.
   */
  codexArtifacts?: boolean;
}

export function parseTerminalAttachmentRequests(
  data: string,
  options: ParseTerminalAttachmentOptions = {}
): TerminalAttachmentRequest[] {
  const results: TerminalAttachmentRequest[] = [];
  const seen = new Set<string>();

  // Only the `Saved to: file://…` scanner is gated: that announcement is codex's own, and
  // it is the one carrying the relaxed trust policy. The LABELED scanner
  // (`Mockup:`/`Screenshot:`/`Artifact:` …) is deliberately NOT gated — those labels are
  // generic and are printed by Superpowers under claude too, so gating it would silently
  // stop detecting artifacts on every non-codex session.
  for (const request of [
    ...parseMagicAttachmentRequests(data),
    ...(options.codexArtifacts ? parseCodexGeneratedArtifactRequests(data) : []),
    ...parseLabeledGeneratedArtifactRequests(data),
  ]) {
    const key = `${request.source}:${request.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(request);
  }

  return results;
}

function parseMagicAttachmentRequests(data: string): TerminalAttachmentRequest[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const match of data.matchAll(MAGIC_LINK_RE)) {
    const query = trimTrailingPunctuation(match[1] || '');
    try {
      const params = new URLSearchParams(query);
      const filePath = params.get('path');
      if (!filePath || !isAbsolute(filePath)) continue;
      const extension = filePath.split('.').pop()?.toLowerCase() || '';
      if (!isSupportedAttachmentExtension(extension)) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      results.push(filePath);
    } catch {
      // Ignore malformed terminal text. Magic links are advisory.
    }
  }

  return results.map((path) => ({ path, source: 'external' }));
}

function parseCodexGeneratedArtifactRequests(data: string): TerminalAttachmentRequest[] {
  const results: TerminalAttachmentRequest[] = [];
  const seen = new Set<string>();

  // Codex styles its TUI output. Strip ANSI first so a trailing SGR reset does
  // not become part of the URL and break extension validation.
  for (const match of stripAnsi(data).matchAll(CODEX_SAVED_FILE_RE)) {
    const rawUrl = trimTrailingPunctuation(match[1] || '');
    try {
      const filePath = fileURLToPath(rawUrl);
      if (!isAbsolute(filePath)) continue;
      const extension = filePath.split('.').pop()?.toLowerCase() || '';
      if (!isSupportedAttachmentExtension(extension)) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      results.push({ path: filePath, source: 'codex-generated' });
    } catch {
      // Ignore malformed terminal text. Generated-artifact links are advisory.
    }
  }

  return results;
}

function parseLabeledGeneratedArtifactRequests(data: string): TerminalAttachmentRequest[] {
  const results: TerminalAttachmentRequest[] = [];
  const seen = new Set<string>();

  for (const match of data.matchAll(GENERATED_ARTIFACT_LABEL_RE)) {
    const filePath = trimTrailingPunctuation((match[1] || '').trim());
    if (!isAbsolute(filePath)) continue;
    const extension = filePath.split('.').pop()?.toLowerCase() || '';
    if (!isSupportedAttachmentExtension(extension)) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    results.push({ path: filePath, source: 'codex-generated' });
  }

  return results;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, '');
}
