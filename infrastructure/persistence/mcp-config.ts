import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { resolvePoyrazHomeDir } from './poyraz-home.js';

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

export function resolveMcpConfigPath(): string {
  return path.join(resolvePoyrazHomeDir(), 'mcp.json');
}

function ensureMcpConfigDir(): void {
  const dir = resolvePoyrazHomeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadMcpConfig(): McpConfig {
  const configPath = resolveMcpConfigPath();
  if (!existsSync(configPath)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.mcpServers !== 'object') {
      return { mcpServers: {} };
    }
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch {
    return { mcpServers: {} };
  }
}

export function saveMcpConfig(config: McpConfig): void {
  ensureMcpConfigDir();
  writeFileSync(resolveMcpConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function listMcpServers(): McpServerEntry[] {
  const config = loadMcpConfig();
  return Object.entries(config.mcpServers).map(([id, def]) => ({ id, def }));
}

export function getMcpServer(id: string): McpServerDef | undefined {
  return loadMcpConfig().mcpServers[id];
}

export function addMcpServer(id: string, def: McpServerDef): void {
  const config = loadMcpConfig();
  config.mcpServers[id] = def;
  saveMcpConfig(config);
}

export function removeMcpServer(id: string): boolean {
  const config = loadMcpConfig();
  if (!(id in config.mcpServers)) return false;
  delete config.mcpServers[id];
  saveMcpConfig(config);
  return true;
}

export function setMcpServerDisabled(id: string, disabled: boolean): boolean {
  const config = loadMcpConfig();
  const def = config.mcpServers[id];
  if (!def) return false;
  def.disabled = disabled;
  saveMcpConfig(config);
  return true;
}
