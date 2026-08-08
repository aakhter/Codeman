/** @fileoverview COD-280 spreadsheet preview bootstrap and asset version. */

(function initSpreadsheetPreviewAssets(global) {
  'use strict';

  const SPREADSHEET_ASSET_VERSION = '38bbeea4b219';

  global.CodemanSpreadsheetPreviewAssets = Object.freeze({
    version: SPREADSHEET_ASSET_VERSION,
    workerUrl: `/spreadsheet-preview-worker.js?v=${SPREADSHEET_ASSET_VERSION}`,
  });
})(window);
