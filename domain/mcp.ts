export interface McpStdioServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface McpHttpServerDef {
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export type McpServerDef = McpStdioServerDef | McpHttpServerDef;

export function isMcpHttpServerDef(def: McpServerDef): def is McpHttpServerDef {
  return typeof (def as McpHttpServerDef).url === 'string';
}

export interface McpConfig {
  mcpServers: Record<string, McpServerDef>;
}

export interface McpServerEntry {
  id: string;
  def: McpServerDef;
}
