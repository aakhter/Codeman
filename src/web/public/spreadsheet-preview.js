/** @fileoverview COD-280 spreadsheet preview bootstrap and asset version. */

(function initSpreadsheetPreviewAssets(global) {
  'use strict';

  const SPREADSHEET_ASSET_VERSION = 'fd4476b40d2e';

  global.CodemanSpreadsheetPreviewAssets = Object.freeze({
    version: SPREADSHEET_ASSET_VERSION,
    workerUrl: `/spreadsheet-preview-worker.js?v=${SPREADSHEET_ASSET_VERSION}`,
  });
})(window);
