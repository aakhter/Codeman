/** @fileoverview Pure XLSX admission, formatting, and sparse-grid helpers. */

(function initSpreadsheetXlsxCore(global) {
  'use strict';

  const LIMITS = Object.freeze({
    maxEntries: 5000,
    maxInflatedBytes: 64 * 1024 * 1024,
    maxEntryBytes: 32 * 1024 * 1024,
    maxCompressionRatio: 100,
    maxWorksheets: 50,
    maxCells: 250000,
    maxCellsPerSheet: 100000,
    maxMergesPerSheet: 5000,
    maxStyles: 5000,
  });
  const MAX_ROW = 1048576;
  const MAX_COL = 16384;
  const decoder = new TextDecoder();

  class XlsxPreviewError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'XlsxPreviewError';
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new XlsxPreviewError(code, message);
  }

  function mergedLimits(overrides) {
    return Object.assign({}, LIMITS, overrides || {});
  }

  function u16(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
  }

  function u32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
  }

  function inspectZipDirectory(bytes, overrides) {
    const limits = mergedLimits(overrides);
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      fail('encrypted', 'Encrypted or legacy OLE workbooks cannot be previewed');
    }
    let eocd = -1;
    const floor = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= floor; i -= 1) {
      if (u32(bytes, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) fail('malformed', 'Malformed XLSX ZIP directory');
    const entryCount = u16(bytes, eocd + 10);
    const directorySize = u32(bytes, eocd + 12);
    const directoryOffset = u32(bytes, eocd + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      fail('zip64', 'ZIP64 workbooks are not supported');
    }
    if (entryCount > limits.maxEntries) fail('entry-limit', `Workbook exceeds ${limits.maxEntries} ZIP entries`);
    if (directoryOffset + directorySize > eocd) fail('malformed', 'Malformed XLSX central directory bounds');
    const entries = [];
    let cursor = directoryOffset;
    for (let i = 0; i < entryCount; i += 1) {
      if (cursor + 46 > eocd || u32(bytes, cursor) !== 0x02014b50)
        fail('malformed', 'Malformed XLSX central directory');
      const compressedSize = u32(bytes, cursor + 20);
      const declaredSize = u32(bytes, cursor + 24);
      const nameLength = u16(bytes, cursor + 28);
      const extraLength = u16(bytes, cursor + 30);
      const commentLength = u16(bytes, cursor + 32);
      if (compressedSize === 0xffffffff || declaredSize === 0xffffffff)
        fail('zip64', 'ZIP64 entries are not supported');
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > eocd) fail('malformed', 'Malformed XLSX entry bounds');
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      entries.push({ name, compressedSize, declaredSize });
      cursor = end;
    }
    return { entries };
  }

  function featureForName(name) {
    if (name.startsWith('xl/charts/')) return 'charts';
    if (name.startsWith('xl/drawings/')) return 'drawings';
    if (name.startsWith('xl/pivotCache/')) return 'pivotTables';
    if (name.startsWith('xl/externalLinks/')) return 'externalLinks';
    if (/vbaProject\.bin$/i.test(name)) return 'macros';
    return null;
  }

  function createXmlCounter(name, counts, limits) {
    let tail = '';
    let sheetCells = 0;
    let sheetMerges = 0;
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
    const styles = name === 'xl/styles.xml';
    return {
      push(chunk, final) {
        if (!worksheet && !styles) return;
        const text = tail + decoder.decode(chunk, { stream: !final });
        const safeEnd = final ? text.length : Math.max(0, text.length - 128);
        const scan = text.slice(0, safeEnd);
        if (worksheet) {
          const cells = (scan.match(/<c(?:\s|>)/g) || []).length;
          const merges = (scan.match(/<mergeCell(?:\s|>)/g) || []).length;
          sheetCells += cells;
          sheetMerges += merges;
          counts.cells += cells;
          counts.merges += merges;
          if (sheetCells > limits.maxCellsPerSheet || counts.cells > limits.maxCells)
            fail('cell-limit', 'Workbook exceeds the cells limit');
          if (sheetMerges > limits.maxMergesPerSheet) fail('merge-limit', 'Worksheet exceeds the merged ranges limit');
        }
        if (styles) {
          const styleMatches = (scan.match(/<xf(?:\s|\/?>)/g) || []).length;
          counts.styles += styleMatches;
          if (counts.styles > limits.maxStyles) fail('style-limit', 'Workbook exceeds the styles limit');
        }
        tail = text.slice(safeEnd);
      },
    };
  }

  function admitXlsx(bytes, zipApi, overrides) {
    const limits = mergedLimits(overrides);
    const directory = inspectZipDirectory(bytes, limits);
    const directoryByName = new Map(directory.entries.map((entry) => [entry.name, entry]));
    const counts = { worksheets: 0, cells: 0, merges: 0, styles: 0 };
    const features = new Set();
    let totalInflated = 0;
    let seenEntries = 0;
    let thrown;
    const unzip = new zipApi.Unzip((file) => {
      seenEntries += 1;
      if (seenEntries > limits.maxEntries) fail('entry-limit', 'Workbook exceeds the ZIP entries limit');
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(file.name)) {
        counts.worksheets += 1;
        if (counts.worksheets > limits.maxWorksheets) fail('worksheet-limit', 'Workbook exceeds the worksheet limit');
      }
      const feature = featureForName(file.name);
      if (feature) features.add(feature);
      const counter = createXmlCounter(file.name, counts, limits);
      let entryInflated = 0;
      file.ondata = (error, chunk, final) => {
        if (error) {
          thrown = error;
          return;
        }
        try {
          entryInflated += chunk.length;
          totalInflated += chunk.length;
          if (entryInflated > limits.maxEntryBytes) fail('entry-size', 'Inflated ZIP entry exceeds the entry limit');
          if (totalInflated > limits.maxInflatedBytes)
            fail('inflated-size', 'Workbook exceeds the inflated bytes limit');
          const compressed = directoryByName.get(file.name)?.compressedSize || 1;
          if (entryInflated / Math.max(1, compressed) > limits.maxCompressionRatio) {
            fail('compression-ratio', 'ZIP entry exceeds the compression ratio limit');
          }
          counter.push(chunk, final);
        } catch (error_) {
          thrown = error_;
        }
      };
      file.start();
    });
    unzip.register(zipApi.UnzipInflate);
    try {
      unzip.push(bytes, true);
    } catch (error) {
      thrown = error;
    }
    if (thrown) throw thrown;
    return { counts, features: Array.from(features), inflatedBytes: totalInflated };
  }

  function parseCellRef(ref) {
    const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(String(ref || ''));
    if (!match) return null;
    let col = 0;
    for (const char of match[1].toUpperCase()) col = col * 26 + char.charCodeAt(0) - 64;
    const row = Number(match[2]);
    return row <= MAX_ROW && col <= MAX_COL ? { row, col } : null;
  }

  function parseRange(range) {
    const parts = String(range).split(':');
    const start = parseCellRef(parts[0]);
    const end = parseCellRef(parts[1] || parts[0]);
    return start && end ? { r1: start.row, c1: start.col, r2: end.row, c2: end.col } : null;
  }

  function deriveExtent(cells, merges) {
    let rows = 0;
    let cols = 0;
    for (const ref of cells) {
      const cell = parseCellRef(ref);
      if (cell) {
        rows = Math.max(rows, cell.row);
        cols = Math.max(cols, cell.col);
      }
    }
    for (const merge of merges) {
      const range = parseRange(merge);
      if (range) {
        rows = Math.max(rows, range.r2);
        cols = Math.max(cols, range.c2);
      }
    }
    return { rows, cols };
  }

  function createSparseAxis(count, defaultSize, overrides) {
    const sorted = Array.from(overrides || [])
      .filter(([index, size]) => index >= 1 && index <= count && Number.isFinite(size))
      .map(([index, size]) => [index, Math.max(0, size)])
      .sort((a, b) => a[0] - b[0]);
    return { count: Math.max(0, count), defaultSize: Math.max(0, defaultSize), overrides: sorted };
  }

  function axisOffset(axis, index) {
    const bounded = Math.max(1, Math.min(axis.count + 1, index));
    let offset = (bounded - 1) * axis.defaultSize;
    for (const [overrideIndex, size] of axis.overrides) {
      if (overrideIndex >= bounded) break;
      offset += size - axis.defaultSize;
    }
    return offset;
  }

  function axisIndexAt(axis, offset) {
    let low = 1;
    let high = Math.max(1, axis.count);
    const target = Math.max(0, offset);
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (axisOffset(axis, mid) <= target) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  function computeViewport(axis, offset, viewportSize, overscan) {
    const pad = Math.max(0, overscan || 0);
    const start = Math.max(1, axisIndexAt(axis, offset) - pad);
    const end = Math.min(axis.count, axisIndexAt(axis, offset + Math.max(0, viewportSize)) + pad);
    return [start, end];
  }

  function intersectingMerges(merges, viewport) {
    return merges.filter((merge) => {
      const range = parseRange(merge);
      return (
        range &&
        range.r1 <= viewport.r2 &&
        range.r2 >= viewport.r1 &&
        range.c1 <= viewport.c2 &&
        range.c2 >= viewport.c1
      );
    });
  }

  function excelDate(serial, date1904) {
    if (date1904) return new Date(Date.UTC(1904, 0, 1) + Number(serial) * 86400000);
    const numeric = Number(serial);
    const adjusted = numeric >= 60 ? numeric - 1 : numeric;
    return new Date(Date.UTC(1899, 11, 31) + adjusted * 86400000);
  }

  function formatCellValue(value, format, date1904) {
    if (value && typeof value === 'object' && 'formula' in value) {
      if (value.result !== undefined && value.result !== null) return formatCellValue(value.result, format, date1904);
      return { text: `=${String(value.formula)}`, warning: 'Formula has no cached result' };
    }
    if (value === null || value === undefined) return { text: '' };
    const code = String(format || 'General');
    if (typeof value !== 'number') return { text: String(value) };
    if (/^General$/i.test(code)) return { text: String(value) };
    if (/^[ymdhis\-/: ]+$/i.test(code)) {
      const date = excelDate(value, Boolean(date1904));
      const yyyy = date.getUTCFullYear();
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(date.getUTCDate()).padStart(2, '0');
      return { text: `${yyyy}-${mm}-${dd}` };
    }
    const percent = code.includes('%');
    const decimals = code.match(/\.([0#]+)/)?.[1].length || 0;
    const numericPattern = /^[€£¥$]?[#,0]+(?:\.[0#]+)?%?$/;
    if (numericPattern.test(code)) {
      const currency = /^[€£¥$]/.exec(code)?.[0] || '';
      const numeric = percent ? value * 100 : value;
      const useGrouping = code.includes(',');
      return {
        text:
          currency +
          numeric.toLocaleString('en-US', {
            useGrouping,
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          }) +
          (percent ? '%' : ''),
      };
    }
    return { text: String(value), warning: `Unsupported number format: ${code}` };
  }

  global.CodemanSpreadsheetXlsxCore = Object.freeze({
    LIMITS,
    MAX_ROW,
    MAX_COL,
    XlsxPreviewError,
    inspectZipDirectory,
    admitXlsx,
    parseCellRef,
    parseRange,
    deriveExtent,
    createSparseAxis,
    axisOffset,
    axisIndexAt,
    computeViewport,
    intersectingMerges,
    formatCellValue,
  });
})(typeof self !== 'undefined' ? self : globalThis);
