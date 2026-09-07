import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { ModelProviderKind } from '../../domain/model-profile.js';

export type AuthProviderToken = 'openai' | 'groq' | 'gemini' | 'openrouter' | 'ollama';

export interface AuthProviderDef {
  token: AuthProviderToken;
  envKey: string;
  label: string;
  secret: boolean;
}

export const AUTH_PROVIDER_DEFS: AuthProviderDef[] = [
  { token: 'openai', envKey: 'OPENAI_API_KEY', label: 'OpenAI', secret: true },
  { token: 'groq', envKey: 'GROQ_API_KEY', label: 'Groq', secret: true },
  { token: 'gemini', envKey: 'GEMINI_API_KEY', label: 'Gemini', secret: true },
  { token: 'openrouter', envKey: 'OPENROUTER_API_KEY', label: 'OpenRouter', secret: true },
  { token: 'ollama', envKey: 'OLLAMA_HOST', label: 'Ollama', secret: false },
];

const AUTH_PROVIDER_TOKENS = new Set<string>(AUTH_PROVIDER_DEFS.map((d) => d.token));

export function resolvePoyrazHomeDir(): string {
  return path.join(homedir(), '.poyraz');
}

export function resolvePoyrazEnvPath(): string {
  return path.join(resolvePoyrazHomeDir(), '.env');
}

export function ensurePoyrazHome(): string {
  const homeDir = resolvePoyrazHomeDir();
  if (!existsSync(homeDir)) {
    mkdirSync(homeDir, { recursive: true });
  }
  return homeDir;
}

export function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;

  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

export function readEnvFile(filePath: string): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(filePath)) return vars;

  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) vars.set(parsed.key, parsed.value);
  }
  return vars;
}

function formatEnvLine(key: string, value: string): string {
  if (/[\s#"'\\]/.test(value)) {
    return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return `${key}=${value}`;
}

function readEnvLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8').split(/\r?\n/);
}

export function setEnvVar(filePath: string, key: string, value: string): void {
  ensurePoyrazHome();
  const lines = readEnvLines(filePath);
  const keyPrefix = `${key}=`;
  let replaced = false;

  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) return line;
    if (trimmed.startsWith(keyPrefix) || trimmed.split('=')[0]?.trim() === key) {
      replaced = true;
      return formatEnvLine(key, value);
    }
    return line;
  });

  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== '') {
      next.push('');
    }
    next.push(formatEnvLine(key, value));
  }

  writeFileSync(filePath, `${next.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
}

export function unsetEnvVar(filePath: string, key: string): boolean {
  if (!existsSync(filePath)) return false;

  const lines = readEnvLines(filePath);
  let removed = false;
  const next = lines.filter((line) => {
    const parsed = parseEnvLine(line);
    if (parsed?.key === key) {
      removed = true;
      return false;
    }
    return true;
  });

  if (!removed) return false;
  writeFileSync(filePath, `${next.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
  return true;
}

function applyEnvMapToProcess(vars: Map<string, string>, override: boolean): void {
  for (const [key, value] of vars) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadPoyrazEnvIntoProcess(): void {
  const envPath = resolvePoyrazEnvPath();
  if (!existsSync(envPath)) return;
  applyEnvMapToProcess(readEnvFile(envPath), false);
}

export function loadProjectEnvWalk(startDir?: string): void {
  let dir = startDir ?? process.cwd();
  const seen = new Set<string>();

  while (true) {
    const envPath = path.join(dir, '.env');
    if (existsSync(envPath) && !seen.has(envPath)) {
      applyEnvMapToProcess(readEnvFile(envPath), true);
      seen.add(envPath);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function loadAllEnv(startDir?: string): void {
  loadPoyrazEnvIntoProcess();
  loadProjectEnvWalk(startDir);
}

export function maskSecret(value: string | undefined, secret: boolean): string {
  if (!value?.trim()) return '(eksik)';
  const trimmed = value.trim();
  if (!secret) {
    return trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed;
  }
  if (trimmed.length < 8) return '***';
  return `sk-...${trimmed.slice(-4)}`;
}

export function resolveAuthProvider(token: string): AuthProviderDef | undefined {
  const normalized = token.trim().toLowerCase();
  if (!AUTH_PROVIDER_TOKENS.has(normalized)) return undefined;
  return AUTH_PROVIDER_DEFS.find((d) => d.token === normalized);
}

export function authProviderFromModelKind(provider: ModelProviderKind): AuthProviderDef | undefined {
  return AUTH_PROVIDER_DEFS.find((d) => d.token === provider);
}

export function readPoyrazAuthValues(): Map<string, string> {
  return readEnvFile(resolvePoyrazEnvPath());
}

export function collectProjectEnvPaths(startDir?: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let dir = startDir ?? process.cwd();

  while (true) {
    const envPath = path.join(dir, '.env');
    if (existsSync(envPath) && !seen.has(envPath)) {
      paths.push(envPath);
      seen.add(envPath);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return paths;
}

/** cwd → kök walk; üst dizinler alttakini ezer (loadProjectEnvWalk ile aynı). */
export function collectProjectEnvVars(startDir?: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const envPath of collectProjectEnvPaths(startDir)) {
    for (const [key, value] of readEnvFile(envPath)) {
      merged.set(key, value);
    }
  }
  return merged;
}

export function collectProjectAuthVars(startDir?: string): Map<string, string> {
  const project = collectProjectEnvVars(startDir);
  const auth = new Map<string, string>();
  for (const def of AUTH_PROVIDER_DEFS) {
    const value = project.get(def.envKey);
    if (value?.trim()) auth.set(def.envKey, value.trim());
  }
  return auth;
}

export interface ImportAuthEntry {
  def: AuthProviderDef;
  value: string;
  action: 'imported' | 'skipped' | 'unchanged';
}

export interface ImportAuthResult {
  sourcePaths: string[];
  entries: ImportAuthEntry[];
}

export function importProjectAuthToPoyraz(options?: {
  startDir?: string;
  overwrite?: boolean;
}): ImportAuthResult {
  const sourcePaths = collectProjectEnvPaths(options?.startDir);
  const projectAuth = collectProjectAuthVars(options?.startDir);
  const existing = readPoyrazAuthValues();
  const entries: ImportAuthEntry[] = [];

  for (const def of AUTH_PROVIDER_DEFS) {
    const value = projectAuth.get(def.envKey);
    if (!value) continue;

    const hasGlobal = Boolean(existing.get(def.envKey)?.trim());
    if (hasGlobal && !options?.overwrite) {
      entries.push({ def, value, action: 'skipped' });
      continue;
    }

    if (hasGlobal && existing.get(def.envKey)?.trim() === value) {
      entries.push({ def, value, action: 'unchanged' });
      continue;
    }

    setEnvVar(resolvePoyrazEnvPath(), def.envKey, value);
    entries.push({ def, value, action: 'imported' });
  }

  return { sourcePaths, entries };
}
