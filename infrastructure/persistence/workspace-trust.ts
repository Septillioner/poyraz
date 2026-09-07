import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { configureFileLogging } from '../../shared/logger.js';

export interface WorkspaceSettings {
  trusted: boolean;
  trustedAt?: string;
}

let activeWorkspaceRoot: string | null = null;

export function findWorkspaceRoot(startDir?: string): string | null {
  let dir = path.resolve(startDir ?? process.cwd());
  const root = path.parse(dir).root;

  while (true) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const dataDir = path.join(dir, 'data');
    if (existsSync(dataDir) && existsSync(path.join(dataDir, 'configs'))) return dir;

    if (dir === root) break;
    dir = path.dirname(dir);
  }

  return null;
}

export function setActiveWorkspaceRoot(root: string | null): void {
  activeWorkspaceRoot = root;
}

export function getActiveWorkspaceRoot(): string | null {
  return activeWorkspaceRoot;
}

export function resolveWorkspacePoyrazDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.poyraz');
}

export function resolveWorkspaceSettingsPath(workspaceRoot: string): string {
  return path.join(resolveWorkspacePoyrazDir(workspaceRoot), 'settings.json');
}

export function resolveWorkspaceLogDir(workspaceRoot?: string | null): string | null {
  const root = workspaceRoot ?? activeWorkspaceRoot;
  if (!root) return null;
  return path.join(resolveWorkspacePoyrazDir(root), 'log');
}

export function readWorkspaceSettings(workspaceRoot: string): WorkspaceSettings | null {
  const settingsPath = resolveWorkspaceSettingsPath(workspaceRoot);
  if (!existsSync(settingsPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as WorkspaceSettings;
    if (typeof parsed.trusted !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeWorkspaceSettings(workspaceRoot: string, settings: WorkspaceSettings): void {
  const poyrazDir = resolveWorkspacePoyrazDir(workspaceRoot);
  if (!existsSync(poyrazDir)) {
    mkdirSync(poyrazDir, { recursive: true });
  }

  const payload: WorkspaceSettings = {
    trusted: settings.trusted,
    trustedAt: settings.trustedAt ?? new Date().toISOString(),
  };

  writeFileSync(resolveWorkspaceSettingsPath(workspaceRoot), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

export function isWorkspaceTrustEnvOverride(): boolean {
  const value = process.env.POYRAZ_TRUST_WORKSPACE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function isWorkspaceFileLoggingEnabled(workspaceRoot?: string | null): boolean {
  if (isWorkspaceTrustEnvOverride()) return true;

  const root = workspaceRoot ?? activeWorkspaceRoot;
  if (!root) return false;

  const settings = readWorkspaceSettings(root);
  return settings?.trusted === true;
}

export function applyWorkspaceFileLogging(workspaceRoot: string | null, trusted: boolean): void {
  setActiveWorkspaceRoot(workspaceRoot);

  if (!workspaceRoot || !trusted) {
    configureFileLogging({ enabled: false });
    return;
  }

  const logDir = resolveWorkspaceLogDir(workspaceRoot);
  if (!logDir) {
    configureFileLogging({ enabled: false });
    return;
  }

  configureFileLogging({ enabled: true, logDir });
}

export function resolveWorkspaceTrust(workspaceRoot: string | null): boolean {
  if (!workspaceRoot) return false;
  if (isWorkspaceTrustEnvOverride()) return true;

  const settings = readWorkspaceSettings(workspaceRoot);
  return settings?.trusted === true;
}
