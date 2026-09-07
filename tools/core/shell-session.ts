import fs from 'fs';
import path from 'path';
import { findWorkspaceRoot, getActiveWorkspaceRoot } from '../../infrastructure/persistence/workspace-trust.js';

const sessions = new Map<string, string>();
const sessionAnchors = new Map<string, string>();

const CD_TARGET = '(?:"([^"]+)"|\'([^\']+)\'|([^\\s;&|]+))';
const CD_ONLY = new RegExp(`^cd\\s+${CD_TARGET}\\s*$`, 'i');
const CD_PREFIX = new RegExp(`^cd\\s+${CD_TARGET}\\s*(?:&&|;)\\s*`, 'i');
const CD_GLOBAL = new RegExp(`\\bcd\\s+${CD_TARGET}`, 'gi');

function sessionKey(sessionId?: string): string {
  return sessionId || 'default';
}

export function getShellCwd(sessionId?: string): string {
  return sessions.get(sessionKey(sessionId)) ?? process.cwd();
}

export function setShellCwd(sessionId: string | undefined, cwd: string): void {
  sessions.set(sessionKey(sessionId), path.resolve(cwd));
}

/** Clear session cwd state between tests. */
export function resetShellSessions(): void {
  sessions.clear();
  sessionAnchors.clear();
}

function ensureSessionAnchor(sessionId: string | undefined, cwd: string): void {
  const key = sessionKey(sessionId);
  if (!sessionAnchors.has(key)) {
    sessionAnchors.set(key, path.resolve(cwd));
  }
}

function getSessionAnchor(sessionId?: string): string | null {
  return sessionAnchors.get(sessionKey(sessionId)) ?? null;
}

function extractCdTarget(match: RegExpMatchArray): string {
  return (match[1] || match[2] || match[3] || '').trim();
}

function resolveCdTarget(target: string, baseCwd: string): string {
  return path.resolve(baseCwd, target);
}

function isExistingDirectory(absPath: string): boolean {
  if (!fs.existsSync(absPath)) return false;
  return fs.statSync(absPath).isDirectory();
}

function workspaceRootForCd(): string | null {
  return getActiveWorkspaceRoot() ?? findWorkspaceRoot();
}

function targetBasename(target: string): string {
  const normalized = target.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || target;
}

/** True when cd target is a no-op (already at destination). */
function isRedundantCdTarget(target: string, sessionCwd: string): boolean {
  const resolved = path.resolve(sessionCwd);
  const candidate = path.resolve(sessionCwd, target);
  if (resolved === candidate) return true;
  return targetBasename(target) === path.basename(sessionCwd);
}

/** Resolve cd target from session cwd, session anchor, then workspace root. */
function resolveCdTargetWithFallback(
  target: string,
  sessionCwd: string,
  sessionId?: string
): string {
  if (isRedundantCdTarget(target, sessionCwd)) {
    return path.resolve(sessionCwd);
  }

  const fromSession = resolveCdTarget(target, sessionCwd);
  if (isExistingDirectory(fromSession)) return fromSession;

  const anchor = getSessionAnchor(sessionId);
  if (anchor) {
    const fromAnchor = resolveCdTarget(target, anchor);
    if (isExistingDirectory(fromAnchor)) return fromAnchor;
  }

  const workspaceRoot = workspaceRootForCd();
  if (workspaceRoot) {
    const fromWorkspace = resolveCdTarget(target, workspaceRoot);
    if (isExistingDirectory(fromWorkspace)) return fromWorkspace;
  }

  return fromSession;
}

function assertDirectoryExists(absPath: string, displayTarget: string): void {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Directory not found: ${displayTarget}`);
  }
  const stat = fs.statSync(absPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${displayTarget}`);
  }
}

export interface PreparedShellCommand {
  command: string;
  cwd: string;
  startCwd: string;
  cdOnly?: boolean;
  cdMessage?: string;
  error?: string;
}

export function extractLastCdTarget(command: string): string | null {
  const matches = [...command.matchAll(CD_GLOBAL)];
  if (matches.length === 0) return null;
  return extractCdTarget(matches[matches.length - 1]);
}

/** Walk all cd targets in order (simulates shell cd chaining within one command). */
export function resolveCdChain(command: string, startCwd: string, sessionId?: string): string {
  const matches = [...command.matchAll(CD_GLOBAL)];
  if (matches.length === 0) return startCwd;

  let current = startCwd;
  for (const match of matches) {
    const target = extractCdTarget(match);
    const resolved = resolveCdTargetWithFallback(target, current, sessionId);
    if (isExistingDirectory(resolved)) {
      current = resolved;
    }
  }

  return current;
}

/** After a successful compound command, sync session cwd from cd targets in the chain. */
export function syncSessionCwdFromCommand(
  command: string,
  sessionId: string | undefined,
  startCwd: string
): string {
  const resolved = resolveCdChain(command, startCwd, sessionId);
  if (resolved !== startCwd) {
    setShellCwd(sessionId, resolved);
  }
  return getShellCwd(sessionId);
}

export function prepareShellCommand(command: string, sessionId?: string): PreparedShellCommand {
  const trimmed = command.trim();
  const startCwd = getShellCwd(sessionId);
  ensureSessionAnchor(sessionId, startCwd);

  const onlyMatch = trimmed.match(CD_ONLY);
  if (onlyMatch) {
    const target = extractCdTarget(onlyMatch);
    try {
      if (isRedundantCdTarget(target, startCwd)) {
        return {
          command: trimmed,
          cwd: startCwd,
          startCwd,
          cdOnly: true,
          cdMessage: `Already in ${startCwd}`,
        };
      }
      const newCwd = resolveCdTargetWithFallback(target, startCwd, sessionId);
      assertDirectoryExists(newCwd, target);
      setShellCwd(sessionId, newCwd);
      return {
        command: trimmed,
        cwd: newCwd,
        startCwd,
        cdOnly: true,
        cdMessage: `Changed directory to ${newCwd}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { command: trimmed, cwd: startCwd, startCwd, error: `ERROR: ${message}` };
    }
  }

  const prefixMatch = trimmed.match(CD_PREFIX);
  if (prefixMatch) {
    const target = extractCdTarget(prefixMatch);
    try {
      const redundant = isRedundantCdTarget(target, startCwd);
      const newCwd = resolveCdTargetWithFallback(target, startCwd, sessionId);
      if (!redundant) {
        assertDirectoryExists(newCwd, target);
        setShellCwd(sessionId, newCwd);
      }
      const rest = trimmed.slice(prefixMatch[0].length).trim();
      return {
        command: rest || trimmed,
        cwd: getShellCwd(sessionId),
        startCwd,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { command: trimmed, cwd: startCwd, startCwd, error: `ERROR: ${message}` };
    }
  }

  return { command: trimmed, cwd: startCwd, startCwd };
}

export function shellResultMeta(cwd: string, command: string): Record<string, unknown> {
  return { cwd, command };
}
