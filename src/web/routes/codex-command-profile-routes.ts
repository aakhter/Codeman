import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getDataDir } from '../../config/instance.js';
import { getCodexProfileUsage, migrateLegacyRemoteCaseCodexCommands } from '../../codex-command-profiles.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { CodexCommandProfile } from '../../types.js';
import { ownerFor, parseBody } from '../route-helpers.js';
import {
  CodexCommandProfileCreateSchema,
  CodexCommandProfileParamsSchema,
  CodexCommandProfileUpdateSchema,
} from '../schemas.js';
import type { ConfigPort } from '../ports/config-port.js';
import { isMultiUserMode } from '../../config/multiuser.js';

const SINGLE_USER_OWNER = '@single';

function ownerKey(owner: string | undefined): string {
  return owner ?? SINGLE_USER_OWNER;
}

function namesMatch(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

async function ownerState(ctx: ConfigPort, owner: string | undefined) {
  const key = ownerKey(owner);
  const migrated = await migrateLegacyRemoteCaseCodexCommands(getDataDir(), key, ctx.store, {
    allowOwnerlessSingleUser: !isMultiUserMode(),
  });
  const localSelections = ctx.store.getCaseCodexCommandSelections(key);
  const localCaseNames = Object.entries(localSelections)
    .filter(([, selection]) => selection.kind === 'profile')
    .map(([caseName, selection]) => ({
      caseName,
      profileId: selection.kind === 'profile' ? selection.profileId : '',
    }));
  return {
    owner: key,
    profiles: migrated.profiles,
    cases: migrated.cases.filter((remoteCase) => remoteCase.owner === owner),
    localSelections: localCaseNames,
  };
}

export function registerCodexCommandProfileRoutes(app: FastifyInstance, ctx: ConfigPort): void {
  const profileUsage = (state: Awaited<ReturnType<typeof ownerState>>, profileId: string): string[] => {
    const remoteUsage = getCodexProfileUsage(state.cases, profileId);
    const localUsage = state.localSelections
      .filter((entry) => entry.profileId === profileId)
      .map((entry) => entry.caseName);
    return [...new Set([...remoteUsage, ...localUsage])].sort((left, right) => left.localeCompare(right));
  };

  app.get('/api/codex-command-profiles', async (req) => {
    const state = await ownerState(ctx, ownerFor(req));
    const profiles = state.profiles
      .map((profile) => ({ ...profile, usage: profileUsage(state, profile.id) }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'accent' }));
    return { success: true, data: { profiles } };
  });

  app.post('/api/codex-command-profiles', async (req, reply) => {
    const input = parseBody(CodexCommandProfileCreateSchema, req.body);
    const state = await ownerState(ctx, ownerFor(req));
    if (state.profiles.some((profile) => namesMatch(profile.name, input.name))) {
      return reply
        .code(409)
        .send(createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A profile with this name already exists'));
    }
    const profile: CodexCommandProfile = { id: randomUUID(), name: input.name, command: input.command };
    ctx.store.setCodexCommandProfiles(state.owner, [...state.profiles, profile]);
    return { success: true, data: profile };
  });

  app.put('/api/codex-command-profiles/:id', async (req, reply) => {
    const { id } = parseBody(CodexCommandProfileParamsSchema, req.params);
    const input = parseBody(CodexCommandProfileUpdateSchema, req.body);
    const state = await ownerState(ctx, ownerFor(req));
    const index = state.profiles.findIndex((profile) => profile.id === id);
    if (index < 0)
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Codex command profile not found'));

    const current = state.profiles[index];
    const requestedName = input.name;
    if (
      requestedName !== undefined &&
      state.profiles.some((profile) => profile.id !== id && namesMatch(profile.name, requestedName))
    ) {
      return reply
        .code(409)
        .send(createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A profile with this name already exists'));
    }
    if (
      (input.name === undefined || input.name === current.name) &&
      (input.command === undefined || input.command === current.command)
    ) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Profile update has no effect'));
    }
    const usage = profileUsage(state, id);
    if (
      input.command !== undefined &&
      input.command !== current.command &&
      usage.length > 0 &&
      !input.confirmReferencedUpdate
    ) {
      return reply.code(400).send({
        ...createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Updating this command requires confirmation'),
        requiresConfirmation: true,
        usage,
      });
    }

    const updated = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
    };
    const profiles = [...state.profiles];
    profiles[index] = updated;
    ctx.store.setCodexCommandProfiles(state.owner, profiles);
    return { success: true, data: updated };
  });

  app.delete('/api/codex-command-profiles/:id', async (req, reply) => {
    const { id } = parseBody(CodexCommandProfileParamsSchema, req.params);
    const state = await ownerState(ctx, ownerFor(req));
    if (!state.profiles.some((profile) => profile.id === id)) {
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Codex command profile not found'));
    }
    const usage = profileUsage(state, id);
    if (usage.length > 0) {
      return reply
        .code(409)
        .send({ ...createErrorResponse(ApiErrorCode.CONFLICT, 'Profile is still used by cases'), usage });
    }
    ctx.store.setCodexCommandProfiles(
      state.owner,
      state.profiles.filter((profile) => profile.id !== id)
    );
    return { success: true, data: { id } };
  });
}
