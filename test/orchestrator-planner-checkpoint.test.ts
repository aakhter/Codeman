/**
 * @fileoverview COD-257: OrchestratorLoop's planner must pass the global checkpoint default to its agents.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

const planOrchestratorCtor = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => JSON.stringify({ checkpointDefaultEnabled: false })),
}));

vi.mock('../src/plan-orchestrator.js', () => ({
  PlanOrchestrator: planOrchestratorCtor.mockImplementation(function () {
    return {
      generateDetailedPlan: vi.fn(async () => ({
        success: true,
        items: [{ id: 'task-1', content: 'Implement setting', priority: 'P0', dependencies: [], tddPhase: 'impl' }],
      })),
      cancel: vi.fn(async () => {}),
    };
  }),
}));

import { DEFAULT_ORCHESTRATOR_CONFIG } from '../src/types.js';
import { OrchestratorPlanner } from '../src/orchestrator-planner.js';

describe('OrchestratorPlanner checkpoint default', () => {
  it('passes an explicitly disabled settings.json default to PlanOrchestrator', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ checkpointDefaultEnabled: false }) as never);
    const planner = new OrchestratorPlanner({} as never, '/tmp', DEFAULT_ORCHESTRATOR_CONFIG);

    await planner.generatePlan('Implement checkpoint defaults');

    expect(planOrchestratorCtor).toHaveBeenCalledWith(expect.anything(), '/tmp', undefined, expect.anything(), {
      checkpointEnabled: false,
    });
  });

  it.each(['null', '[]', '"not a settings object"'])('falls back to enabled for persisted %s', async (raw) => {
    planOrchestratorCtor.mockClear();
    vi.mocked(readFile).mockResolvedValueOnce(raw as never);
    const planner = new OrchestratorPlanner({} as never, '/tmp', DEFAULT_ORCHESTRATOR_CONFIG);

    await planner.generatePlan('Implement checkpoint defaults');

    expect(planOrchestratorCtor).toHaveBeenLastCalledWith(expect.anything(), '/tmp', undefined, expect.anything(), {
      checkpointEnabled: true,
    });
  });
});
