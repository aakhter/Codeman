/** @fileoverview COD-280 worker-owned XLSX parse and viewport protocol. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import * as fflate from 'fflate';

const root = resolve(import.meta.dirname, '..');
const workerSource = readFileSync(resolve(root, 'src/web/public/spreadsheet-preview-worker.js'), 'utf8');
const coreSource = readFileSync(resolve(root, 'src/web/public/spreadsheet-xlsx-core.js'), 'utf8');

async function fixture(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet('Summary');
  first.getCell('A1').value = 'Revenue';
  first.getCell('B2').value = 1234.5;
  first.getCell('B2').numFmt = '$#,##0.00';
  first.getCell('C3').value = { formula: 'SUM(B2)', result: 1234.5 };
  first.getCell('C3').numFmt = '$#,##0.00';
  first.mergeCells('A4:C4');
  first.getCell('A4').value = 'Merged';
  first.getRow(2).height = 30;
  first.getColumn(2).width = 18;
  const second = workbook.addWorksheet('Details');
  second.getCell('A1').value = 'Detail';
  workbook.addWorksheet('Hidden').state = 'hidden';
  const bytes = await workbook.xlsx.writeBuffer();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function createHarness() {
  const messages: unknown[] = [];
  const imports: string[] = [];
  const self: Record<string, unknown> = {
    location: { href: 'http://localhost/spreadsheet-preview-worker.js?v=test' },
    postMessage: (message: unknown) => messages.push(message),
  };
  const context = vm.createContext({
    self,
    globalThis: self,
    URL,
    Uint8Array,
    ArrayBuffer,
    DataView,
    TextDecoder,
    Date,
    Math,
    Number,
    String,
    Object,
    Map,
    Set,
    console,
    importScripts: (...urls: string[]) => {
      imports.push(...urls);
      for (const url of urls) {
        if (url.includes('fflate')) Object.assign(self, { fflate });
        if (url.includes('spreadsheet-xlsx-core')) vm.runInContext(coreSource, context);
        if (url.includes('exceljs')) Object.assign(self, { ExcelJS });
      }
    },
  });
  vm.runInContext(workerSource, context);
  return {
    messages,
    imports,
    send: async (data: unknown) => {
      await (self.onmessage as (event: { data: unknown }) => Promise<void>)({ data });
    },
  };
}

describe('spreadsheet preview worker', () => {
  it('admits before lazy ExcelJS loading and returns visible sheets in workbook order', async () => {
    const harness = createHarness();
    expect(harness.messages).toEqual([{ type: 'ready' }]);
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);

    await harness.send({ type: 'load', bytes: await fixture() });

    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(true);
    const metadata = harness.messages.at(-1) as Record<string, any>;
    expect(metadata.type).toBe('metadata');
    expect(metadata.sheets.map((sheet: { name: string }) => sheet.name)).toEqual(['Summary', 'Details']);
    expect(metadata.sheets[0]).toMatchObject({ rows: 4, cols: 3 });
    expect(metadata.sheets[0].rowOverrides).toContainEqual([2, 40]);
    expect(metadata.sheets[0].columnOverrides[0][0]).toBe(2);
    expect(metadata.styles.length).toBeLessThanOrEqual(5000);
  });

  it('returns bounded intersecting tiles and echoes request and sheet identity', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: await fixture() });
    const metadata = harness.messages.at(-1) as Record<string, any>;
    const sheetId = metadata.sheets[0].id;

    await harness.send({ type: 'tile', requestId: 7, sheetId, range: { r1: 2, c1: 2, r2: 4, c2: 3 } });

    const tile = harness.messages.at(-1) as Record<string, any>;
    expect(tile).toMatchObject({ type: 'tile', requestId: 7, sheetId });
    expect(tile.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 2, col: 2, text: '$1,234.50' }),
        expect.objectContaining({ row: 3, col: 3, text: '$1,234.50' }),
      ])
    );
    expect(tile.merges).toContain('A4:C4');
    expect(tile.cells).toContainEqual(expect.objectContaining({ row: 4, col: 1, text: 'Merged' }));
    expect(tile.cells.length).toBeLessThanOrEqual(9);
  });

  it('rejects malformed input without loading ExcelJS', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: Uint8Array.from([1, 2, 3]).buffer });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'malformed' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  });
});
