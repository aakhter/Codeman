/** @fileoverview COD-280 XLSX admission, formatting, and sparse geometry contracts. */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fflate from 'fflate';

type Core = {
  LIMITS: Record<string, number>;
  XlsxPreviewError: new (code: string, message: string) => Error & { code: string };
  inspectZipDirectory(bytes: Uint8Array, limits?: Record<string, number>): { entries: Array<{ name: string }> };
  admitXlsx(bytes: Uint8Array, zip: typeof fflate, limits?: Record<string, number>): unknown;
  parseCellRef(ref: string): { row: number; col: number } | null;
  deriveExtent(cells: string[], merges: string[]): { rows: number; cols: number };
  createSparseAxis(count: number, defaultSize: number, overrides: Array<[number, number]>): unknown;
  axisOffset(axis: unknown, index: number): number;
  axisIndexAt(axis: unknown, offset: number): number;
  computeViewport(axis: unknown, offset: number, viewportSize: number, overscan?: number): [number, number];
  intersectingMerges(merges: string[], range: { r1: number; c1: number; r2: number; c2: number }): string[];
  formatCellValue(value: unknown, format: string, date1904?: boolean): { text: string; warning?: string };
};

const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/spreadsheet-xlsx-core.js'), 'utf8');
const context = vm.createContext({ Uint8Array, DataView, TextDecoder, Date, Math, Number, String, Object, Map, Set });
vm.runInContext(source, context);
const core = (context as unknown as { CodemanSpreadsheetXlsxCore: Core }).CodemanSpreadsheetXlsxCore;

