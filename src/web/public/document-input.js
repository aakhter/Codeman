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
      input.accept = '.pdf,.docx,.pptx,.md,.markdown,.txt';
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
    let failed = 0;
    const results = new Array(total); // preserve selection order for insertion
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
          results[i] = await this._uploadDocument(sessionId, files[i]);
        } catch (err) {
          failed++;
          console.warn('Document upload failed:', err);
          results[i] = null;
        } finally {
          done++;
          if (done < total) progress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this._uploadConcurrency || 3, total) }, () => worker()));

    const paths = results.filter(Boolean);
    if (paths.length > 0) {
      // JSON.stringify each path so spaces/quotes/control chars can't break the
      // block, then join into a single [Attachments: "a", "b"] block. NO trailing
      // Enter — the user reviews and submits.
      const block = `[Attachments: ${paths.map((p) => JSON.stringify(p)).join(', ')}]`;
      await this.sendInput(block);
    }

    // Final status: successes, plus any failures / cap so nothing is silent.
    const parts = [];
    if (paths.length > 0) parts.push(`${paths.length} document${paths.length > 1 ? 's' : ''} ready`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (capped) parts.push(`max ${this._maxBatchDocuments} per batch`);
    const tone = paths.length > 0 ? (failed > 0 || capped ? 'info' : 'success') : 'error';
    this.showToast(parts.join(' · ') || 'No documents uploaded', tone);
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

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || 'HTTP ' + resp.status);
    }

    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.error || 'Upload failed');
    }
    return data.data.agentPath;
  },
});
