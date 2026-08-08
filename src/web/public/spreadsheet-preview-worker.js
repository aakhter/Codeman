/** @fileoverview COD-280 same-origin XLSX parsing worker. */

'use strict';

const spreadsheetAssetVersion = new URL(self.location.href).searchParams.get('v') || 'dev';
const spreadsheetAssetQuery = `?v=${encodeURIComponent(spreadsheetAssetVersion)}`;
importScripts(`/vendor/fflate.min.js${spreadsheetAssetQuery}`, `/vendor/exceljs.min.js${spreadsheetAssetQuery}`);

self.postMessage({ type: 'ready' });
