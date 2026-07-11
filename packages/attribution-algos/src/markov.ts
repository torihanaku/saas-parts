/**
 * Markov-chain removal-effect attribution.
 * Ported verbatim from dev-dashboard-v2 `server/lib/marketing-roi/markov.ts`.
 */
import {
  type ConversionPath,
  isConversionTouchpoint,
  touchpointKeyForModel,
} from "./attribution";

const START = "__start__";
const CONVERSION = "__conversion__";
const NULL = "__null__";

function pathStates(path: ConversionPath, removed?: string): string[] {
  const originalStates = path.touchpoints
    .filter((touchpoint) => !isConversionTouchpoint(touchpoint))
    .map(touchpointKeyForModel);
  const hadRemoved = removed ? originalStates.includes(removed) : false;
  const states = originalStates.filter((key) => key !== removed);
  const target = path.converted && !(hadRemoved && states.length === 0) ? CONVERSION : NULL;
  return [START, ...states, target];
}

function conversionProbability(paths: ConversionPath[], removed?: string): number {
  const counts = new Map<string, Map<string, number>>();
  for (const path of paths) {
    const states = pathStates(path, removed);
    for (let i = 0; i < states.length - 1; i++) {
      const from = states[i]!;
      const to = states[i + 1]!;
      const outgoing = counts.get(from) ?? new Map<string, number>();
      outgoing.set(to, (outgoing.get(to) ?? 0) + 1);
      counts.set(from, outgoing);
    }
  }

  const memo = new Map<string, number>();
  const visit = (state: string, stack = new Set<string>()): number => {
    if (state === CONVERSION) return 1;
    if (state === NULL) return 0;
    if (memo.has(state)) return memo.get(state) ?? 0;
    if (stack.has(state)) return 0;
    const outgoing = counts.get(state);
    if (!outgoing || outgoing.size === 0) return 0;
    stack.add(state);
    const total = Array.from(outgoing.values()).reduce((sum, count) => sum + count, 0);
    let probability = 0;
    for (const [next, count] of outgoing) {
      probability += (count / total) * visit(next, stack);
    }
    stack.delete(state);
    memo.set(state, probability);
    return probability;
  };

  return visit(START);
}

export function calculateMarkovAttribution(paths: ConversionPath[]): Map<string, number> {
  const baseline = conversionProbability(paths);
  const totalConversions = paths.filter((path) => path.converted).length;
  const channelKeys = new Set<string>();
  for (const path of paths) {
    for (const touchpoint of path.touchpoints) {
      if (!isConversionTouchpoint(touchpoint)) channelKeys.add(touchpointKeyForModel(touchpoint));
    }
  }

  const effects = new Map<string, number>();
  let totalEffect = 0;
  for (const key of channelKeys) {
    const effect = Math.max(0, baseline - conversionProbability(paths, key));
    effects.set(key, effect);
    totalEffect += effect;
  }

  if (totalEffect <= 0 || totalConversions === 0) return new Map();
  const credits = new Map<string, number>();
  for (const [key, effect] of effects) {
    credits.set(key, (effect / totalEffect) * totalConversions);
  }
  return credits;
}