const workbookZip = (sheet = '<worksheet><sheetData><row><c r="A1"/></row></sheetData><mergeCells/></worksheet>') =>
  fflate.zipSync({
    '[Content_Types].xml': fflate.strToU8('<Types/>'),
    'xl/workbook.xml': fflate.strToU8('<workbook><sheets><sheet name="Sheet1"/></sheets></workbook>'),
    'xl/styles.xml': fflate.strToU8('<styleSheet><cellXfs count="1"><xf/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': fflate.strToU8(sheet),
  });

describe('spreadsheet XLSX core', () => {
  it('rejects encrypted OLE files, malformed ZIPs, and ZIP64 sentinels', () => {
    expect(() => core.inspectZipDirectory(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0]))).toThrowError(/encrypted/i);
    expect(() => core.inspectZipDirectory(Uint8Array.from([1, 2, 3]))).toThrowError(/malformed/i);

    const zip = workbookZip();
    const eocd = zip.length - 22;
    zip[eocd + 10] = 0xff;
    zip[eocd + 11] = 0xff;
    expect(() => core.inspectZipDirectory(zip)).toThrowError(/ZIP64/i);
  });

  it('rejects divergent local-header and central-directory entry names', () => {
    const zip = workbookZip();
    const localNameLength = new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint16(26, true);
    expect(localNameLength).toBeGreaterThan(0);
    zip[30] = zip[30] === 120 ? 121 : 120;
    expect(() => core.inspectZipDirectory(zip)).toThrowError(/names do not match/i);
  });

  it('rejects central-directory entries that were not streamed through admission', () => {
    class IncompleteUnzip {
      constructor(private readonly onFile: (file: any) => void) {}
      register() {}
      push(_bytes: Uint8Array, final: boolean) {
        if (!final) return;
        const file: Record<string, any> = {
          name: '[Content_Types].xml',
          start: () => file.ondata(null, new Uint8Array(), true),
        };
        this.onFile(file);
      }
    }
    const incomplete = { Unzip: IncompleteUnzip, UnzipInflate: class {} } as unknown as typeof fflate;
    expect(() => core.admitXlsx(workbookZip(), incomplete)).toThrowError(/not streamed/i);
  });

  it('uses actual streamed output for entry, total, ratio, and XML-count limits', () => {
    const inflated = 'x'.repeat(20_000);
    const bomb = fflate.zipSync({ 'xl/worksheets/sheet1.xml': fflate.strToU8(inflated) }, { level: 9 });
    expect(() => core.admitXlsx(bomb, fflate, { maxEntryBytes: 10_000 })).toThrowError(/entry/i);
    expect(() => core.admitXlsx(bomb, fflate, { maxInflatedBytes: 10_000 })).toThrowError(/inflated/i);
    expect(() => core.admitXlsx(bomb, fflate, { maxCompressionRatio: 2 })).toThrowError(/compression ratio/i);

    const cells = '<worksheet><sheetData>' + '<c r="A1"/>'.repeat(4) + '</sheetData></worksheet>';
    expect(() => core.admitXlsx(workbookZip(cells), fflate, { maxCellsPerSheet: 3 })).toThrowError(/cells/i);
    expect(() => core.admitXlsx(workbookZip(), fflate, { maxEntries: 2 })).toThrowError(/entries/i);
  });

  it('detects OOXML feature parts and counts worksheets, merges, styles, and cells', () => {
    const zip = fflate.zipSync({
      ...fflate.unzipSync(
        workbookZip('<worksheet><sheetData><c r="A1"/></sheetData><mergeCell ref="A1:B2"/></worksheet>')
      ),
      'xl/charts/chart1.xml': fflate.strToU8('<chart/>'),
      'xl/externalLinks/externalLink1.xml': fflate.strToU8('<externalLink/>'),
    });
    const result = core.admitXlsx(zip, fflate) as {
      counts: { worksheets: number; cells: number; merges: number; styles: number };
      features: string[];
    };
    expect(result.counts).toEqual({ worksheets: 1, cells: 1, merges: 1, styles: 1 });
    expect(result.features).toEqual(expect.arrayContaining(['charts', 'externalLinks']));
  });

  it('derives bounded extents from real cells and merges', () => {
    expect(core.parseCellRef('XFD1048576')).toEqual({ row: 1_048_576, col: 16_384 });
    expect(core.parseCellRef('XFE1')).toBeNull();
    expect(core.deriveExtent(['B3'], ['D5:F9'])).toEqual({ rows: 9, cols: 6 });
  });

  it('maps sparse axes and virtual viewports without dense allocation', () => {
    const axis = core.createSparseAxis(1_000_000, 20, [
      [2, 0],
      [10, 40],
    ]);
    expect(core.axisOffset(axis, 3)).toBe(20);
    expect(core.axisIndexAt(axis, 20)).toBe(3);
    const [start, end] = core.computeViewport(axis, 199, 60, 1);
    expect(start).toBeLessThanOrEqual(9);
    expect(end - start).toBeLessThan(10);
  });

  it('returns intersecting merges even when their anchor is offscreen', () => {
    expect(core.intersectingMerges(['A1:D4', 'Z1:Z2'], { r1: 3, c1: 3, r2: 6, c2: 6 })).toEqual(['A1:D4']);
  });

  it('formats common values and safely flags unknown formats', () => {
    expect(core.formatCellValue(0.125, '0.0%').text).toBe('12.5%');
    expect(core.formatCellValue(1234.5, '#,##0.00').text).toBe('1,234.50');
    expect(core.formatCellValue(10, '$#,##0.00').text).toBe('$10.00');
    expect(core.formatCellValue(1, 'yyyy-mm-dd').text).toBe('1900-01-01');
    expect(core.formatCellValue(0, 'yyyy-mm-dd', true).text).toBe('1904-01-01');
    expect(core.formatCellValue(0.5, 'hh:mm:ss').text).toBe('12:00:00');
    expect(core.formatCellValue(1.5, 'yyyy-mm-dd hh:mm').text).toBe('1900-01-01 12:00');
    expect(core.formatCellValue(7, '[Red][<0]0.0')).toMatchObject({ text: '7', warning: expect.any(String) });
    expect(core.formatCellValue({ formula: 'SUM(A1:A2)' }, 'General')).toMatchObject({ text: '=SUM(A1:A2)' });
  });
});
