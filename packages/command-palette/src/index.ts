export {
  useCommands,
  createDefaultCommandsApi,
  toArray,
} from "./useCommands";
export type { Command, CommandsApi, UseCommandsOptions } from "./useCommands";

export {
  classifyCommand,
  createClassifier,
  DEFAULT_CLASSIFIER_RULES,
  DEFAULT_CLASSIFIER_FALLBACK,
} from "./classifier";
export type { Classification, ClassifierRule } from "./classifier";
