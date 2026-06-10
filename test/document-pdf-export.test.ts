/**
 * @fileoverview Unit tests for the pure PDF-export helpers (COD-61).
 *
 * Covers format/type validation, the type→branch decision, and the
 * standalone-HTML wrapping (md/text → a printable standalone HTML string).
 * No soffice/pandoc shelling here — those paths are exercised in the route
 * test with mocks and on beta by the orchestrator.
 *
 * Port: N/A (pure functions).
 */

import { describe, it, expect } from 'vitest';
import {
  isSupportedExportFormat,
  classifyExportBranch,
  wrapStandaloneHtml,
  buildTextExportHtml,
} from '../src/document-pdf-export.js';

describe('document-pdf-export pure helpers', () => {
  describe('isSupportedExportFormat', () => {
    it('accepts pdf (any case) and a missing format (defaults to pdf)', () => {
      expect(isSupportedExportFormat('pdf')).toBe(true);
      expect(isSupportedExportFormat('PDF')).toBe(true);
      expect(isSupportedExportFormat(undefined)).toBe(true);
    });

    it('rejects deferred formats (docx/templates)', () => {
      expect(isSupportedExportFormat('docx')).toBe(false);
      expect(isSupportedExportFormat('html')).toBe(false);
      expect(isSupportedExportFormat('')).toBe(false);
    });
  });

  describe('classifyExportBranch', () => {
    it('maps docx/pptx to the office (cached-PDF) branch', () => {
      expect(classifyExportBranch('docx')).toBe('office');
      expect(classifyExportBranch('.PPTX')).toBe('office');
    });

    it('maps markdown/text extensions to the text (HTML→PDF) branch', () => {
      for (const ext of ['md', 'markdown', 'mdown', 'txt', 'text']) {
        expect(classifyExportBranch(ext)).toBe('text');
      }
    });

    it('marks everything else unsupported', () => {
      expect(classifyExportBranch('pdf')).toBe('unsupported');
      expect(classifyExportBranch('png')).toBe('unsupported');
      expect(classifyExportBranch('')).toBe('unsupported');
    });
  });

  describe('wrapStandaloneHtml', () => {
    it('produces a full standalone HTML document containing the body and title', () => {
      const html = wrapStandaloneHtml('<h1>Hello</h1>', 'My Doc');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<title>My Doc</title>');
      expect(html).toContain('<h1>Hello</h1>');
      expect(html).toContain('@page');
    });

    it('escapes the title to keep the head well-formed', () => {
      const html = wrapStandaloneHtml('<p>x</p>', 'a<b>&"c');
      expect(html).toContain('<title>a&lt;b&gt;&amp;&quot;c</title>');
    });
  });

  describe('buildTextExportHtml', () => {
    it('escapes plain text into a <pre> and reports the plaintext renderer', async () => {
      const { html, renderer } = await buildTextExportHtml('a < b & "c"', 'txt', 'notes');
      expect(renderer).toBe('plaintext');
      expect(html).toContain('<pre>a &lt; b &amp; &quot;c&quot;</pre>');
      expect(html).toContain('<title>notes</title>');
    });

    it('renders markdown to HTML (pandoc or marked) and embeds it standalone', async () => {
      const { html, renderer } = await buildTextExportHtml('# Heading\n\nBody text.', 'md', 'doc');
      // In this environment pandoc is on PATH; if it were not, the vendored
      // marked fallback would be used. Either way the heading must be rendered
      // as an <h1> (not escaped into a <pre>).
      expect(['pandoc', 'marked']).toContain(renderer);
      expect(html).toMatch(/<h1[^>]*>Heading<\/h1>/);
      expect(html).toContain('Body text.');
    });
  });
});
