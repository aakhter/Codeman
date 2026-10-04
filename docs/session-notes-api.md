# Session notes API

All routes use `/api/session-notes`; `/api/v1/session-notes` is the public versioned alias. Requests use the authenticated owner even for administrators. Browser requests cannot supply provenance, an owner, or filesystem paths. JSON success responses are `{ success: true, data }`.

| Method and suffix            | Request                                                                    | Data                                                                           |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| GET `/context`               | —                                                                          | `{ ownerKey, instanceKey }`, opaque persistent scope for browser drafts        |
| POST `/open`                 | `{ sessionId }`                                                            | Notebook or durable metadata-only draft; source ownership must be verifiable   |
| GET `/`                      | Optional `q`, `projectId`, `sessionId`, `unfinished=true` query parameters | Canonical notebook entries, newest filesystem modification first               |
| GET `/:id`                   | —                                                                          | Current notebook or retained draft; independent of source session lifetime     |
| PUT `/:id`                   | `{ revision, markdown, title? }`                                           | Saved notebook; an empty first draft stays metadata-only                       |
| GET `/:id/export`            | —                                                                          | Markdown body download, preserving whitespace and line endings                 |
| POST `/:id/reassign`         | `{ revision, projectId }`                                                  | Notebook or draft with its new project assignment                              |
| PATCH `/:id/checklist`       | `{ revision, line, checked }`                                              | Notebook with only the selected source marker changed; lines start at 1        |
| GET `/projects`              | —                                                                          | Owner-private project registry, synchronized with the owner's configured cases |
| PATCH `/projects/:id`        | `{ name }`                                                                 | Renamed project                                                                |
| GET `/recovery`              | —                                                                          | Preserved malformed or unpublished journal artifacts                           |
| POST `/:id/repair`           | `{ revision, markdown }`                                                   | Repaired malformed notebook using retained server provenance                   |
| POST `/:id/resolve-recovery` | `{ revision, projectId, choice: 'external' \| 'staged' }`                  | `null` after choosing a preserved recovery candidate                           |

A notebook contains `metadata`, `markdown`, and a full-byte SHA-256 `revision`. A metadata-only draft has revision `''`; IDs and trusted session bindings survive reload and failed first saves. List entries contain `id`, `projectId`, `note` when valid, `lastModified` in epoch milliseconds, `unfinishedCount`, `checklist: [{ line, checked, text }]`, and trusted observed `sessionAliases`. Malformed entries retain `raw`, `error`, `repairable`, and any recovery `conflict`.

Stale writes return 409 with `{ success: false, errorCode: 'CONFLICT', data: { current } }`; `current` is the current notebook, malformed `{ raw, revision, repairable: true }`, or `null`. Malformed reads return 422 with the raw bytes and their revision. Invalid input returns 400; unknown or foreign resources return 404. Unexpected disk errors remain server failures. A malformed notebook with no retained provenance cannot be automatically repaired.

`notes:changed` SSE events contain only `{ ownerKey }`. Delivery requires an exact owner match, including for administrators. Filesystem notifications trigger canonical rescans; periodic scans cover missed events. The server closes watchers on shutdown. Search/checklist projections are rebuilt from Markdown files; deleting a search cache cannot delete notebooks.

Native/resume aliases and worktree associations come from the existing trusted unified-session inputs. Multi-user historical opens fail closed when source ownership is unknown. Chosen configured cases are captured at launch, retained in session state, and take precedence over directory inference for new notebooks. Existing assignments, including manual moves, take precedence on later opens.
