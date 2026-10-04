/** @fileoverview Strict owner-private notebook API; browser input contains only editable content and revisions. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';
import { SessionNotesInputError } from '../../session-notes-index.js';
import { sessionNotesOwnerKey } from '../../session-notes-projects.js';
import {
  SessionNotesConflictError,
  SessionNotesMalformedError,
  SessionNotesNotFoundError,
} from '../../session-notes-store.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { ownerFor } from '../route-helpers.js';
import type { SessionNotesPort } from '../ports/session-notes-port.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{64}|draft-[a-f0-9]{64})?$/);
const content = { revision, markdown: z.string().max(1024 * 1024), title: z.string().max(256).optional() };
const saveBody = z.object(content).strict();
const checkedBody = z.object({ revision, line: z.number().int().positive(), checked: z.boolean() }).strict();
const moveBody = z.object({ revision, projectId: id }).strict();
const repairBody = z.object({ revision, markdown: content.markdown }).strict();
const recoveryBody = z.object({ revision, projectId: id, choice: z.enum(['external', 'staged']) }).strict();
const errorCurrent = (current: unknown) =>
  current instanceof SessionNotesMalformedError
    ? { raw: current.raw, revision: current.revision, repairable: true, ...current.identity }
    : current;
async function handled(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SessionNotesInputError)
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, error.message));
    if (error instanceof z.ZodError)
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid notebook request'));
    if (error instanceof SessionNotesNotFoundError)
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, error.message));
    if (error instanceof SessionNotesMalformedError)
      return reply.code(422).send({
        ...createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Notebook requires repair'),
        data: errorCurrent(error),
      });
    if (error instanceof SessionNotesConflictError)
      return reply.code(409).send({
        ...createErrorResponse(ApiErrorCode.CONFLICT, error.message),
        data: { current: errorCurrent(error.current) },
      });
    throw error;
  }
}
const success = (data: unknown) => ({ success: true, data });
export function registerSessionNotesRoutes(app: FastifyInstance, ctx: SessionNotesPort): void {
  const previews = new Map<
    string,
    { owner: string; notebookId: string; destinationId: string; text: string; expires: number }
  >();
  const selectedText = z
    .string()
    .min(1)
    .max(MAX_INPUT_LENGTH - 1)
    .refine((text) => Buffer.byteLength(text, 'utf8') <= MAX_INPUT_LENGTH - 1, 'Selected text exceeds UTF-8 byte limit')
    .refine((text) => !!text.trim())
    .refine(
      (text) =>
        [...text].every((character) => {
          const code = character.charCodeAt(0);
          return (code >= 32 && code !== 127) || [9, 10, 13].includes(code);
        }),
      'Selected text contains terminal controls'
    );
  app.get('/api/session-notes/destinations', async (req, reply) =>
    handled(reply, async () => success((await ctx.listNotesDestinations?.(ownerFor(req))) ?? []))
  );
  app.post('/api/session-notes/:id/send-preview', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) =>
    handled(reply, async () => {
      const notebookId = z.object({ id }).parse(req.params).id;
      const body = z.object({ destinationId: id, text: selectedText }).strict().parse(req.body);
      const owner = ownerFor(req);
      await ctx.sessionNotes.read(sessionNotesOwnerKey(owner), notebookId);
      const destination = ((await ctx.listNotesDestinations?.(owner)) ?? []).find(
        (item) => item.id === body.destinationId
      );
      if (!destination) throw new SessionNotesNotFoundError('Active destination not found');
      for (const [token, preview] of previews) if (preview.expires <= Date.now()) previews.delete(token);
      if (previews.size >= 256)
        throw new SessionNotesInputError('Too many pending previews. Wait five minutes before reserving another.');
      const token = randomUUID();
      previews.set(token, {
        owner: sessionNotesOwnerKey(owner),
        notebookId,
        destinationId: destination.id,
        text: body.text,
        expires: Date.now() + 300000,
      });
      return success({ token, text: body.text, destination });
    })
  );
  app.post('/api/session-notes/:id/send', async (req, reply) =>
    handled(reply, async () => {
      const notebookId = z.object({ id }).parse(req.params).id;
      const body = z.object({ token: z.string().uuid() }).strict().parse(req.body);
      const owner = ownerFor(req);
      const preview = previews.get(body.token);
      if (
        !preview ||
        preview.expires <= Date.now() ||
        preview.owner !== sessionNotesOwnerKey(owner) ||
        preview.notebookId !== notebookId
      )
        throw new SessionNotesInputError(
          'Preview expired or already used. Inspect the destination before creating a new send.'
        );
      // Consume synchronously before any await: even an ambiguous delivery cannot be replayed.
      previews.delete(body.token);
      await ctx.sessionNotes.read(sessionNotesOwnerKey(owner), notebookId);
      if (!ctx.sendNotesInput) throw new SessionNotesInputError('Notes delivery unavailable');
      return success(await ctx.sendNotesInput(preview.destinationId, owner, preview.text));
    })
  );
  app.post('/api/session-notes/:id/append-response', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) =>
    handled(reply, async () => {
      const notebookId = z.object({ id }).parse(req.params).id;
      const body = z
        .object({ revision, sourceSessionId: z.string().min(1).max(256), text: selectedText })
        .strict()
        .parse(req.body);
      const owner = ownerFor(req);
      const source = await ctx.getNotesSource(body.sourceSessionId, owner);
      if (!source || (owner !== undefined && source.owner !== owner))
        throw new SessionNotesNotFoundError('Source session not found');
      return success(
        await ctx.sessionNotes.appendResponse(sessionNotesOwnerKey(owner), notebookId, body.revision, body.text, source)
      );
    })
  );
  app.get('/api/session-notes/context', async (req, reply) =>
    handled(reply, async () => success(await ctx.sessionNotes.context(sessionNotesOwnerKey(ownerFor(req)))))
  );
  app.get('/api/session-notes', async (req, reply) =>
    handled(reply, async () => {
      const query = z
        .object({
          q: z.string().max(512).optional(),
          projectId: id.optional(),
          sessionId: z.string().max(256).optional(),
          unfinished: z.enum(['true', 'false']).optional(),
        })
        .passthrough()
        .parse(req.query);
      return success(
        await ctx.sessionNotes.list(sessionNotesOwnerKey(ownerFor(req)), {
          ...query,
          unfinished: query.unfinished === 'true',
        })
      );
    })
  );
  app.get('/api/session-notes/projects', async (req, reply) =>
    handled(reply, async () => {
      const owner = ownerFor(req);
      return success(
        await ctx.sessionNotes.projects.sync(sessionNotesOwnerKey(owner), await ctx.listNotesCases(owner))
      );
    })
  );
  app.patch('/api/session-notes/projects/:id', async (req, reply) =>
    handled(reply, async () => {
      const params = z.object({ id }).parse(req.params);
      const body = z
        .object({ name: z.string().trim().min(1).max(256) })
        .strict()
        .parse(req.body);
      return success(await ctx.sessionNotes.renameProject(sessionNotesOwnerKey(ownerFor(req)), params.id, body.name));
    })
  );
  app.post('/api/session-notes/open', async (req, reply) =>
    handled(reply, async () => {
      const body = z
        .object({ sessionId: z.string().min(1).max(256) })
        .strict()
        .parse(req.body);
      const owner = ownerFor(req);
      const source = await ctx.getNotesSource(body.sessionId, owner);
      if (!source || (owner !== undefined && source.owner !== owner))
        throw new SessionNotesNotFoundError('Session not found');
      return success(await ctx.sessionNotes.open(sessionNotesOwnerKey(owner), source, await ctx.listNotesCases(owner)));
    })
  );
  app.get('/api/session-notes/recovery', async (req, reply) =>
    handled(reply, async () =>
      success(await ctx.sessionNotes.store.listRecoveryIssues(sessionNotesOwnerKey(ownerFor(req))))
    )
  );
  app.get('/api/session-notes/:id', async (req, reply) =>
    handled(reply, async () =>
      success(await ctx.sessionNotes.read(sessionNotesOwnerKey(ownerFor(req)), z.object({ id }).parse(req.params).id))
    )
  );
  app.put('/api/session-notes/:id', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) =>
    handled(reply, async () => {
      const body = saveBody.parse(req.body);
      return success(
        await ctx.sessionNotes.save(
          sessionNotesOwnerKey(ownerFor(req)),
          z.object({ id }).parse(req.params).id,
          body.revision,
          body.markdown,
          body.title
        )
      );
    })
  );
  app.get('/api/session-notes/:id/export', async (req, reply) =>
    handled(reply, async () => {
      const note = await ctx.sessionNotes.read(
        sessionNotesOwnerKey(ownerFor(req)),
        z.object({ id }).parse(req.params).id
      );
      return reply
        .type('text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${note.metadata.id}.md"`)
        .send(note.markdown);
    })
  );
  app.post('/api/session-notes/:id/reassign', async (req, reply) =>
    handled(reply, async () => {
      const body = moveBody.parse(req.body);
      return success(
        await ctx.sessionNotes.reassign(
          sessionNotesOwnerKey(ownerFor(req)),
          z.object({ id }).parse(req.params).id,
          body.revision,
          body.projectId
        )
      );
    })
  );
  app.patch('/api/session-notes/:id/checklist', async (req, reply) =>
    handled(reply, async () => {
      const body = checkedBody.parse(req.body);
      return success(
        await ctx.sessionNotes.complete(
          sessionNotesOwnerKey(ownerFor(req)),
          z.object({ id }).parse(req.params).id,
          body.revision,
          body.line,
          body.checked
        )
      );
    })
  );
  app.post('/api/session-notes/:id/repair', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) =>
    handled(reply, async () => {
      const body = repairBody.parse(req.body);
      return success(
        await ctx.sessionNotes.repair(
          sessionNotesOwnerKey(ownerFor(req)),
          z.object({ id }).parse(req.params).id,
          body.revision,
          body.markdown
        )
      );
    })
  );
  app.post('/api/session-notes/:id/resolve-recovery', async (req, reply) =>
    handled(reply, async () => {
      const body = recoveryBody.parse(req.body);
      await ctx.sessionNotes.resolveRecovery(
        sessionNotesOwnerKey(ownerFor(req)),
        body.projectId,
        z.object({ id }).parse(req.params).id,
        body.revision,
        body.choice
      );
      return success(null);
    })
  );
}
