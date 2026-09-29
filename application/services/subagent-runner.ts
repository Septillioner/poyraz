import { randomUUID } from 'crypto';
import type { AgentConfig } from '../agent/config.js';
import type { AgentPolicy } from '../../domain/agent-policy.js';
import type { ChatHandlers } from '../../domain/events.js';
import type { TokenUsage } from '../../domain/llm.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import {
  DELEGATE_TASK_TOOL_NAME,
  SUBAGENT_MAX_TOOL_ROUNDS,
  SUBAGENT_READ_ONLY_TOOLS,
} from './subagent-constants.js';

export {
  DELEGATE_TASK_TOOL_NAME,
  SUBAGENT_MAX_TOOL_ROUNDS,
  SUBAGENT_READ_ONLY_TOOLS,
} from './subagent-constants.js';

const SUBAGENT_IDENTITY =
  'You are a read-only research subagent. Explore the workspace with read and search tools only. ' +
  'Return a concise, self-contained summary with key findings, relevant file paths, and enough evidence for the parent agent to act. ' +
  'Do not edit files, run shell commands, create todos, or ask the user to switch modes.';

export const DEFAULT_SUBAGENT_POLICY: AgentPolicy = {
  id: 'subagent-readonly',
  allowedTools: [...SUBAGENT_READ_ONLY_TOOLS],
  hardBlockDeniedTools: true,
  enforceOpenTodos: false,
};

export interface SubagentChatCapable {
  setSessionId(id: string): void;
  setPolicy(policy: AgentPolicy): void;
  init(): Promise<unknown>;
  chat(
    input: string,
    handlers?: ChatHandlers
  ): Promise<{ content: string; usage: TokenUsage }>;
}

export interface SubagentRunnerOptions {
  task: string;
  modelProfile: ModelProfile;
  apiKey: string;
  createAgent: (config: AgentConfig) => SubagentChatCapable;
  signal?: AbortSignal;
  onEvent?: ChatHandlers['onEvent'];
  /** Optional child policy; defaults to read-only subagent policy. */
  policy?: AgentPolicy;
}

export interface SubagentRunResult {
  content: string;
  usage: TokenUsage;
  modelProfile: ModelProfile;
}

export function buildSubagentConfig(
  modelProfile: ModelProfile,
  apiKey: string,
  policy?: AgentPolicy
): AgentConfig {
  return {
    name: 'Subagent',
    model: modelProfile.model,
    host: modelProfile.host,
    apiKey,
    includeTools: [...SUBAGENT_READ_ONLY_TOOLS],
    excludeTools: [DELEGATE_TASK_TOOL_NAME],
    systemPrompt: SUBAGENT_IDENTITY,
    contextLimit: 40,
    autoSummary: false,
    policy: policy ?? DEFAULT_SUBAGENT_POLICY,
    routingPolicy: {
      maxToolRounds: SUBAGENT_MAX_TOOL_ROUNDS,
      repeatCallLimit: 2,
      deterministicMode: true,
    },
    options: {
      temperature: 0.2,
      max_tool_rounds: SUBAGENT_MAX_TOOL_ROUNDS,
      repeat_call_limit: 2,
    },
  };
}

/**
 * Runs an ephemeral child agent with an isolated session/context.
 * The factory avoids importing Agent here (circular dependency with tools).
 */
export async function runSubagentTask(options: SubagentRunnerOptions): Promise<SubagentRunResult> {
  const modelProfile = options.modelProfile;
  const apiKey = options.apiKey;
  const policy = options.policy ?? DEFAULT_SUBAGENT_POLICY;
  const config = buildSubagentConfig(modelProfile, apiKey, policy);
  const child = options.createAgent(config);
  const sessionId = randomUUID();

  child.setSessionId(sessionId);
  child.setPolicy(policy);
  await child.init();

  const result = await child.chat(options.task.trim(), {
    signal: options.signal,
    onEvent: options.onEvent,
  });

  return {
    content: result.content,
    usage: result.usage,
    modelProfile,
  };
}
