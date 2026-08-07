import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI_FILES = ['app.js', 'settings-ui.js', 'terminal-ui.js', 'panels-ui.js'];
const REQUIRED_METHODS = [
  '_onSessionListMaybeChanged',
  '_copyFilePreviewImage',
  'copyFilePreviewContent',
  '_countWords',
  '_formatReadingMeta',
  '_slugifyHeading',
  '_buildDocumentOutline',
  '_setupOutlineScrollSpy',
  '_teardownOutlineScrollSpy',
  '_readPreviewPref',
  '_writePreviewPref',
  'toggleDocumentOutline',
  'toggleReadingView',
  'getFileIcon',
  'formatFileSize',
];

function publicUiMethodNames(): Set<string> {
  const names = new Set<string>();
  const pattern = /^\s{2}(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\([^;]*\)\s*\{/gm;

  for (const file of UI_FILES) {
    const source = readFileSync(resolve('src/web/public', file), 'utf8');
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }

  return names;
}

describe('public UI method contract', () => {
  it.each(REQUIRED_METHODS)('defines %s after module composition', (method) => {
    expect(publicUiMethodNames().has(method)).toBe(true);
  });
});
