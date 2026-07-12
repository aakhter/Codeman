// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');
const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');

let CodemanApp: { new (): any };
let app: any;
let resizeCallback: ResizeObserverCallback;

beforeAll(() => {
  const combined =
    'var marked, MobileDetection = {}, KeyboardHandler = {}, SwipeHandler = {}, ' +
    'VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
    read('constants.js') +
    '\n' +
    read('app.js') +
    '\n' +
    read('panels-ui.js') +
    '\n;globalThis.__CodemanApp = CodemanApp;';
  (0, eval)(combined);
  CodemanApp = (globalThis as any).__CodemanApp as { new (): any };
});

beforeEach(() => {
  document.body.innerHTML = `
    <div id="filePreviewOverlay">
      <div class="file-preview-window">
        <div id="filePreviewBody"></div>
        <div id="filePreviewFooter"></div>
      </div>
    </div>
  `;
  app = Object.create(CodemanApp.prototype);
  app._elemCache = {};
  app.filePreviewState = {};
  app.formatFileSize = vi.fn(() => '1 KB');

  resizeCallback = () => undefined;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe() {}
      disconnect() {}
      unobserve() {}
    }
  );
});

function setPreviewDimensions(
  previewWidth: number,
  previewHeight: number,
  imageWidth: number,
  imageHeight: number,
  stageHeight = previewHeight,
  toolbarHeight = 40
) {
  const body = document.getElementById('filePreviewBody');
  const stage = document.querySelector<HTMLElement>('.document-preview-stage');
  const image = document.querySelector<HTMLImageElement>('.document-preview-image');
  const toolbar = document.querySelector<HTMLElement>('.document-preview-toolbar');
  if (!body || !stage || !image || !toolbar) throw new Error('image preview was not rendered');
  Object.defineProperties(body, {
    clientWidth: { configurable: true, value: previewWidth },
    clientHeight: { configurable: true, value: previewHeight },
  });
  Object.defineProperties(stage, {
    clientWidth: { configurable: true, value: previewWidth },
    clientHeight: { configurable: true, value: stageHeight },
  });
  Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, value: toolbarHeight });
  Object.defineProperties(image, {
    offsetWidth: { configurable: true, value: imageWidth },
    offsetHeight: { configurable: true, value: imageHeight },
  });
  return { stage, image };
}

async function renderImagePreview() {
  app._restorePreviewSize();
  await app._renderFilePreviewBody(
    { type: 'image', url: '/preview.png', size: 1024, extension: 'png' },
    { sessionId: 's-1', filePath: 'preview.png', attachmentId: null }
  );
}

describe('file preview image fit', () => {
  it('fits the initial image once its load event has measurable dimensions', async () => {
    await renderImagePreview();
    // The auto-height stage has expanded to the tall image's height, while the
    // preview body exposes only 300px below its toolbar.
    const { image } = setPreviewDimensions(400, 340, 400, 800, 800);

    image.dispatchEvent(new Event('load'));

    expect(image.style.transform).toBe('scale(0.375)');
    expect(app.filePreviewZoom).toBe(0.375);
  });

  it('retries fit when initially-zero dimensions become measurable after a preview resize', async () => {
    await renderImagePreview();
    const { image } = setPreviewDimensions(0, 0, 0, 0);
    image.dispatchEvent(new Event('load'));
    expect(image.style.transform).toBe('');

    setPreviewDimensions(300, 240, 300, 400, 400);
    resizeCallback([], {} as ResizeObserver);

    expect(image.style.transform).toBe('scale(0.5)');
  });

  it('preserves manual zoom across resize and lets Fit resume responsive fitting', async () => {
    await renderImagePreview();
    const { image } = setPreviewDimensions(400, 340, 800, 600, 600);
    image.dispatchEvent(new Event('load'));

    app.setFilePreviewZoom('in');
    expect(image.style.transform).toBe('scale(0.625)');
    app.setFilePreviewZoom('out');
    expect(image.style.transform).toBe('scale(0.5)');
    app.setFilePreviewZoom('in');
    expect(image.style.transform).toBe('scale(0.625)');

    setPreviewDimensions(200, 190, 800, 600, 600);
    resizeCallback([], {} as ResizeObserver);
    expect(image.style.transform).toBe('scale(0.625)');

    app.setFilePreviewZoom('fit');
    expect(image.style.transform).toBe('scale(0.25)');

    setPreviewDimensions(320, 280, 800, 600, 600);
    resizeCallback([], {} as ResizeObserver);
    expect(image.style.transform).toBe('scale(0.4)');
  });

  it('uses reversible proportional zoom steps below 0.25 without enlarging on zoom out', async () => {
    await renderImagePreview();
    const { image } = setPreviewDimensions(400, 340, 400, 3000, 3000);
    image.dispatchEvent(new Event('load'));
    expect(app.filePreviewZoom).toBe(0.1);

    app.setFilePreviewZoom('in');
    expect(app.filePreviewZoom).toBeCloseTo(0.125);
    app.setFilePreviewZoom('out');
    expect(app.filePreviewZoom).toBeCloseTo(0.1);

    app.setFilePreviewZoom('out');
    expect(app.filePreviewZoom).toBeCloseTo(0.08);
    expect(image.style.transform).toBe('scale(0.08)');
    app.setFilePreviewZoom('in');
    expect(app.filePreviewZoom).toBeCloseTo(0.1);
  });

  it('zooms out predictably from exactly 0.25', async () => {
    await renderImagePreview();
    const { image } = setPreviewDimensions(400, 340, 1600, 1200, 1200);
    image.dispatchEvent(new Event('load'));
    expect(app.filePreviewZoom).toBe(0.25);

    app.setFilePreviewZoom('out');

    expect(app.filePreviewZoom).toBeCloseTo(0.2);
    expect(image.style.transform).toBe('scale(0.2)');
  });
});
