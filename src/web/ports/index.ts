/**
 * @fileoverview Barrel export for all port interfaces.
 *
 * Ports define the capabilities that route modules can depend on.
 * WebServer implements all ports; route modules declare only what they need
 * via TypeScript intersection types (e.g., SessionPort & EventPort).
 */

export type { SessionCreationOptions, SessionPort, SessionWireState } from './session-port.js';
export type { EventPort } from './event-port.js';
export type { RespawnPort } from './respawn-port.js';
export type { ConfigPort } from './config-port.js';
export type { InfraPort, ScheduledRun } from './infra-port.js';
export type { AuthPort } from './auth-port.js';
export type { OrchestratorPort } from './orchestrator-port.js';
export type { CronPort } from './cron-port.js';
export type { TabLayoutPort } from './tab-layout-port.js';
export type { AgentActivityControllerPort, AgentActivityPort } from './agent-activity-port.js';

export type { SessionNotesPort } from './session-notes-port.js';
