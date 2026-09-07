import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { AgentMode } from '../../domain/agent-mode.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { resolveProjectDataDir } from '../../infrastructure/persistence/paths.js';

export interface SessionPrefs {
  lastModelProfile?: ModelProfile;
  lastMode?: AgentMode;
}

export function getSessionPrefsPath(): string {
  return join(resolveProjectDataDir(), 'configs', 'session-prefs.json');
}

export function loadSessionPrefs(): SessionPrefs {
  const path = getSessionPrefsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionPrefs;
  } catch {
    return {};
  }
}

export function saveSessionPrefs(prefs: SessionPrefs): void {
  const path = getSessionPrefsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf8');
}

export function saveLastModelProfile(profile: ModelProfile): void {
  const prefs = loadSessionPrefs();
  prefs.lastModelProfile = profile;
  saveSessionPrefs(prefs);
}

export function saveLastMode(mode: AgentMode): void {
  const prefs = loadSessionPrefs();
  prefs.lastMode = mode;
  saveSessionPrefs(prefs);
}
