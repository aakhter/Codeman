/** @fileoverview COD-280 same-origin XLSX parsing worker. */

'use strict';

const spreadsheetAssetVersion = new URL(self.location.href).searchParams.get('v') || 'dev';
const spreadsheetAssetQuery = `?v=${encodeURIComponent(spreadsheetAssetVersion)}`;
importScripts(`/vendor/fflate.min.js${spreadsheetAssetQuery}`, `/spreadsheet-xlsx-core.js${spreadsheetAssetQuery}`);

const core = self.CodemanSpreadsheetXlsxCore;
let workbook = null;
let sheetsById = new Map();
let normalizedStyles = [];
let styleIds = new Map();

function postError(error) {
  self.postMessage({
    type: 'error',
    code: error?.code || 'parse-failed',
    message: error?.message || 'Spreadsheet preview failed',
  });
}

function normalizedColor(color) {
  const argb = color?.argb;
  return typeof argb === 'string' && /^[A-Fa-f0-9]{8}$/.test(argb) ? `#${argb.slice(2)}` : undefined;
}

function normalizeStyle(cell) {
  const style = {
    font: {
      bold: Boolean(cell.font?.bold),
      italic: Boolean(cell.font?.italic),
      color: normalizedColor(cell.font?.color),
    },
    fill: normalizedColor(cell.fill?.fgColor),
    alignment: ['left', 'center', 'right'].includes(cell.alignment?.horizontal) ? cell.alignment.horizontal : undefined,
    wrapText: Boolean(cell.alignment?.wrapText),
  };
  const key = JSON.stringify(style);
  if (styleIds.has(key)) return styleIds.get(key);
  if (normalizedStyles.length >= core.LIMITS.maxStyles) {
    throw new core.XlsxPreviewError('style-limit', 'Workbook exceeds the normalized styles limit');
  }
  const id = normalizedStyles.length;
  normalizedStyles.push(style);
  styleIds.set(key, id);
  return id;
}

function worksheetMetadata(sheet) {
  const cellRefs = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      cellRefs.push(cell.address);
      normalizeStyle(cell);
    });
  });
  const merges = Array.from(sheet.model?.merges || []);
  const extent = core.deriveExtent(cellRefs, merges);
  const rowOverrides = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.hidden) rowOverrides.push([row.number, 0]);
    else if (row.height) rowOverrides.push([row.number, Math.max(0, row.height * (4 / 3))]);
  });
  const columnOverrides = [];
  for (let col = 1; col <= extent.cols; col += 1) {
    const column = sheet.getColumn(col);
    if (column.hidden) columnOverrides.push([col, 0]);
    else if (column.width) columnOverrides.push([col, Math.max(0, column.width * 7)]);
  }
  return {
    id: String(sheet.id),
    name: sheet.name,
    rows: extent.rows,
    cols: extent.cols,
    defaultRowHeight: 20,
    defaultColumnWidth: 64,
    rowOverrides,
    columnOverrides,
    merges,
  };
}

function cellDisplay(cell, date1904, warnings) {
  const formatted = core.formatCellValue(cell.value, cell.numFmt || 'General', date1904);
  if (formatted.warning) warnings.add(formatted.warning);
  return formatted.text;
}

async function loadWorkbook(bytes) {
  core.admitXlsx(new Uint8Array(bytes), self.fflate);
  if (!self.ExcelJS) importScripts(`/vendor/exceljs.min.js${spreadsheetAssetQuery}`);
  const nextWorkbook = new self.ExcelJS.Workbook();
  await nextWorkbook.xlsx.load(bytes);
  const nextSheets = new Map();
  normalizedStyles = [];
  styleIds = new Map();
  const sheets = [];
  for (const sheet of nextWorkbook.worksheets) {
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') continue;
    const metadata = worksheetMetadata(sheet);
    nextSheets.set(metadata.id, sheet);
    sheets.push(metadata);
  }
  workbook = nextWorkbook;
  sheetsById = nextSheets;
  self.postMessage({
    type: 'metadata',
    sheets,
    styles: normalizedStyles,
    date1904: Boolean(workbook.properties?.date1904),
    empty: sheets.length === 0,
  });
}

function sendTile(message) {
  if (!workbook) throw new Error('Workbook is not loaded');
  const sheet = sheetsById.get(String(message.sheetId));
  if (!sheet) throw new Error('Worksheet is unavailable');
  const range = message.range;
  if ((range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1) > 2500) {
    throw new core.XlsxPreviewError('tile-limit', 'Requested spreadsheet tile is too large');
  }
  const warnings = new Set();
  const cells = [];
  const seenCells = new Set();
  const addCell = (cell) => {
    const key = `${cell.row}:${cell.col}`;
    if (seenCells.has(key) || (cell.isMerged && cell.master !== cell)) return;
    seenCells.add(key);
    cells.push({
      row: cell.row,
      col: cell.col,
      text: cellDisplay(cell, Boolean(workbook.properties?.date1904), warnings),
      styleId: normalizeStyle(cell),
    });
  };
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.number < range.r1 || row.number > range.r2) return;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.col < range.c1 || cell.col > range.c2) return;
      addCell(cell);
    });
  });
  const merges = core.intersectingMerges(Array.from(sheet.model?.merges || []), range);
  for (const merge of merges) {
    const anchor = core.parseRange(merge);
    if (anchor) addCell(sheet.getCell(anchor.r1, anchor.c1));
  }
  self.postMessage({
    type: 'tile',
    requestId: message.requestId,
    sheetId: String(message.sheetId),
    cells,
    merges,
    styles: normalizedStyles,
    warnings: Array.from(warnings),
  });
}

self.onmessage = async (event) => {
  try {
    const message = event.data || {};
    if (message.type === 'load') await loadWorkbook(message.bytes);
    else if (message.type === 'tile') sendTile(message);
    else if (message.type === 'dispose') {
      workbook = null;
      sheetsById = new Map();
    }
  } catch (error) {
    postError(error);
  }
};

self.postMessage({ type: 'ready' });
