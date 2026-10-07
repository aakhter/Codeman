/* Named assistant controls. All text is rendered with textContent; tokens live only in the open dialog. */
Object.assign(CodemanApp.prototype, {
  async assistantApi(path, method = 'GET', body) {
    const response = await this._api(path, { method, body });
    if (!response) throw new Error('Codeman is unavailable');
    const value = await response.json();
    if (!response.ok || value.success === false)
      throw new Error(value.error || value.message || 'Assistant operation failed');
    return value.data ?? value;
  },
  async refreshAssistants() {
    if (this._assistantRefreshing) return;
    this._assistantRefreshing = true;
    try {
      const data = await this.assistantApi('/api/assistants');
      this._assistants = data.assistants;
      this._assistantLocks = new Set(
        data.assistants
          .filter((a) => a.capabilities.inputLocked)
          .map((a) => a.binding?.sessionId)
          .filter(Boolean)
      );
      this.renderAssistantLock();
      if (this.$('assistantsDialog')?.open) await this.renderAssistants();
    } catch (error) {
      if (this.$('assistantsDialog')?.open) this.$('assistantsError').textContent = error.message;
    } finally {
      this._assistantRefreshing = false;
    }
  },
  renderAssistantLock() {
    const banner = this.$('assistantInputBanner');
    if (!banner) return;
    const a = this._assistants?.find(
      (a) => a.binding?.sessionId === this.activeSessionId && this._assistantLocks?.has(this.activeSessionId)
    );
    banner.hidden = !a;
    banner.querySelector('span').textContent = a
      ? `${a.name} is handed to messaging or needs review. Open Assistants to take control.`
      : '';
  },
  async openAssistants() {
    const dialog = this.$('assistantsDialog');
    if (!dialog.open) dialog.showModal();
    await this.refreshAssistants();
  },
  closeAssistants() {
    this.$('assistantsToken').value = '';
    this.$('assistantsTokenPanel').hidden = true;
    this.$('assistantsDialog').close();
  },
  async assistantAction(operation) {
    this.$('assistantsError').textContent = '';
    try {
      await operation();
      await this.refreshAssistants();
    } catch (error) {
      this.$('assistantsError').textContent = error.message;
    }
  },
  async createAssistant(event) {
    event.preventDefault();
    await this.assistantAction(() =>
      this.assistantApi('/api/assistants', 'POST', {
        name: this.$('assistantName').value,
        slug: this.$('assistantSlug').value,
      })
    );
  },
  async renderAssistants() {
    const list = this.$('assistantsList');
    if (list.contains(document.activeElement)) return;
    const sessionData = await this.assistantApi('/api/sessions');
    const sessions = (Array.isArray(sessionData) ? sessionData : (sessionData.sessions ?? [])).filter(
      (s) => s.mode === 'codex' && !s.remote && !s.docker && s.pid
    );
    const fragment = document.createDocumentFragment();
    const element = (tag, text) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (label, action, disabled = false) => {
      const b = element('button', label);
      b.type = 'button';
      b.className = 'btn-toolbar';
      b.disabled = disabled;
      b.onclick = () => {
        b.blur();
        return this.assistantAction(action);
      };
      return b;
    };
    for (const a of this._assistants ?? []) {
      const card = element('article');
      card.className = 'assistant-card';
      card.dataset.assistantId = a.id;
      card.append(
        element('h3', a.name),
        element(
          'p',
          a.capabilities.requestExecution
            ? 'Ready for messaging'
            : a.capabilities.needsAttention
              ? 'Needs review — take control and reconcile requests'
              : a.capabilities.handedOff
                ? 'Messaging paused'
                : 'Desktop control — handoff required'
        )
      );
      card.append(
        element(
          'p',
          a.binding
            ? `Session ${a.binding.sessionId}; conversation ${a.binding.conversationId}; binding ${a.binding.generation}`
            : 'Bind an existing local Codex session.'
        )
      );
      const select = element('select');
      select.setAttribute('aria-label', `Session for ${a.name}`);
      select.append(new Option('Choose a local Codex session', ''));
      for (const s of sessions) select.append(new Option(s.name || s.id, s.id));
      select.value = a.binding?.sessionId ?? '';
      const controls = element('div');
      controls.className = 'assistant-controls';
      controls.append(select);
      controls.append(
        button(
          'Bind / rebind',
          () =>
            this.assistantApi(`/api/assistants/${a.id}/binding`, 'POST', {
              sessionId: select.value,
              expectedRevision: a.revision,
              expectedGeneration: a.binding?.generation ?? 0,
            }),
          a.enabled || a.capabilities.handedOff
        )
      );
      controls.append(
        button(
          a.enabled ? 'Pause' : 'Enable',
          () =>
            this.assistantApi(`/api/assistants/${a.id}`, 'PATCH', {
              expectedRevision: a.revision,
              enabled: !a.enabled,
            }),
          !a.binding
        )
      );
      controls.append(
        button(
          'Disable session automation',
          async () => {
            for (const setting of ['auto-clear', 'auto-compact', 'checkpoint', 'auto-resume'])
              await this.assistantApi(`/api/sessions/${a.binding.sessionId}/${setting}`, 'POST', { enabled: false });
          },
          !a.binding || a.capabilities.handedOff
        )
      );
      controls.append(
        button(
          'Handoff to messaging',
          async () => {
            if (!this.$('assistantComposerEmpty').checked)
              throw new Error('Confirm that the terminal composer is empty and no task is running.');
            await this.assistantApi(`/api/assistants/${a.id}/handoff`, 'POST', {
              expectedRevision: a.revision,
              composerEmpty: true,
            });
            this.$('assistantComposerEmpty').checked = false;
          },
          !a.enabled || a.capabilities.handedOff
        )
      );
      controls.append(
        button('Take control', () => this.assistantApi(`/api/assistants/${a.id}/take-control`, 'POST', {}))
      );
      controls.append(
        button('Create connector token', async () => {
          const value = await this.assistantApi(`/api/assistants/${a.id}/tokens`, 'POST', {
            name: 'OpenClaw',
            scopes: ['read', 'submit', 'cancel'],
          });
          this.$('assistantsToken').value = value.token;
          this.$('assistantsTokenPanel').hidden = false;
        })
      );
      card.append(controls);
      const rename = element('input');
      rename.value = a.name;
      rename.maxLength = 60;
      rename.setAttribute('aria-label', `Rename ${a.name}`);
      const metadata = element('div');
      metadata.className = 'assistant-controls';
      metadata.append(
        rename,
        button('Save name', () =>
          this.assistantApi(`/api/assistants/${a.id}`, 'PATCH', { expectedRevision: a.revision, name: rename.value })
        )
      );
      metadata.append(
        button(
          'Delete assistant',
          async () => {
            if (
              window.confirm('Delete this assistant and revoke its connector tokens? The terminal session stays open.')
            )
              await this.assistantApi(`/api/assistants/${a.id}`, 'DELETE', { expectedRevision: a.revision });
          },
          a.enabled || a.capabilities.handedOff || a.capabilities.needsAttention
        )
      );
      card.append(metadata);
      const tokens = await this.assistantApi(`/api/assistants/${a.id}/tokens`);
      for (const token of tokens.tokens) {
        const row = element('div');
        row.className = 'assistant-controls';
        row.append(
          element('span', `${token.name}: ${token.scopes.join(', ')}`),
          button('Revoke token', () => this.assistantApi(`/api/assistants/${a.id}/tokens/${token.id}`, 'DELETE'))
        );
        card.append(row);
      }
      const data = await this.assistantApi(`/api/assistants/${a.id}/requests`);
      for (const r of data.requests.slice(-20).reverse()) {
        const row = element('section');
        row.className = 'assistant-request';
        row.append(
          element('strong', `${r.status}${r.reconciled ? ' (reviewed)' : ''}`),
          element('p', r.text),
          element('small', r.id)
        );
        if (r.reason) row.append(element('p', r.reason));
        if (r.result?.text) row.append(element('pre', r.result.text));
        if (r.status === 'queued')
          row.append(
            button('Cancel queued request', () =>
              this.assistantApi(`/api/assistant-requests/${r.id}/cancel`, 'POST', {})
            )
          );
        if (['interrupted', 'outcome_unknown'].includes(r.status) && !r.reconciled)
          row.append(
            button(
              'Confirm stopped and reconcile',
              async () => {
                if (!this.$('assistantReviewConfirmed').checked)
                  throw new Error('Confirm you stopped or completed the CLI task and reviewed possible side effects.');
                await this.assistantApi(`/api/assistant-requests/${r.id}/reconcile`, 'POST', {
                  acknowledgeSideEffects: true,
                });
                this.$('assistantReviewConfirmed').checked = false;
              },
              a.enabled || a.capabilities.handedOff
            )
          );
        card.append(row);
      }
      fragment.append(card);
    }
    if (!fragment.childNodes.length)
      fragment.append(element('p', 'No assistants yet. Create one, then bind your existing session.'));
    list.replaceChildren(fragment);
  },
});
document.addEventListener('DOMContentLoaded', () => {
  const dialog = document.getElementById('assistantsDialog');
  dialog?.addEventListener('cancel', () => {
    app.closeAssistants();
  });
  void app.refreshAssistants();
  setInterval(() => {
    if (!document.hidden) void app.refreshAssistants();
  }, 3000);
});
