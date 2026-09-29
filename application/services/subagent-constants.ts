export const DELEGATE_TASK_TOOL_NAME = 'delegate_task';

/** Hard cap on child tool rounds to keep delegated work cheaper than the parent loop. */
export const SUBAGENT_MAX_TOOL_ROUNDS = 15;

export const SUBAGENT_READ_ONLY_TOOLS = [
  'read_file',
  'list_dir',
  'glob_file_search',
  'grep',
] as const;
