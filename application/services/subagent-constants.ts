export const DELEGATE_TASK_TOOL_NAME = 'delegate_task';

/** Env var that enables parent-side delegation and selects the child model id. */
export const SUBAGENT_MODEL_ENV = 'SUBAGENT_MODEL';

/** Hard cap on child tool rounds to keep delegated work cheaper than the parent loop. */
export const SUBAGENT_MAX_TOOL_ROUNDS = 15;

export const SUBAGENT_READ_ONLY_TOOLS = [
  'read_file',
  'list_dir',
  'glob_file_search',
  'grep',
] as const;

export function isSubagentModelConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SUBAGENT_MODEL_ENV]?.trim());
}

export function readSubagentModelId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[SUBAGENT_MODEL_ENV]?.trim();
  return value || undefined;
}
