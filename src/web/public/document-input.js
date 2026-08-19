/**
 * Document Input Mixin - "Add files" picker → upload → insert attachment block
 *
 * Companion to image-input.js. Codeman has no chat compose box: the xterm
 * terminal IS the input surface, so uploaded documents are surfaced by inserting
 * an `[Attachments: "<agentPath>", …]` block into the terminal via sendInput()
 * with NO trailing Enter — the user reviews and submits it themselves.
 *
 * Triggered from the paperclip drawer's "Add files" button
 * (ensureAttachmentHistoryDrawer() in panels-ui.js).
 *
 * @dependency app.js (uses global `app` for sendInput, activeSessionId, showToast)
 * @dependency panels-ui.js (provides showToast)
 */

Object.assign(CodemanApp.prototype, {
  // Max documents accepted in one batch. Each uploads as its own request; 10
  // stays well under the server's per-session upload rate limit.
  _maxBatchDocuments: 10,

  // Frontend copy of the server's UPLOAD_ALLOWED_EXTENSIONS (document-upload.ts).
  // Kept in sync with the <input accept> string below; used by the terminal
  // drag/drop splitter in image-input.js to pick documents out of a mixed drop.
  _documentUploadExtensions: [
    'pdf',
    'docx',
    'pptx',
    'xlsx',
    'md',
    'markdown',
    'txt',
    'py',
    'js',
    'ts',
    'jsx',
    'tsx',
    'json',
    'yaml',
    'yml',
    'toml',
    'ini',
    'cfg',
    'conf',
    'sh',
    'bash',
    'zsh',
    'go',
    'rs',
    'java',
    'c',
    'cpp',
    'h',
    'hpp',
    'cs',
    'rb',
    'php',
    'swift',
    'kt',
    'scala',
    'sql',
    'html',
    'css',
    'csv',
  ],

  // True when a dropped/selected File has an allowlisted document extension.
  // Extension-based (not MIME) because browsers report inconsistent types for
  // .md/.docx; the server re-validates by byte signature on upload.
  _isAllowedDocumentFile(file) {
    const name = (file && file.name) || '';
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return this._documentUploadExtensions.includes(name.slice(dot + 1).toLowerCase());
  },

  // Lazily create (once) a hidden multi-file <input> and click it. Resetting
  // input.value on each change lets re-picking the same file re-fire change.
  pickDocumentsForUpload() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'error');
      return;
    }

    if (!this._documentFileInput) {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept =
        '.pdf,.docx,.pptx,.xlsx,.md,.markdown,.txt,.py,.js,.ts,.jsx,.tsx,.json,.yaml,.yml,.toml,.ini,.cfg,.conf,.sh,.bash,.zsh,.go,.rs,.java,.c,.cpp,.h,.hpp,.cs,.rb,.php,.swift,.kt,.scala,.sql,.html,.css,.csv';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        // Snapshot into a stable array BEFORE resetting value: input.files is a
        // live FileList and `input.value = ''` empties it, so a captured
        // reference would read length 0.
        const files = Array.from(input.files || []);
        // Reset so selecting the same file again still fires 'change'.
        input.value = '';
        if (files.length) this._uploadAndInsertDocuments(files);
      });
      document.body.appendChild(input);
      this._documentFileInput = input;
    }

    this._documentFileInput.click();
  },

  async _uploadAndInsertDocuments(fileList) {
    const sessionId = this.activeSessionId;
    if (!sessionId) {
      this.showToast('No active session', 'error');
      return;
    }

    let files = Array.from(fileList || []);
    if (files.length === 0) return;

    // Cap the batch and tell the user what got dropped (no silent truncation).
    let capped = false;
    if (files.length > this._maxBatchDocuments) {
      files = files.slice(0, this._maxBatchDocuments);
      capped = true;
    }

    const total = files.length;
    let done = 0;
    const results = new Array(total); // structured results preserve selection order
    const progress = () =>
      this.showToast(`Uploading ${Math.min(done + 1, total)}/${total} document${total > 1 ? 's' : ''}…`, 'info');
    progress();

    // Bounded-concurrency worker pool over the file list (reuse the image cap).
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        try {
          results[i] = { ok: true, path: await this._uploadDocument(sessionId, files[i]) };
        } catch (err) {
          console.warn('Document upload failed:', err);
          results[i] = {
            ok: false,
            fileName: this._normalizeDocumentUploadText(files[i]?.name, 'document', 60),
            reason: this._normalizeDocumentUploadText(err?.message, 'Upload failed'),
          };
        } finally {
          done++;
          if (done < total) progress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this._uploadConcurrency || 3, total) }, () => worker()));

    const paths = results.filter((result) => result?.ok).map((result) => result.path);
    if (paths.length > 0) {
      // JSON.stringify each path so spaces/quotes/control chars can't break the
      // block, then join into a single [Attachments: "a", "b"] block. NO trailing
      // Enter — the user reviews and submits.
      const block = `[Attachments: ${paths.map((p) => JSON.stringify(p)).join(', ')}]`;
      await this.sendInput(block);
    }

    // Final status: successes, plus any failures / cap so nothing is silent.
    const failures = results.filter((result) => result && !result.ok);
    const firstFailure = failures[0];
    const parts = [];
    if (paths.length > 0) parts.push(`${paths.length} document${paths.length > 1 ? 's' : ''} ready`);
    if (firstFailure) parts.push(`${failures.length} failed`);
    if (capped) parts.push(`max ${this._maxBatchDocuments} per batch`);
    let finalMessage = parts.join(' · ') || 'No documents uploaded';
    if (firstFailure) finalMessage += `: ${firstFailure.fileName} — ${firstFailure.reason}`;
    const tone = paths.length > 0 ? (failures.length > 0 || capped ? 'info' : 'success') : 'error';
    this.showToast(this._normalizeDocumentUploadText(finalMessage, 'No documents uploaded'), tone);
  },

  // Server errors are untrusted display text. Keep the useful reason while
  // preventing multiline/oversized responses from taking over the toast.
  _normalizeDocumentUploadText(value, fallback, maxLength = 160) {
    const normalized = (typeof value === 'string' ? value : fallback).replace(/\s+/g, ' ').trim();
    return (normalized || fallback).slice(0, maxLength);
  },

  async _uploadDocument(sessionId, file) {
    const form = new FormData();
    // Field name MUST be "document" (matches the upload route). Do NOT set
    // Content-Type — the browser adds the multipart boundary. Same-origin fetch
    // sets Origin, so the route's CSRF check passes.
    form.append('document', file);

    const resp = await fetch('/api/sessions/' + sessionId + '/attachments/upload', {
      method: 'POST',
      body: form,
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error(typeof data?.error === 'string' && data.error ? data.error : 'HTTP ' + resp.status);
    }

    const agentPath = data?.success === true ? data.data?.agentPath : null;
    if (typeof agentPath !== 'string' || agentPath.trim().length === 0) {
      throw new Error('Upload failed');
    }
    return agentPath;
  },

  // Remove a Codeman-uploaded attachment copy (COD-241 unit 3). Only ever called
  // for history items whose relativePath is inside .codeman-attachments/ (the
  // "Remove" affordance is rendered under that condition in panels-ui.js). The
  // server enforces the same ownership gate, so a user's own detected/external
  // file can never be deleted here. On success the drawer is reloaded so the row
  // disappears; on any non-2xx the server's error message is toasted.
  async deleteUploadedAttachment(sessionId, relativePath) {
    if (!sessionId || !relativePath) return;
    try {
      const resp = await fetch(
        '/api/sessions/' + sessionId + '/attachments/uploaded?path=' + encodeURIComponent(relativePath),
        { method: 'DELETE' }
      );
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'HTTP ' + resp.status);
      }
      this.showToast('Attachment removed', 'success');
      await this.loadAttachmentHistory(sessionId);
      // a11y: the removed row's Remove button no longer exists after the list
      // re-renders, so move focus to a stable, sensible control in the drawer
      // (the "Add files" button) instead of letting it fall to <body>.
      document.getElementById('attachmentHistoryAddBtn')?.focus();
    } catch (err) {
      console.warn('Failed to remove attachment:', err);
      this.showToast('Remove failed: ' + (err.message || 'error'), 'error');
    }
  },
});
