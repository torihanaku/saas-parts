/**
 * Adapted from 実運用SaaS `tests/server/whatif-simulator.test.ts` and
 * `tests/server/whatif-export.test.ts` — the core simulator and Redis cache
 * were mocked in the origin; here the simulator is an injected stub (the
 * kit's DI point) and caching was dropped. Golden numbers unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  simulateWhatIf,
  exportToCsv,
  toSimulatorInputs,
  type CoreSimulateResult,
} from './whatif.js';

const stubSimulator = (result: CoreSimulateResult) => vi.fn(async () => result);

describe('simulateWhatIf', () => {
  it('calls the injected simulator and calculates the pessimistic scenario', async () => {
    const simulate = stubSimulator({
      predictedOutputs: { pv: { mean: 1000 }, cv: { mean: 10 } },
      confidenceLevel: 0.8,
    });

    const result = await simulateWhatIf({
      inputs: { blogPosts: 5 },
      scenario: 'pessimistic',
      simulate,
    });

    expect(simulate).toHaveBeenCalledWith({
      scenarioName: 'WhatIf_pessimistic',
      scenarioInputs: { blog_count: 5 },
      periodHorizonDays: 30,
      confidenceLevel: 0.6,
    });
    expect(result.scenario).toBe('pessimistic');
    // pessimistic multiplier is 0.8
    expect(result.predictedOutputs.pv).toBe(800);
    expect(result.predictedOutputs.cv).toBe(8);
  });

  it('calculates the optimistic scenario with a 1.2 multiplier and 0.95 confidence', async () => {
    const simulate = stubSimulator({
      predictedOutputs: { pv: { mean: 1000 }, cv: { mean: 10 } },
      confidenceLevel: 0.95,
    });

    const result = await simulateWhatIf({
      inputs: { adBudget: 1000, emailFrequency: 2 },
      scenario: 'optimistic',
      simulate,
    });

    expect(simulate).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioName: 'WhatIf_optimistic', confidenceLevel: 0.95 }),
    );
    expect(result.scenario).toBe('optimistic');
    expect(result.predictedOutputs.pv).toBe(1200);
    expect(result.predictedOutputs.cv).toBe(12);
  });

  it('defaults to the realistic scenario and falls back to pv=1000 / cv=10 means', async () => {
    const simulate = stubSimulator({
      predictedOutputs: {},
      confidenceLevel: 0.8,
    });

    const result = await simulateWhatIf({ inputs: {}, simulate });

    expect(result.scenario).toBe('realistic');
    expect(result.predictedOutputs.pv).toBe(1000);
    expect(result.predictedOutputs.cv).toBe(10);
    expect(result.confidenceLevel).toBe(0.8);
  });
});

describe('toSimulatorInputs', () => {
  it('maps camelCase inputs to the simulator snake_case keys, omitting unset ones', () => {
    expect(toSimulatorInputs({ blogPosts: 3, adBudget: 500 })).toEqual({
      blog_count: 3,
      ad_budget: 500,
    });
    expect(toSimulatorInputs({})).toEqual({});
  });
});

describe('exportToCsv', () => {
  it('correctly formats scenario results to CSV', () => {
    const results = [
      {
        scenario: 'realistic' as const,
        inputs: { blogPosts: 5 },
        predictedOutputs: { pv: 1000, cv: 10 },
        confidenceLevel: 0.8,
      },
      {
        scenario: 'optimistic' as const,
        inputs: { adBudget: 500, emailFrequency: 2 },
        predictedOutputs: { pv: 1500, cv: 15 },
        confidenceLevel: 0.9,
      },
    ];

    const csv = exportToCsv(results);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Scenario,Blog Posts,Ad Budget,Email Freq,Predicted PV,Predicted CV');
    expect(lines[1]).toBe('realistic,5,0,0,1000,10');
    expect(lines[2]).toBe('optimistic,0,500,2,1500,15');
  });
});
