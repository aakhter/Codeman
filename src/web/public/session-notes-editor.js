/** Private notebook controller. Requests carry editable content only; each save owns its notebook state. */
(function () {
  class SessionNotesEditor {
    constructor({ scope, storage, request, changed = () => {} }) {
      this.scope = scope;
      this.storage = storage;
      this.request = request;
      this.changed = changed;
      this.states = new Map();
    }
    key(id) {
      return 'codeman:notes:' + JSON.stringify([this.scope.instanceKey, this.scope.ownerKey, id]);
    }
    persist(state, bookkeeping = false) {
      try {
        if (bookkeeping && this.storage.getItem(this.key(state.id)) !== state.draftSnapshot) return;
        const snapshot = JSON.stringify({ revision: state.revision, markdown: state.markdown, title: state.title });
        this.storage.setItem(this.key(state.id), snapshot);
        state.draftSnapshot = snapshot;
      } catch {
        state.storageError = 'Browser draft storage unavailable. Keep this page open until saved.';
      }
    }
    clearDraft(state) {
      try {
        if (state.draftSnapshot && this.storage.getItem(this.key(state.id)) === state.draftSnapshot) {
          this.storage.removeItem(this.key(state.id));
          state.draftSnapshot = null;
        }
      } catch {
        /* Canonical content remains available when browser storage is unavailable. */
      }
    }
    notify(state) {
      if (this.current === state) this.changed(state);
    }
    load(note) {
      const id = note.metadata.id;
      let state = this.states.get(id);
      if (!state) {
        state = {
          id,
          note,
          revision: note.revision,
          markdown: note.markdown,
          title: note.metadata.title,
          status: 'Saved',
          dirty: false,
          version: 0,
        };
        try {
          state.draftSnapshot = this.storage.getItem(this.key(id));
          const draft = JSON.parse(state.draftSnapshot || 'null');
          if (draft && typeof draft.markdown === 'string' && typeof draft.title === 'string') {
            state.markdown = draft.markdown;
            state.title = draft.title;
            state.dirty = true;
            state.status = 'Unsaved';
            if (draft.revision !== note.revision) state.conflict = note;
            state.revision = draft.revision;
          }
        } catch {
          /* An unavailable local draft must not block reading the canonical notebook. */
        }
        this.states.set(id, state);
      }
      this.current = state;
      this.external(note);
      this.notify(state);
      return state;
    }
    edit(markdown, title) {
      const state = this.current;
      if (!state) return;
      state.markdown = markdown;
      state.title = title;
      state.dirty = true;
      state.version++;
      state.status = 'Unsaved';
      this.persist(state);
      clearTimeout(state.timer);
      state.timer = setTimeout(() => this.flush(state), 750);
      this.notify(state);
    }
    async flush(state = this.current) {
      if (!state) return;
      clearTimeout(state.timer);
      if (state.saving) {
        await state.saving;
        if (state.dirty && !state.conflict && state.status !== 'Save failed') return this.flush(state);
        return;
      }
      if (!state.dirty || state.conflict) return;
      const version = state.version;
      const body = { revision: state.revision, markdown: state.markdown, title: state.title };
      state.status = 'Saving';
      this.notify(state);
      state.saving = (async () => {
        try {
          const saved = await this.request('/' + encodeURIComponent(state.id), body, 'PUT');
          state.note = saved;
          state.revision = saved.revision;
          if (version === state.version) {
            state.dirty = false;
            state.status = 'Saved';
            this.clearDraft(state);
          } else {
            state.status = 'Unsaved';
            this.persist(state, true);
          }
          state.error = '';
        } catch (error) {
          state.status = 'Save failed';
          state.error = error.message || 'Could not save notes';
          if (error.status === 409) state.conflict = error.current || { unavailable: true };
          // The draft was persisted by the explicit edit; a failed completion must not replace another tab's draft.
        } finally {
          state.saving = null;
          this.notify(state);
        }
      })();
      await state.saving;
    }
    external(note) {
      const state = this.current;
      if (!state || state.id !== note.metadata.id || state.revision === note.revision || state.saving) return;
      if (state.dirty) {
        state.conflict = note;
        clearTimeout(state.timer);
      } else {
        state.note = note;
        state.revision = note.revision;
        state.markdown = note.markdown;
        state.title = note.metadata.title;
      }
      this.notify(state);
    }
    resolve(choice) {
      const state = this.current;
      const current = state?.conflict;
      if (!current?.metadata) return;
      const draft = state.markdown;
      state.note = current;
      state.revision = current.revision;
      state.conflict = null;
      state.error = '';
      if (choice === 'reload') {
        state.markdown = current.markdown;
        state.title = current.metadata.title;
        state.dirty = false;
        state.status = 'Saved';
        this.clearDraft(state);
        this.notify(state);
      } else {
        this.edit(choice === 'combine' ? current.markdown + '\n\n' + draft : draft, state.title);
      }
    }
  }
  window.SessionNotesEditor = SessionNotesEditor;
})();
