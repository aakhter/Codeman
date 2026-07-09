// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');
const read = (file: string) => readFileSync(join(publicDir, file), 'utf8');

let CodemanApp: { new (): any };
let app: any;
let clipboardWrite: ReturnType<typeof vi.fn>;
let clipboardWriteText: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

class TestClipboardItem {
  data: Record<string, Blob>;

  constructor(data: Record<string, Blob>) {
    this.data = data;
  }
}

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
  document.body.innerHTML = '';
  app = Object.create(CodemanApp.prototype);
  app._elemCache = {};
  app.showToast = vi.fn();

  clipboardWrite = vi.fn(async () => undefined);
  clipboardWriteText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: clipboardWrite, writeText: clipboardWriteText },
  });
  vi.stubGlobal('ClipboardItem', TestClipboardItem);

  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('file preview image copy', () => {
  it('writes the preview bitmap to the browser clipboard', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    fetchMock.mockResolvedValueOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    );
    app.filePreviewState = {
      previewKind: 'image',
      previewCopyUrl: '/api/sessions/s-1/attachments/a-1/preview?_t=123',
    };

    const ok = await app.copyFilePreviewContent();

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s-1/attachments/a-1/preview?_t=123');
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const [items] = clipboardWrite.mock.calls[0];
    const item = items[0] as TestClipboardItem;
    expect(Object.keys(item.data)).toEqual(['image/png']);
    expect(item.data['image/png']).toMatchObject({ type: 'image/png', size: pngBytes.length });
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith('Copied image to clipboard', 'success');
  });

  it('shows an error toast when image clipboard write fails', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    );
    clipboardWrite.mockRejectedValueOnce(new Error('denied'));
    app.filePreviewState = {
      previewKind: 'image',
      previewCopyUrl: '/preview.png',
    };

    const ok = await app.copyFilePreviewContent();

    expect(ok).toBe(false);
    expect(app.showToast).toHaveBeenCalledWith('Failed to copy image to clipboard', 'error');
  });

  it('keeps the existing text copy path for non-image previews', async () => {
    app.filePreviewState = { previewKind: 'text', previewCopyUrl: null };
    app.filePreviewContent = 'hello world';

    const result = app.copyFilePreviewContent();
    await Promise.resolve();

    expect(result).toBeUndefined();
    expect(clipboardWriteText).toHaveBeenCalledWith('hello world');
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith('Copied to clipboard', 'success');
  });
});
