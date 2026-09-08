import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { withPresentation } from '../core/presentations.js';
import {
  createToolError,
  serializeToolError,
  TOOL_ERROR_CODES,
} from '../../application/chat/tool-errors.js';
import {
  DELEGATE_TASK_TOOL_NAME,
  SUBAGENT_MODEL_ENV,
} from '../../application/services/subagent-constants.js';

export const delegateTaskSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe(
      'Self-contained research brief for the subagent. Include goal, scope, paths/patterns to inspect, and what to return. Do not rely on prior chat history.'
    ),
});

export const delegationToolDefinitions = [
  defineTool({
    name: DELEGATE_TASK_TOOL_NAME,
    description:
      'Delegate a token-heavy read-only research or codebase exploration task to a cheaper background subagent with an isolated context. ' +
      'Returns immediately so you can continue other tools while it runs; findings are injected automatically before your final answer. ' +
      'Only one subagent may run at a time. ' +
      'Use for large searches, multi-file surveys, or gathering evidence before you implement. ' +
      'Do NOT use for trivial one-file reads, writing/editing files, shell commands, or todos. ' +
      'Write a complete standalone task brief; the subagent cannot see the parent conversation. ' +
      `Requires ${SUBAGENT_MODEL_ENV} to be configured.`,
    inputSchema: delegateTaskSchema,
    execute: async (args, ctx) => {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) {
        return serializeToolError(
          createToolError(TOOL_ERROR_CODES.missingRequiredArg, 'task is required', {
            toolName: DELEGATE_TASK_TOOL_NAME,
          })
        );
      }

      if (!ctx.delegateTask) {
        return serializeToolError(
          createToolError(
            TOOL_ERROR_CODES.configurationError,
            `${DELEGATE_TASK_TOOL_NAME} is unavailable. Set ${SUBAGENT_MODEL_ENV} to a cheaper model id (CLI: /model subagent).`,
            { toolName: DELEGATE_TASK_TOOL_NAME, env: SUBAGENT_MODEL_ENV }
          )
        );
      }

      try {
        const result = await ctx.delegateTask(task);
        return {
          content: result.content,
          structured: {
            taskId: result.taskId,
            status: result.status,
            model: result.model,
          },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const blocked = /already active/i.test(message);
        return serializeToolError(
          createToolError(
            blocked ? TOOL_ERROR_CODES.policyBlocked : TOOL_ERROR_CODES.executionError,
            message,
            { toolName: DELEGATE_TASK_TOOL_NAME }
          )
        );
      }
    },
    presentation: {
      ...withPresentation(DELEGATE_TASK_TOOL_NAME),
      summarizeResult: (content) => {
        const oneLine = content.replace(/\s+/g, ' ').trim();
        return {
          preview: oneLine.length > 220 ? `${oneLine.slice(0, 220)}...` : oneLine,
          status: 'success',
        };
      },
    },
    meta: { category: 'planning' },
  }),
];
