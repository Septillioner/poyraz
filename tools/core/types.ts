import { z } from 'zod';
import type { Agent } from '../../application/agent/agent.js';
import { logger } from '../../shared/logger.js';
import type { AgentError } from '../../domain/llm.js';

export interface LastReadFileState {
  path: string;
  lineCount: number;
}

export interface ToolContext {
  agent?: Agent;
  logger?: typeof logger;
  sessionId?: string;
  abortSignal?: AbortSignal;
  refreshSystemPrompt?: () => void;
  lastReadFile?: LastReadFileState;
}

export type ToolCategory =
  | 'file'
  | 'shell'
  | 'memory'
  | 'planning'
  | 'network';

export interface ToolMeta {
  category?: ToolCategory;
  destructive?: boolean;
  requiresApproval?: boolean;
}

export interface ToolResultSummary {
  preview: string;
  status: 'success' | 'error' | 'blocked';
}

export interface ToolPresentation {
  label: string;
  runningLabel?: string;
  icon?: string;
  category?: ToolCategory;
  summarizeArgs?: (args: Record<string, unknown>) => string | undefined;
  summarizeResult?: (content: string) => ToolResultSummary;
  sensitiveArgKeys?: string[];
}

export interface ToolResult {
  content: string;
  structured?: unknown;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  /** @deprecated use inputSchema */
  schema?: z.ZodObject<any>;
  /**
   * Raw JSON Schema for the tool's parameters, as reported by the source (e.g. an MCP server).
   * When present, `toOpenAISchemas()` sends this to the LLM instead of deriving one from `inputSchema`,
   * since `inputSchema` for external tools is only a loose approximation used for local validation.
   */
  parametersJsonSchema?: Record<string, unknown>;
  execute: (args: any, context: ToolContext) => Promise<ToolResult | string | unknown | AgentError>;
  presentation?: ToolPresentation;
  meta?: ToolMeta;
}

/** @deprecated use ToolDefinition */
export type Tool = ToolDefinition;

export function getToolSchema(tool: ToolDefinition): z.ZodObject<any> {
  return tool.inputSchema ?? tool.schema!;
}

export function normalizeToolResult(result: ToolResult | string | unknown | AgentError): ToolResult {
  if (result && typeof result === 'object' && 'content' in result && typeof (result as ToolResult).content === 'string') {
    return result as ToolResult;
  }
  if (result && typeof result === 'object' && 'code' in result && 'message' in result) {
    return { content: JSON.stringify({ error: result }), isError: true };
  }
  return { content: typeof result === 'string' ? result : JSON.stringify(result) };
}
