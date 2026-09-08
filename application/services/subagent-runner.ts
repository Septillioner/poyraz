import { randomUUID } from 'crypto';
import type { AgentConfig } from '../agent/config.js';
import type { AgentMode } from '../../domain/agent-mode.js';
import type { ChatHandlers } from '../../domain/events.js';
import type { TokenUsage } from '../../domain/llm.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { resolveApiKeyForProfile } from '../../domain/model-profile.js';
import { resolveModelProfile } from './resolve-model-profile.js';
import {
  DELEGATE_TASK_TOOL_NAME,
  SUBAGENT_MAX_TOOL_ROUNDS,
  SUBAGENT_MODEL_ENV,
  SUBAGENT_READ_ONLY_TOOLS,
  readSubagentModelId,
} from './subagent-constants.js';

export {
  DELEGATE_TASK_TOOL_NAME,
  SUBAGENT_MAX_TOOL_ROUNDS,
  SUBAGENT_MODEL_ENV,
  SUBAGENT_READ_ONLY_TOOLS,
  isSubagentModelConfigured,
  readSubagentModelId,
} from './subagent-constants.js';

const SUBAGENT_IDENTITY =
  'You are a read-only research subagent. Explore the workspace with read and search tools only. ' +
  'Return a concise, self-contained summary with key findings, relevant file paths, and enough evidence for the parent agent to act. ' +
  'Do not edit files, run shell commands, create todos, or ask the user to switch modes.';

export interface SubagentChatCapable {
  setSessionId(id: string): void;
  setMode(mode: AgentMode): void;
  init(): Promise<unknown>;
  chat(
    input: string,
    handlers?: ChatHandlers
  ): Promise<{ content: string; usage: TokenUsage }>;
}

export interface SubagentRunnerOptions {
  task: string;
  createAgent: (config: AgentConfig) => SubagentChatCapable;
  signal?: AbortSignal;
  onEvent?: ChatHandlers['onEvent'];
  env?: NodeJS.ProcessEnv;
}

export interface SubagentRunResult {
  content: string;
  usage: TokenUsage;
  modelProfile: ModelProfile;
}

export function buildSubagentConfig(modelProfile: ModelProfile, apiKey: string): AgentConfig {
  return {
    name: 'Subagent',
    model: modelProfile.model,
    host: modelProfile.host,
    apiKey,
    includeTools: [...SUBAGENT_READ_ONLY_TOOLS],
    excludeTools: [DELEGATE_TASK_TOOL_NAME],
    identity: SUBAGENT_IDENTITY,
    contextLimit: 40,
    autoSummary: false,
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
 * Runs an ephemeral child agent with an isolated session/context on SUBAGENT_MODEL.
 * The factory avoids importing Agent here (circular dependency with tools).
 */
export async function runSubagentTask(options: SubagentRunnerOptions): Promise<SubagentRunResult> {
  const modelId = readSubagentModelId(options.env);
  if (!modelId) {
    throw new Error(
      `${SUBAGENT_MODEL_ENV} is not set. Configure a cheaper model id before using ${DELEGATE_TASK_TOOL_NAME}.`
    );
  }

  const modelProfile = await resolveModelProfile({ cliModel: modelId });
  const apiKey = resolveApiKeyForProfile(modelProfile);
  const config = buildSubagentConfig(modelProfile, apiKey);
  const child = options.createAgent(config);
  const sessionId = randomUUID();

  child.setSessionId(sessionId);
  child.setMode('ask');
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
