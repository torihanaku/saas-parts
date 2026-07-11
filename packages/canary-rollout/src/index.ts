/**
 * Canary Rollout Logic based on Feature Flags.
 *
 * Deterministic hash-based percentage rollout: the same tenantId always
 * resolves to the same bucket (0-99), so a tenant's inclusion is stable
 * across processes and restarts without any shared state.
 */

export interface RolloutConfig {
  percentage: number; // 0, 10, 100
  canaryTenantIds?: string[];
}

/**
 * Determines if a specific tenant is part of the current canary rollout phase.
 *
 * Logic:
 * 1. If rollout is 100%, all are allowed.
 * 2. If tenant is in the explicit canary list, it's allowed.
 * 3. Otherwise, use deterministic hashing of tenantId to check against percentage.
 */
export function isTenantInRollout(tenantId: string, config: RolloutConfig): boolean {
  if (config.percentage >= 100) return true;
  if (config.canaryTenantIds?.includes(tenantId)) return true;
  if (config.percentage <= 0) return false;

  // Simple deterministic hash (0-99)
  let hash = 0;
  for (let i = 0; i < tenantId.length; i++) {
    hash = (hash << 5) - hash + tenantId.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  const normalizedHash = Math.abs(hash) % 100;

  return normalizedHash < config.percentage;
}
