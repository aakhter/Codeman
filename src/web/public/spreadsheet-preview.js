/** @fileoverview COD-280 local-only virtualized spreadsheet preview renderer. */

(function initSpreadsheetPreview(global) {
  'use strict';

  const SPREADSHEET_ASSET_VERSION = '573c1c53562c';
  const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
  const DEFAULT_TIMEOUT_MS = 20000;
  const MAX_SCROLL_PX = 8000000;
  const assets = Object.freeze({
    version: SPREADSHEET_ASSET_VERSION,
    workerUrl: `/spreadsheet-preview-worker.js?v=${SPREADSHEET_ASSET_VERSION}`,
  });

  function message(container, text, kind) {
    container.textContent = '';
    const state = document.createElement('div');
    state.className = `spreadsheet-preview-message ${kind || ''}`.trim();
    state.textContent = text;
    container.appendChild(state);
  }

  function safePreviewUrl(candidate) {
    const url = new URL(candidate, global.location.href);
    if (url.origin !== global.location.origin) throw new Error('Spreadsheet preview must use a same-origin URL');
    url.searchParams.set('preview', 'true');
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function open(options) {
    const container = options.container;
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    let disposed = false;
    let worker = null;
    let controller = null;
    let timer = null;
    let metadata = null;
    let activeSheetId = null;
    let latestRequestId = 0;
    let grid = null;
    let cellsLayer = null;
    let resizeObserver = null;

    const current = () => !disposed && isCurrent();
    const clearTimer = () => {
      if (timer !== null) global.clearTimeout(timer);
      timer = null;
    };
    const fail = (text) => {
      if (!current()) return;
      clearTimer();
      message(container, text || 'Spreadsheet preview failed', 'error');
    };

    function sheetMetadata() {
      return metadata?.sheets.find((sheet) => String(sheet.id) === String(activeSheetId));
    }

    function axisOffset(count, defaultSize, overrides, index) {
      const bounded = Math.max(1, Math.min(count + 1, index));
      let value = (bounded - 1) * defaultSize;
      for (const [overrideIndex, size] of overrides || []) {
        if (overrideIndex >= bounded) break;
        value += size - defaultSize;
      }
      return value;
    }

    function axisIndex(count, defaultSize, overrides, offset) {
      let low = 1;
      let high = Math.max(1, count);
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (axisOffset(count, defaultSize, overrides, mid) <= offset) low = mid;
        else high = mid - 1;
      }
      return low;
    }

    function requestTile() {
      if (!current() || !worker || !grid) return;
      const sheet = sheetMetadata();
      if (!sheet || sheet.rows === 0 || sheet.cols === 0) return;
      const scaleY = Math.max(
        1,
        axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, sheet.rows + 1) / MAX_SCROLL_PX
      );
      const scaleX = Math.max(
        1,
        axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, sheet.cols + 1) / MAX_SCROLL_PX
      );
      const r1 = Math.max(
        1,
        axisIndex(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, grid.scrollTop * scaleY) - 2
      );
      const c1 = Math.max(
        1,
        axisIndex(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, grid.scrollLeft * scaleX) - 2
      );
      const r2 = Math.min(sheet.rows, r1 + Math.ceil((grid.clientHeight || 500) / sheet.defaultRowHeight) + 5);
      const c2 = Math.min(sheet.cols, c1 + Math.ceil((grid.clientWidth || 800) / sheet.defaultColumnWidth) + 5);
      latestRequestId += 1;
      worker.postMessage({
        type: 'tile',
        requestId: latestRequestId,
        sheetId: String(activeSheetId),
        range: { r1, c1, r2, c2 },
      });
    }

    function renderTile(tile) {
      if (!current() || tile.requestId !== latestRequestId || String(tile.sheetId) !== String(activeSheetId)) return;
      const sheet = sheetMetadata();
      if (!sheet || !cellsLayer) return;
      cellsLayer.textContent = '';
      const mergeByAnchor = new Map();
      for (const merge of tile.merges || []) {
        const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(merge);
        if (!match) continue;
        const column = (letters) =>
          [...letters.toUpperCase()].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
        mergeByAnchor.set(`${Number(match[2])}:${column(match[1])}`, {
          r2: Number(match[4]),
          c2: column(match[3]),
        });
      }
      for (const cell of tile.cells.slice(0, 2500)) {
        const element = document.createElement('div');
        element.className = `spreadsheet-cell spreadsheet-style-${Number(cell.styleId) || 0}`;
        element.dataset.row = String(cell.row);
        element.dataset.col = String(cell.col);
        element.textContent = String(cell.text ?? '');
        element.style.top = `${axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, cell.row)}px`;
        element.style.left = `${axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, cell.col)}px`;
        const merge = mergeByAnchor.get(`${cell.row}:${cell.col}`);
        const finalRow = merge?.r2 || cell.row;
        const finalCol = merge?.c2 || cell.col;
        element.style.height = `${Math.max(0, axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, finalRow + 1) - axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, cell.row))}px`;
        element.style.width = `${Math.max(0, axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, finalCol + 1) - axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, cell.col))}px`;
        cellsLayer.appendChild(element);
      }
      const notice = container.querySelector('.spreadsheet-preview-notice');
      if (notice && tile.warnings?.length) {
        notice.hidden = false;
        notice.textContent = tile.warnings.join(' · ');
      }
    }

    function selectSheet(sheetId) {
      if (!current() || !metadata?.sheets.some((sheet) => String(sheet.id) === String(sheetId))) return;
      activeSheetId = String(sheetId);
      latestRequestId += 1;
      container.querySelectorAll('[role="tab"]').forEach((tab) => {
        const selected = tab.dataset.sheetId === activeSheetId;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
      if (grid) {
        grid.scrollTop = 0;
        grid.scrollLeft = 0;
      }
      requestTile();
    }

    function renderMetadata(nextMetadata) {
      if (!current()) return;
      metadata = nextMetadata;
      container.textContent = '';
      if (!metadata.sheets?.length) {
        message(container, 'This workbook has no visible worksheets.', 'empty');
        return;
      }
      const shell = document.createElement('div');
      shell.className = 'spreadsheet-preview-shell';
      const styleSheet = document.createElement('style');
      styleSheet.textContent = (metadata.styles || [])
        .map((style, id) => {
          const declarations = [];
          if (style.font?.bold) declarations.push('font-weight:700');
          if (style.font?.italic) declarations.push('font-style:italic');
          if (/^#[a-f0-9]{6}$/i.test(style.font?.color || '')) declarations.push(`color:${style.font.color}`);
          if (/^#[a-f0-9]{6}$/i.test(style.fill || '')) declarations.push(`background-color:${style.fill}`);
          if (['left', 'center', 'right'].includes(style.alignment)) declarations.push(`text-align:${style.alignment}`);
          if (style.wrapText) declarations.push('white-space:normal');
          return `.spreadsheet-style-${id}{${declarations.join(';')}}`;
        })
        .join('');
      const tabs = document.createElement('div');
      tabs.className = 'spreadsheet-sheet-tabs';
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('data-i18n-skip', '');
      for (const sheet of metadata.sheets) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'spreadsheet-sheet-tab';
        tab.setAttribute('role', 'tab');
        tab.dataset.sheetId = String(sheet.id);
        tab.textContent = sheet.name;
        tab.addEventListener('click', () => selectSheet(sheet.id));
        tabs.appendChild(tab);
      }
      const notice = document.createElement('div');
      notice.className = 'spreadsheet-preview-notice';
      notice.hidden = true;
      grid = document.createElement('div');
      grid.className = 'spreadsheet-grid';
      grid.setAttribute('data-i18n-skip', '');
      const spacer = document.createElement('div');
      spacer.className = 'spreadsheet-grid-spacer';
      const first = metadata.sheets[0];
      spacer.style.height = `${Math.min(MAX_SCROLL_PX, first.rows * first.defaultRowHeight)}px`;
      spacer.style.width = `${Math.min(MAX_SCROLL_PX, first.cols * first.defaultColumnWidth)}px`;
      cellsLayer = document.createElement('div');
      cellsLayer.className = 'spreadsheet-cells';
      grid.append(spacer, cellsLayer);
      grid.addEventListener('scroll', requestTile, { passive: true });
      shell.append(styleSheet, tabs, notice, grid);
      container.appendChild(shell);
      resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(requestTile) : null;
      resizeObserver?.observe(grid);
      selectSheet(first.id);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      controller?.abort();
      resizeObserver?.disconnect();
      try {
        worker?.postMessage({ type: 'dispose' });
        worker?.terminate();
      } catch {
        // A worker that failed during startup may already be unavailable.
      }
      worker = null;
    }

    async function start() {
      if (Number(options.size) > MAX_PREVIEW_BYTES) {
        fail('This workbook is too large to preview (10 MB limit).');
        return;
      }
      message(container, 'Loading spreadsheet…', 'loading');
      let previewUrl;
      try {
        previewUrl = safePreviewUrl(options.url);
        controller = new AbortController();
        worker = new Worker(assets.workerUrl);
        const ready = new Promise((resolve, reject) => {
          worker.onerror = () => reject(new Error('Spreadsheet parser failed to start'));
          worker.onmessageerror = () => reject(new Error('Spreadsheet parser message failed'));
          worker.onmessage = (event) => {
            if (event.data?.type === 'ready') resolve();
          };
        });
        const responsePromise = fetch(previewUrl, { signal: controller.signal });
        const [response] = await Promise.all([responsePromise, ready]);
        if (!current()) return;
        if (!response.ok) throw new Error(`Spreadsheet preview failed (${response.status})`);
        const bytes = await response.arrayBuffer();
        if (!current()) return;
        worker.onmessage = (event) => {
          if (!current()) return;
          const payload = event.data || {};
          if (payload.type === 'metadata') {
            clearTimer();
            renderMetadata(payload);
          } else if (payload.type === 'tile') renderTile(payload);
          else if (payload.type === 'error') fail(payload.message);
        };
        timer = global.setTimeout(() => {
          worker?.terminate();
          fail('Spreadsheet preview timed out.');
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        worker.postMessage({ type: 'load', bytes }, [bytes]);
      } catch (error) {
        if (!disposed && error?.name !== 'AbortError') fail(error?.message);
      }
    }

    void start();
    return Object.freeze({ dispose, selectSheet, resize: requestTile });
  }

  global.CodemanSpreadsheetPreviewAssets = assets;
  global.CodemanSpreadsheetPreview = Object.freeze({ open, MAX_PREVIEW_BYTES });
})(window);
