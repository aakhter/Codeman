/* Assistant overview. User content uses textContent; credentials stay in the open dialog only. */
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
      ? `${a.name} ${a.capabilities.needsAttention ? 'needs review' : 'is controlled by messaging'}. Open Assistants to take control.`
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
    this._assistantComposerConfirmed = undefined;
    this._assistantDetailsOpen = new Map();
    this.$('assistantsDialog').close();
  },
  toggleAssistantCreate(force) {
    const panel = this.$('assistantCreatePanel');
    panel.hidden = force === undefined ? !panel.hidden : !force;
    this.$('assistantAddButton').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) this.$('assistantName').focus();
  },
  async assistantAction(operation) {
    if (this._assistantActionPending) return;
    this._assistantActionPending = true;
    this.$('assistantsError').textContent = '';
    try {
      await operation();
    } catch (error) {
      this.$('assistantsError').textContent = error.message;
    } finally {
      this._assistantActionPending = false;
      await this.refreshAssistants();
    }
  },
  async createAssistant(event) {
    event.preventDefault();
    await this.assistantAction(async () => {
      const a = await this.assistantApi('/api/assistants', 'POST', {
        name: this.$('assistantName').value,
        slug: this.$('assistantSlug').value,
      });
      this._selectedAssistantId = a.id;
      event.target.reset();
      this.toggleAssistantCreate(false);
    });
  },
  assistantState(a) {
    if (a.capabilities.needsAttention) return { label: 'Needs review', tone: 'attention' };
    if (a.capabilities.recovery?.state === 'recovering') return { label: 'Recovering', tone: 'muted' };
    if (!a.capabilities.requestExecution && a.capabilities.recovery?.state === 'blocked')
      return { label: 'Recovery needed', tone: 'attention' };
    if (a.capabilities.requestExecution) return { label: 'Ready', tone: 'ready' };
    if (!a.binding) return { label: 'Setup needed', tone: 'muted' };
    return { label: a.enabled ? 'Handoff needed' : 'Paused', tone: 'muted' };
  },
  async renderAssistants() {
    const list = this.$('assistantsList');
    // Never replace a focused form control while the user edits it.
    if (list.contains(document.activeElement) && document.activeElement.tagName !== 'SUMMARY') return;
    const generation = (this._assistantRenderGeneration = (this._assistantRenderGeneration ?? 0) + 1);
    const assistants = this._assistants ?? [];
    const a = assistants.find((item) => item.id === this._selectedAssistantId) ?? assistants[0];
    this._selectedAssistantId = a?.id;
    this._assistantDetailsOpen ??= new Map();
    const element = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const icon = (name) => {
      const shapes = {
        brain:
          'M12 4C8 1 5 4 5 7C1 8 2 13 4 14C2 18 7 22 10 19L12 20L14 19C17 22 22 18 20 14C22 13 23 8 19 7C19 4 16 1 12 4ZM12 4V20M5 7L8 9M4 14L8 13M19 7L16 9M20 14L16 13',
        messaging: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2.5-4A8.5 8.5 0 1 1 21 11.5Z',
        folder: 'M3 7V20H21V7H12L10 4H3V7Z',
        document: 'M5 3H14L19 8V21H5V3ZM14 3V8H19M8 12H16M8 16H16',
        image: 'M3 3H21V21H3V3ZM3 17L9 11L14 16L17 13L21 17M7 7H8',
        person: 'M8 8A4 4 0 1 0 16 8A4 4 0 1 0 8 8M4 21V19C4 13 20 13 20 19V21H4Z',
        gear: 'M12 7A5 5 0 1 0 12 17A5 5 0 1 0 12 7M12 2V5M12 19V22M2 12H5M19 12H22M5 5L7 7M17 17L19 19M5 19L7 17M17 7L19 5',
      };
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.7',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      }))
        svg.setAttribute(key, value);
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', shapes[name] ?? shapes.document);
      svg.append(path);
      return svg;
    };
    const button = (label, action, disabled = false, style = '') => {
      const node = element('button', label, `assistant-button ${style}`);
      node.type = 'button';
      node.disabled = disabled || this._assistantActionPending;
      node.onclick = async () => {
        node.blur();
        node.disabled = true;
        await this.assistantAction(action);
        if (node.isConnected) node.disabled = disabled;
      };
      return node;
    };
    const badge = (text, tone = 'muted') => element('span', text, `assistant-badge assistant-${tone}`);
    const details = (label, key, openByDefault = false) => {
      const node = element('details', undefined, 'assistant-details');
      node.open = this._assistantDetailsOpen.get(key) ?? openByDefault;
      node.append(element('summary', label));
      node.firstChild.dataset.assistantFocusKey = key;
      node.addEventListener('toggle', () => {
        if (node.isConnected) this._assistantDetailsOpen.set(key, node.open);
      });
      return node;
    };
    if (!a) {
      const empty = element('section', undefined, 'assistant-empty');
      empty.append(
        icon('brain'),
        element('h3', 'Your sessions, within reach'),
        element('p', 'Create an assistant and connect it to an existing Codex, Claude or OpenCode session.')
      );
      list.replaceChildren(empty);
      this.$('assistantCreatePanel').hidden = false;
      this.$('assistantAddButton').setAttribute('aria-expanded', 'true');
      return;
    }
    const [sessionData, tokenData, data] = await Promise.all([
      this.assistantApi('/api/sessions'),
      this.assistantApi(`/api/assistants/${a.id}/tokens`),
      this.assistantApi(`/api/assistants/${a.id}/requests`),
    ]);
    if (
      generation !== this._assistantRenderGeneration ||
      this._selectedAssistantId !== a.id ||
      !this.$('assistantsDialog').open ||
      (list.contains(document.activeElement) && document.activeElement.tagName !== 'SUMMARY')
    )
      return;
    const allSessions = Array.isArray(sessionData) ? sessionData : (sessionData.sessions ?? []);
    const sessions = allSessions.filter(
      (s) => ['codex', 'claude', 'opencode'].includes(s.mode) && !s.remote && !s.docker && s.pid
    );
    const bound = allSessions.find((s) => s.id === a.binding?.sessionId);
    const state = this.assistantState(a);
    const layout = element('div', undefined, 'assistant-layout');
    const nav = element('nav', undefined, 'assistant-nav');
    nav.setAttribute('aria-label', 'Your assistants');
    nav.append(element('p', 'Your assistants', 'assistant-nav-heading'));
    for (const item of assistants) {
      const selected = item.id === a.id;
      const entry = element('button', undefined, `assistant-nav-item${selected ? ' is-selected' : ''}`);
      entry.type = 'button';
      entry.setAttribute('aria-pressed', String(selected));
      const text = element('span');
      text.append(element('strong', item.name), element('small', this.assistantState(item).label));
      entry.append(icon('brain'), text);
      entry.onclick = () => {
        if (this._assistantActionPending) return;
        entry.blur();
        this._selectedAssistantId = item.id;
        this._assistantComposerConfirmed = undefined;
        this.$('assistantsToken').value = '';
        this.$('assistantsTokenPanel').hidden = true;
        void this.renderAssistants().catch((error) => {
          this.$('assistantsError').textContent = error.message;
        });
      };
      nav.append(entry);
    }
    const card = element('article', undefined, 'assistant-card');
    card.dataset.assistantId = a.id;
    const head = element('div', undefined, 'assistant-profile');
    const avatar = element('span', undefined, 'assistant-avatar');
    avatar.append(icon('brain'));
    const heading = element('div');
    const title = element('div', undefined, 'assistant-title-row');
    title.append(element('h3', a.name), badge(state.label, state.tone));
    heading.append(
      title,
      element(
        'p',
        `${bound?.name || (a.binding ? 'Bound session unavailable' : 'Choose a session')} · ${{ codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }[a.mode] || a.mode}`,
        'assistant-secondary'
      )
    );
    head.append(avatar, heading);
    card.append(head);
    if (a.capabilities.recovery) {
      const recovery = a.capabilities.recovery;
      card.append(
        element(
          'p',
          recovery.state === 'armed'
            ? 'Automatic recovery will resume this conversation if its session stops.'
            : recovery.state === 'recovering'
              ? 'Reconnecting to the original conversation. Messaging will resume after verification.'
              : recovery.reason || 'Automatic recovery needs desktop review.',
          'assistant-secondary'
        )
      );
    }
    const tiles = element('div', undefined, 'assistant-tiles');
    const connection = element('section', undefined, 'assistant-tile');
    const messaging = element('span', undefined, 'assistant-channel-icon');
    messaging.append(icon('messaging'));
    const connectionText = element('div');
    connectionText.append(
      element('h4', 'Messaging'),
      badge(state.label, state.tone),
      element(
        'p',
        tokenData.tokens.length ? 'Connector access issued' : 'Create connector access in Advanced settings',
        'assistant-secondary'
      )
    );
    connection.append(messaging, connectionText);
    const sessionTile = element('section', undefined, 'assistant-tile');
    sessionTile.append(icon('folder'));
    const sessionText = element('div');
    sessionText.append(
      element('h4', 'Session'),
      element('p', bound?.name || (a.binding ? 'Unavailable' : 'Not connected')),
      element(
        'small',
        `Local ${{ codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }[a.mode] || a.mode}`,
        'assistant-secondary'
      )
    );
    if (bound)
      sessionText.append(
        button(
          'Open session →',
          () => {
            this.closeAssistants();
            return this.selectSession(bound.id);
          },
          false,
          'assistant-link'
        )
      );
    sessionTile.append(sessionText);
    tiles.append(connection, sessionTile);
    card.append(tiles);
    const ownership = element('section', undefined, 'assistant-ownership');
    const ownerTitle = a.capabilities.needsAttention
      ? 'Review needed before messaging resumes'
      : a.capabilities.handedOff
        ? 'Messaging is in control'
        : 'Desktop is in control';
    const ownerText = element('div');
    ownerText.append(
      element('h4', ownerTitle),
      element(
        'p',
        a.capabilities.handedOff
          ? 'Take control to type directly in the session.'
          : a.capabilities.needsAttention
            ? 'Take control, review the task, and reconcile it below.'
            : 'Hand off an idle session to receive messaging requests.',
        'assistant-secondary'
      )
    );
    ownership.append(ownerText);
    if (a.capabilities.handedOff || a.capabilities.inputLocked || a.capabilities.needsAttention) {
      ownership.append(
        button(
          'Take control',
          () => this.assistantApi(`/api/assistants/${a.id}/take-control`, 'POST', {}),
          false,
          'assistant-accent'
        )
      );
    } else if (a.binding) {
      if (!a.enabled)
        ownership.append(
          button(
            'Enable assistant',
            () =>
              this.assistantApi(`/api/assistants/${a.id}`, 'PATCH', { expectedRevision: a.revision, enabled: true }),
            false,
            'assistant-primary'
          )
        );
      const label = element('label', undefined, 'assistant-confirmation');
      const confirm = element('input');
      confirm.type = 'checkbox';
      confirm.id = 'assistantComposerEmpty';
      confirm.checked = this._assistantComposerConfirmed === a.id;
      confirm.onchange = () => {
        this._assistantComposerConfirmed = confirm.checked ? a.id : undefined;
      };
      label.append(
        confirm,
        element('span', 'The terminal composer is empty, no task is running, and no direct tmux attachment is in use.')
      );
      ownership.append(label);
      ownership.append(
        button(
          'Handoff to messaging',
          async () => {
            if (!confirm.checked)
              throw new Error('Confirm that the terminal composer is empty and no task is running.');
            await this.assistantApi(`/api/assistants/${a.id}/handoff`, 'POST', {
              expectedRevision: a.revision,
              composerEmpty: true,
            });
            this._assistantComposerConfirmed = undefined;
          },
          !a.enabled,
          'assistant-accent'
        )
      );
    }
    card.append(ownership);
    const activity = element('section', undefined, 'assistant-activity');
    const activityHead = element('div', undefined, 'assistant-section-heading');
    activityHead.append(element('h4', 'Recent activity'));
    if (data.requests.length > 5) {
      const show = element(
        'button',
        this._assistantShowAll === a.id ? 'Show less' : 'View all',
        'assistant-button assistant-link'
      );
      show.type = 'button';
      show.onclick = () => {
        show.blur();
        this._assistantShowAll = this._assistantShowAll === a.id ? undefined : a.id;
        void this.renderAssistants().catch((error) => {
          this.$('assistantsError').textContent = error.message;
        });
      };
      activityHead.append(show);
    }
    activity.append(activityHead);
    const statuses = {
      queued: ['Queued', 'muted'],
      dispatching: ['Sending', 'muted'],
      running: ['Working', 'ready'],
      awaiting_approval: ['Needs approval', 'attention'],
      completed: ['Completed', 'ready'],
      cancelled: ['Cancelled', 'muted'],
      failed: ['Failed', 'attention'],
      interrupted: ['Interrupted', 'attention'],
      outcome_unknown: ['Needs review', 'attention'],
    };
    const visibleIds = new Set(data.requests.slice(this._assistantShowAll === a.id ? 0 : -5).map((r) => r.id));
    for (const r of data.requests) {
      if (
        ['dispatching', 'running', 'awaiting_approval'].includes(r.status) ||
        (['interrupted', 'outcome_unknown'].includes(r.status) && !r.reconciled)
      )
        visibleIds.add(r.id);
    }
    const requests = data.requests.filter((r) => visibleIds.has(r.id)).reverse();
    for (const r of requests) {
      const status = statuses[r.status] ?? ['Needs review', 'attention'];
      const request = details('', `request:${r.id}`);
      request.classList.add('assistant-request');
      const summary = request.firstChild;
      const prompt = r.text.split(' Use your file and image tools to inspect these Telegram attachments')[0];
      summary.append(icon(/\.(png|jpg|jpeg|webp)/i.test(r.text) ? 'image' : 'document'));
      const summaryText = element('span', undefined, 'assistant-request-title');
      summaryText.append(
        element('strong', prompt || 'Attachment request'),
        element('small', status[0], 'assistant-secondary')
      );
      const stamp = element(
        'time',
        new Date(r.createdAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        'assistant-request-time'
      );
      stamp.dateTime = new Date(r.createdAt).toISOString();
      summary.append(summaryText, badge(status[0], status[1]), stamp);
      const body = element('div', undefined, 'assistant-request-body');
      if (r.reason) body.append(element('p', r.reason));
      if (r.result?.text) body.append(element('pre', r.result.text));
      if (r.status === 'queued')
        body.append(
          button('Cancel queued request', () => this.assistantApi(`/api/assistant-requests/${r.id}/cancel`, 'POST', {}))
        );
      if (['interrupted', 'outcome_unknown'].includes(r.status) && !r.reconciled) {
        request.open = true;
        const review = element('label', undefined, 'assistant-confirmation');
        const checked = element('input');
        checked.type = 'checkbox';
        review.append(checked, element('span', 'I stopped or completed the task and reviewed possible side effects.'));
        body.append(
          review,
          button(
            'Confirm stopped and reconcile',
            async () => {
              if (!checked.checked)
                throw new Error('Confirm you stopped or completed the CLI task and reviewed possible side effects.');
              await this.assistantApi(`/api/assistant-requests/${r.id}/reconcile`, 'POST', {
                acknowledgeSideEffects: true,
              });
            },
            a.enabled || a.capabilities.handedOff
          )
        );
      }
      const technical = details('Request details', `technical:${r.id}`);
      technical.append(element('small', `Request ${r.id}${r.reconciled ? ' · Reviewed' : ''}`), element('pre', r.text));
      body.append(technical);
      request.append(body);
      activity.append(request);
    }
    if (!requests.length)
      activity.append(
        element('p', 'No requests yet. Send a message to your assistant to get started.', 'assistant-secondary')
      );
    card.append(activity);
    card.append(element('p', `Try: ${a.slug}, summarize this PDF`, 'assistant-hint'));
    const advanced = details('Advanced settings', `advanced:${a.id}`, !a.binding);
    const settings = element('div', undefined, 'assistant-advanced-body');
    settings.append(
      element('h4', 'Session setup'),
      element(
        'p',
        'Disable conflicting automation and stop respawn/Ralph before handoff. After a restart, review and hand off again.',
        'assistant-secondary'
      )
    );
    const select = element('select');
    select.setAttribute('aria-label', `Session for ${a.name}`);
    select.append(new Option('Choose a local Codex, Claude or OpenCode session', ''));
    for (const s of sessions) select.append(new Option(`${s.name || s.id} · ${s.mode}`, s.id));
    select.value = a.binding?.sessionId ?? '';
    const controls = element('div', undefined, 'assistant-controls');
    controls.append(
      select,
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
          this.assistantApi(`/api/assistants/${a.id}`, 'PATCH', { expectedRevision: a.revision, enabled: !a.enabled }),
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
    settings.append(controls);
    if (a.binding)
      settings.append(
        element(
          'p',
          `Session ${a.binding.sessionId} · Conversation ${a.binding.conversationId} · Binding ${a.binding.generation}`,
          'assistant-technical'
        )
      );
    settings.append(element('h4', 'Name'));
    const rename = element('input');
    rename.value = a.name;
    rename.maxLength = 60;
    rename.setAttribute('aria-label', `Rename ${a.name}`);
    const metadata = element('div', undefined, 'assistant-controls');
    metadata.append(
      rename,
      button('Save name', () =>
        this.assistantApi(`/api/assistants/${a.id}`, 'PATCH', { expectedRevision: a.revision, name: rename.value })
      )
    );
    settings.append(metadata, element('h4', 'Connector access'));
    settings.append(
      button('Create connector token', async () => {
        const value = await this.assistantApi(`/api/assistants/${a.id}/tokens`, 'POST', {
          name: 'OpenClaw',
          scopes: ['read', 'submit', 'cancel'],
        });
        this.$('assistantsToken').value = value.token;
        this.$('assistantsTokenPanel').hidden = false;
      })
    );
    for (const token of tokenData.tokens) {
      const row = element('div', undefined, 'assistant-controls');
      row.append(
        element('span', `${token.name}: ${token.scopes.join(', ')}`),
        button('Revoke token', () => this.assistantApi(`/api/assistants/${a.id}/tokens/${token.id}`, 'DELETE'))
      );
      settings.append(row);
    }
    settings.append(
      element('h4', 'Remove assistant'),
      button(
        'Delete assistant',
        async () => {
          if (window.confirm('Delete this assistant and revoke its connector tokens? The terminal session stays open.'))
            await this.assistantApi(`/api/assistants/${a.id}`, 'DELETE');
        },
        a.enabled || a.capabilities.handedOff || a.capabilities.needsAttention
      )
    );
    advanced.append(settings);
    card.append(advanced);
    layout.append(nav, card);
    const dialog = this.$('assistantsDialog');
    const scroll = dialog.scrollTop;
    const focusKey = list.contains(document.activeElement)
      ? document.activeElement.dataset.assistantFocusKey
      : undefined;
    list.replaceChildren(layout);
    dialog.scrollTop = this._assistantRenderedId === a.id ? scroll : 0;
    this._assistantRenderedId = a.id;
    if (focusKey)
      [...list.querySelectorAll('summary')]
        .find((summary) => summary.dataset.assistantFocusKey === focusKey)
        ?.focus({ preventScroll: true });
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
