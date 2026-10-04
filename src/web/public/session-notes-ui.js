/** Session panel and global browser share one owner-scoped canonical notebook collection. */
(function () {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text, action) => {
    const element = node('button', text, 'btn-toolbar');
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  };
  const field = (tag, label) => {
    const element = node(tag);
    element.setAttribute('aria-label', label);
    return element;
  };
  Object.assign(CodemanApp.prototype, {
    async _notesRequest(path = '', body, method = 'GET') {
      const response = await fetch('/api/session-notes' + path, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        const error = new Error(payload.error || 'Notes request failed');
        error.status = response.status;
        error.current = payload.data?.current;
        error.data = payload.data;
        throw error;
      }
      return payload.data;
    },
    async _initSessionNotes() {
      if (!this._notesReady) {
        this._notesReady = (async () => {
          const scope = await this._notesRequest('/context');
          this._notesScope = scope;
          this._notesController = new window.SessionNotesEditor({
            scope,
            storage: {
              getItem: (key) => window.localStorage.getItem(key),
              setItem: (key, value) => window.localStorage.setItem(key, value),
              removeItem: (key) => window.localStorage.removeItem(key),
            },
            request: (...args) => this._notesRequest(...args),
            changed: (state) => this._renderNotesState(state),
          });
          window.addEventListener('pagehide', () => this._notesController.flush());
          document.addEventListener('visibilitychange', () => {
            if (document.hidden) this._notesController.flush();
          });
        })().catch((error) => {
          this._notesReady = null;
          throw error;
        });
      }
      await this._notesReady;
      this._notesProjects = await this._notesRequest('/projects');
    },
    _notesError(error) {
      if (this._notesShell) {
        this._notesErrorElement.textContent = error.message || 'Notes unavailable';
      } else {
        this.showToast?.(error.message || 'Notes unavailable', 'error');
      }
    },
    _createNotesShell(mode) {
      this.closeSessionNotes();
      this._notesReturnFocus = document.activeElement;
      this._notesMode = mode;
      const shell = node('section', undefined, 'session-notes-shell session-notes-' + mode);
      shell.setAttribute('aria-label', mode === 'browser' ? 'Notes browser' : 'Session notes');
      const modal = mode === 'browser' || window.innerWidth < 768;
      shell.setAttribute('role', modal ? 'dialog' : 'complementary');
      if (modal) shell.setAttribute('aria-modal', 'true');
      const header = node('header', undefined, 'notes-shell-header');
      header.append(
        node('h2', 'Notes'),
        button(mode === 'panel' ? 'Back to session' : 'Close notes', () => this.closeSessionNotes())
      );
      shell.append(header);
      this._notesErrorElement = node('div', '', 'notes-error');
      this._notesErrorElement.setAttribute('role', 'alert');
      shell.append(this._notesErrorElement);
      const body = node('div', undefined, 'notes-shell-body');
      shell.append(body);
      this._notesShell = shell;
      this._notesBody = body;
      this._notesEditorHost = node('div', undefined, 'notes-editor');
      body.append(this._notesEditorHost);
      if (mode === 'panel' && !modal) {
        const wrap = document.querySelector('.terminal-wrap');
        const separator = node('div', undefined, 'notes-resizer');
        separator.tabIndex = 0;
        separator.setAttribute('role', 'separator');
        separator.setAttribute('aria-label', 'Resize notes panel');
        separator.setAttribute('aria-orientation', 'vertical');
        const resize = (width) => {
          const maximum = Math.max(280, (wrap?.clientWidth || window.innerWidth) - 360);
          const value = Math.max(280, Math.min(width, maximum));
          shell.style.width = value + 'px';
          separator.setAttribute('aria-valuenow', String(Math.round(value)));
          separator.setAttribute('aria-valuemin', '280');
          separator.setAttribute('aria-valuemax', String(Math.round(maximum)));
          window.dispatchEvent(new Event('resize'));
        };
        separator.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            resize(shell.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 20 : -20));
          }
        });
        separator.addEventListener('pointerdown', (event) => {
          separator.setPointerCapture(event.pointerId);
          const move = (e) => resize(shell.getBoundingClientRect().right - e.clientX);
          const end = () => {
            separator.removeEventListener('pointermove', move);
            separator.removeEventListener('pointerup', end);
            separator.removeEventListener('pointercancel', end);
            window.dispatchEvent(new Event('resize'));
          };
          separator.addEventListener('pointermove', move);
          separator.addEventListener('pointerup', end);
          separator.addEventListener('pointercancel', end);
        });
        shell.prepend(separator);
        wrap?.classList.add('notes-open');
        (wrap || document.body).append(shell);
        resize(420);
      } else {
        document.body.append(shell);
        if (typeof FocusTrap !== 'undefined') {
          this._notesTrap = new FocusTrap(shell);
          this._notesTrap.activate();
        }
        const viewport = window.visualViewport;
        this._notesViewportHandler = () => {
          shell.style.height = (viewport?.height || window.innerHeight) + 'px';
          shell.style.top = (viewport?.offsetTop || 0) + 'px';
        };
        viewport?.addEventListener('resize', this._notesViewportHandler);
        viewport?.addEventListener('scroll', this._notesViewportHandler);
        this._notesViewportHandler();
      }
      shell.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.closeSessionNotes();
        }
      });
      header.querySelector('button').focus();
      return shell;
    },
    closeSessionNotes() {
      this._notesNavigation = (this._notesNavigation || 0) + 1;
      this._notesListSequence = (this._notesListSequence || 0) + 1;
      clearTimeout(this._notesFilterTimer);
      this._notesController?.flush();
      this._notesTrap?.deactivate();
      this._notesTrap = null;
      if (this._notesViewportHandler) {
        window.visualViewport?.removeEventListener('resize', this._notesViewportHandler);
        window.visualViewport?.removeEventListener('scroll', this._notesViewportHandler);
        this._notesViewportHandler = null;
      }
      this._notesShell?.remove();
      this._notesShell = null;
      this._notesEditorElements = null;
      document.querySelector('.terminal-wrap')?.classList.remove('notes-open');
      this._notesReturnFocus?.focus?.();
      window.dispatchEvent(new Event('resize'));
    },
    async openSessionNotes(sessionId = this.activeSessionId) {
      if (!sessionId) return;
      this._createNotesShell('panel');
      const navigation = this._notesNavigation;
      try {
        await this._initSessionNotes();
        const note = await this._notesRequest('/open', { sessionId }, 'POST');
        if (navigation !== this._notesNavigation) return;
        this._mountNotesEditor(note);
      } catch (error) {
        if (navigation !== this._notesNavigation) return;
        if (error.status === 422) this._mountNotesRepair(error.data);
        else this._notesError(error);
      }
    },
    async openNotesBrowser() {
      this._createNotesShell('browser');
      const navigation = this._notesNavigation;
      try {
        await this._initSessionNotes();
        if (navigation !== this._notesNavigation) return;
        this._mountNotesBrowser();
        await this._refreshNotesList();
      } catch (error) {
        if (navigation === this._notesNavigation) this._notesError(error);
      }
    },
    _mountNotesBrowser() {
      const sidebar = node('nav', undefined, 'notes-projects');
      sidebar.setAttribute('aria-label', 'Notes projects');
      const filters = node('div', undefined, 'notes-filters');
      const search = field('input', 'Search notes');
      search.type = 'search';
      search.placeholder = 'Search title and notes';
      const session = field('input', 'Filter by originating session');
      session.placeholder = 'Session ID';
      const unfinished = field('input', 'Only unfinished items');
      unfinished.type = 'checkbox';
      const label = node('label', 'Unfinished items');
      label.prepend(unfinished);
      const list = node('div', undefined, 'notes-list');
      list.setAttribute('aria-label', 'Notebooks');
      list.setAttribute('aria-live', 'polite');
      const column = node('div', undefined, 'notes-list-column');
      filters.append(
        search,
        session,
        label,
        button('Refresh', () => this._refreshNotesList())
      );
      column.append(filters, list);
      this._notesBody.prepend(sidebar, column);
      this._notesFilters = { search, session, unfinished, projectId: '' };
      this._notesList = list;
      this._notesSidebar = sidebar;
      const select = (id) => {
        this._notesFilters.projectId = id;
        this._renderNotesProjects();
        this._refreshNotesList();
      };
      this._notesSelectProject = select;
      for (const input of [search, session])
        input.addEventListener('input', () => {
          clearTimeout(this._notesFilterTimer);
          this._notesFilterTimer = setTimeout(() => this._refreshNotesList(), 200);
        });
      unfinished.addEventListener('change', () => this._refreshNotesList());
      this._renderNotesProjects();
      this._notesEditorHost.append(node('p', 'Choose a notebook. Notes remain available after its session ends.'));
    },
    _renderNotesProjects() {
      const sidebar = this._notesSidebar;
      sidebar.replaceChildren();
      const all = button('All projects', () => this._notesSelectProject(''));
      all.setAttribute('aria-pressed', String(!this._notesFilters.projectId));
      sidebar.append(all);
      for (const project of this._notesProjects) {
        const row = node('div', undefined, 'notes-project-row');
        const select = button(project.name + (project.historical ? ' (historical)' : ''), () =>
          this._notesSelectProject(project.id)
        );
        select.setAttribute('aria-pressed', String(this._notesFilters.projectId === project.id));
        const rename = button('Rename', async () => {
          const name = window.prompt('Project display name', project.name);
          if (!name?.trim()) return;
          try {
            await this._notesRequest('/projects/' + encodeURIComponent(project.id), { name }, 'PATCH');
            this._notesProjects = await this._notesRequest('/projects');
            this._renderNotesProjects();
            await this._refreshNotesList();
          } catch (error) {
            this._notesError(error);
          }
        });
        rename.setAttribute('aria-label', 'Rename project ' + project.name);
        row.append(select, rename);
        sidebar.append(row);
      }
    },
    async _refreshNotesList() {
      if (!this._notesShell || this._notesMode !== 'browser' || !this._notesFilters) return;
      const sequence = (this._notesListSequence = (this._notesListSequence || 0) + 1);
      const filters = this._notesFilters;
      const query = new URLSearchParams();
      if (filters.search.value) query.set('q', filters.search.value);
      if (filters.session.value) query.set('sessionId', filters.session.value);
      if (filters.projectId) query.set('projectId', filters.projectId);
      if (filters.unfinished.checked) query.set('unfinished', 'true');
      try {
        const [entries, recovery] = await Promise.all([
          this._notesRequest('?' + query),
          this._notesRequest('/recovery'),
        ]);
        if (!this._notesShell || sequence !== this._notesListSequence || this._notesMode !== 'browser') return;
        this._notesList.replaceChildren();
        if (!entries.length) this._notesList.append(node('p', 'No matching notebooks'));
        for (const entry of entries) {
          const metadata = entry.note?.metadata;
          const row = node('article', undefined, 'notes-list-row');
          const open = button(metadata?.title || 'Notebook requires repair', () => this.openNotesNotebook(entry.id));
          const project = this._notesProjects.find((p) => p.id === entry.projectId);
          row.append(
            open,
            node('div', project?.name || entry.projectId),
            node('div', metadata?.sessionTitle || metadata?.sessionId || 'Retained notebook')
          );
          const time = entry.lastModified ? new Date(entry.lastModified).toLocaleString() : 'Not yet saved';
          row.append(node('small', time + ' · ' + (entry.unfinishedCount || 0) + ' unfinished'));
          if (entry.error) row.append(node('p', entry.error, 'notes-error'));
          if (entry.conflict && (entry.revision || entry.note?.revision)) {
            row.append(
              node('p', entry.conflict),
              button('Keep external version', () => this._resolveNotesRecovery(entry, 'external')),
              button('Keep staged version', () => this._resolveNotesRecovery(entry, 'staged'))
            );
          }
          for (const item of entry.checklist || []) {
            if (item.checked) continue;
            const task = node('label', undefined, 'notes-checklist-item');
            const check = field('input', 'Complete ' + item.text);
            check.type = 'checkbox';
            check.addEventListener('change', async () => {
              check.disabled = true;
              try {
                const saved = await this._notesRequest(
                  '/' + encodeURIComponent(entry.id) + '/checklist',
                  { revision: entry.note.revision, line: item.line, checked: true },
                  'PATCH'
                );
                if (this._notesController.current?.id === entry.id) this._notesController.external(saved);
                await this._refreshNotesList();
              } catch (error) {
                check.checked = false;
                check.disabled = false;
                this._notesError(error);
                await this._refreshNotesList();
              }
            });
            task.append(
              check,
              button(item.text, () => this.openNotesNotebook(entry.id))
            );
            row.append(task);
          }
          this._notesList.append(row);
        }
        if (recovery.length) {
          const details = node('details');
          details.append(node('summary', recovery.length + ' preserved recovery artifacts'));
          for (const issue of recovery) {
            details.append(node('p', issue.path), node('p', issue.error), node('pre', issue.raw));
          }
          this._notesList.append(details);
        }
      } catch (error) {
        this._notesError(error);
      }
    },
    async _resolveNotesRecovery(entry, choice) {
      try {
        await this._notesRequest(
          '/' + encodeURIComponent(entry.id) + '/resolve-recovery',
          { revision: entry.revision || entry.note?.revision, projectId: entry.projectId, choice },
          'POST'
        );
        await this._refreshNotesList();
      } catch (error) {
        this._notesError(error);
      }
    },
    async openNotesNotebook(id) {
      this._notesController?.flush();
      const sequence = (this._notesNotebookSequence = (this._notesNotebookSequence || 0) + 1);
      const navigation = this._notesNavigation;
      try {
        const note = await this._notesRequest('/' + encodeURIComponent(id));
        if (sequence !== this._notesNotebookSequence || navigation !== this._notesNavigation || !this._notesShell)
          return;
        this._mountNotesEditor(note);
      } catch (error) {
        if (sequence !== this._notesNotebookSequence || navigation !== this._notesNavigation) return;
        if (error.status === 422) this._mountNotesRepair(error.data);
        else this._notesError(error);
      }
    },
    _mountNotesEditor(note) {
      this._notesErrorElement.textContent = '';
      const host = this._notesEditorHost;
      host.replaceChildren();
      const title = field('input', 'Notebook title');
      title.maxLength = 256;
      const status = node('span', '', 'notes-save-status');
      status.setAttribute('role', 'status');
      const source = button('Source: ' + (note.metadata.sessionTitle || note.metadata.sessionId), () =>
        this.showNotesSource()
      );
      source.setAttribute('aria-label', 'Source session');
      const project = field('select', 'Reassign notebook project');
      for (const item of this._notesProjects) {
        const option = node('option', item.name);
        option.value = item.id;
        project.append(option);
      }
      const actions = node('div', undefined, 'notes-editor-actions');
      const previewButton = button('Preview', () => {
        const elements = this._notesEditorElements;
        if (!elements) return;
        elements.previewing = !elements.previewing;
        previewButton.textContent = elements.previewing ? 'Edit' : 'Preview';
        this._renderNotesState(this._notesController.current);
      });
      const exportLink = node('a', 'Download Markdown', 'btn-toolbar');
      exportLink.href = '/api/session-notes/' + encodeURIComponent(note.metadata.id) + '/export';
      exportLink.download = '';
      const template = button('Insert starter headings', () => {
        const state = this._notesController.current;
        if (!state.markdown.trim()) this._notesController.edit('# Notes\n\n## Ideas\n\n## Next steps\n\n', state.title);
      });
      const retry = button('Save now / Retry', () => this._notesController.flush());
      actions.append(previewButton, retry, template, exportLink);
      const markdown = field('textarea', 'Markdown notes');
      markdown.spellcheck = true;
      const preview = node('div', undefined, 'notes-preview');
      preview.hidden = true;
      const conflict = node('div', undefined, 'notes-conflict');
      conflict.hidden = true;
      const errors = node('p', '', 'notes-error');
      errors.setAttribute('role', 'alert');
      const sourceSummary = node('div', undefined, 'notes-source-summary');
      sourceSummary.hidden = true;
      host.append(title, status, project, source, sourceSummary, actions, errors, conflict, markdown, preview);
      this._notesEditorElements = {
        id: note.metadata.id,
        title,
        status,
        project,
        markdown,
        preview,
        previewing: false,
        conflict,
        errors,
        template,
        sourceSummary,
        exportLink,
      };
      const edit = () => this._notesController.edit(markdown.value, title.value);
      markdown.addEventListener('input', edit);
      title.addEventListener('input', edit);
      project.addEventListener('change', async () => {
        const state = this._notesController.current;
        const wanted = project.value;
        project.disabled = true;
        try {
          await this._notesController.flush(state);
          if (state.dirty || state.conflict)
            throw new Error('Save or resolve the draft before reassigning its project.');
          const saved = await this._notesRequest(
            '/' + encodeURIComponent(state.id) + '/reassign',
            { revision: state.revision, projectId: wanted },
            'POST'
          );
          if (this._notesController.current === state) this._notesController.external(saved);
          await this._refreshNotesList();
        } catch (error) {
          this._notesError(error);
          project.value = state.note.metadata.projectId;
        } finally {
          project.disabled = false;
        }
      });
      this._notesController.load(note);
      markdown.focus();
    },
    _renderNotesState(state) {
      const elements = this._notesEditorElements;
      if (!elements || elements.id !== state.id || !this._notesShell) return;
      if (elements.markdown.value !== state.markdown) elements.markdown.value = state.markdown;
      if (elements.title.value !== state.title) elements.title.value = state.title;
      elements.status.textContent = state.status;
      elements.errors.textContent = [state.error, state.storageError].filter(Boolean).join(' ');
      elements.project.value = state.note.metadata.projectId;
      elements.template.hidden = Boolean(state.markdown.trim());
      elements.markdown.hidden = elements.previewing;
      elements.preview.hidden = !elements.previewing;
      if (elements.previewing) {
        const parsed = typeof marked !== 'undefined' ? marked.parse(state.markdown) : '';
        if (window.sanitizeMarkdownHtml) elements.preview.innerHTML = window.sanitizeMarkdownHtml(parsed);
        else elements.preview.textContent = state.markdown;
      }
      elements.conflict.hidden = !state.conflict;
      elements.conflict.replaceChildren();
      if (state.conflict) {
        elements.conflict.append(
          node('h3', 'Notes changed. Compare before saving.'),
          node('h4', 'Current file'),
          node('pre', state.conflict.markdown ?? state.conflict.raw ?? 'Current file unavailable'),
          node('h4', 'Your draft'),
          node('pre', state.markdown)
        );
        if (state.conflict.metadata) {
          for (const [text, choice] of [
            ['Reload current', 'reload'],
            ['Combine current and draft', 'combine'],
            ['Replace current with my draft', 'replace'],
          ]) {
            elements.conflict.append(button(text, () => this._notesController.resolve(choice)));
          }
        } else {
          elements.conflict.append(
            node(
              'p',
              'Automatic saving is blocked. Your draft is retained; open the notebook from the browser to inspect repair or recovery options.'
            )
          );
        }
      }
    },
    _mountNotesRepair(data) {
      this._notesEditorElements = null;
      const host = this._notesEditorHost;
      host.replaceChildren();
      host.append(
        node('h3', 'Notebook requires repair'),
        node('p', 'Original bytes are preserved. Repair is an explicit action; this content will not autosave.'),
        node('pre', data.raw || '')
      );
      if (data.repairable && data.id) {
        const markdown = field('textarea', 'Repaired Markdown notes');
        host.append(
          markdown,
          button('Repair notebook', async () => {
            try {
              const note = await this._notesRequest(
                '/' + encodeURIComponent(data.id) + '/repair',
                { revision: data.revision, markdown: markdown.value },
                'POST'
              );
              this._mountNotesEditor(note);
              await this._refreshNotesList();
            } catch (error) {
              this._notesError(error);
            }
          })
        );
      } else
        host.append(
          node(
            'p',
            'Trusted original session metadata is unavailable. Restore a valid notebook from your backup before editing.'
          )
        );
    },
    async showNotesSource() {
      const state = this._notesController.current;
      const element = this._notesEditorElements?.sourceSummary;
      if (!state || !element) return;
      element.hidden = false;
      const metadata = state.note.metadata;
      element.replaceChildren(
        node(
          'p',
          (metadata.sessionTitle || metadata.sessionId) +
            ' · ' +
            metadata.executionLocation +
            ' · ' +
            metadata.workingDir
        )
      );
      // Read-only metadata lookup; never resume a historical session to display its notes.
      try {
        const response = await fetch(
          '/api/sessions/unified?q=' + encodeURIComponent(metadata.sessionTitle || metadata.sessionId)
        );
        if (response.ok) {
          const payload = await response.json();
          if (this._notesController.current !== state) return;
          const history = (payload.sessions || []).find(
            (item) =>
              item.id === metadata.sessionId ||
              item.sessionId === metadata.sessionId ||
              metadata.sessionAliases?.includes(item.id)
          );
          element.append(
            node(
              'pre',
              history
                ? JSON.stringify(history, null, 2)
                : 'Session history unavailable. Retained source summary shown above.'
            )
          );
        } else element.append(node('p', 'Session history unavailable. The retained source summary is shown above.'));
      } catch {
        element.append(node('p', 'Session history unavailable. The retained source summary is shown above.'));
      }
    },
    async _onNotesChanged(event) {
      if (!this._notesScope || event.ownerKey !== this._notesScope.ownerKey || !this._notesShell) return;
      const state = this._notesController.current;
      if (state && this._notesEditorElements) {
        try {
          if (state.saving) await state.saving;
          const revision = state.revision;
          const note = await this._notesRequest('/' + encodeURIComponent(state.id));
          if (this._notesController.current === state && state.revision === revision)
            this._notesController.external(note);
        } catch (error) {
          if (error.status === 422 && this._notesController.current === state) {
            if (state.dirty) {
              state.conflict = error.data;
              this._renderNotesState(state);
            } else this._mountNotesRepair(error.data);
          } else this._notesError(error);
        }
      }
      await this._refreshNotesList();
    },
    // Explicit sharing can read this selection in COD-482; no automatic prompt injection.
    getNotesSelection() {
      const state = this._notesController?.current;
      const editor = this._notesEditorElements?.markdown;
      if (!state || !editor) return null;
      return {
        notebookId: state.id,
        sessionId: state.note.metadata.sessionId,
        text: editor.value.slice(editor.selectionStart, editor.selectionEnd),
      };
    },
  });
})();
