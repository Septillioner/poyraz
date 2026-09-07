import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensurePoyrazHome } from './poyraz-home.js';
import {
  findProjectDataDirWalk,
  resolvePoyrazGlobalDataDir,
} from './paths.js';

export interface TemplateSyncResult {
  source: string | null;
  target: string;
  copied: string[];
}

export function resolveBundledTemplatesDir(): string | null {
  // Works from source (…/infrastructure/persistence) and from dist (…/dist).
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'defaults', 'templates');
    if (existsSync(candidate)) return path.resolve(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Legacy monorepo fallback (project data/configs/templates).
  const legacy = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'configs', 'templates');
  if (existsSync(legacy)) return path.resolve(legacy);

  return null;
}

export function resolveGlobalTemplatesDir(): string {
  return path.join(resolvePoyrazGlobalDataDir(), 'configs', 'templates');
}

export function syncBundledTemplatesToGlobal(): TemplateSyncResult {
  const source = resolveBundledTemplatesDir();
  const target = resolveGlobalTemplatesDir();
  const copied: string[] = [];

  ensurePoyrazHome();
  mkdirSync(target, { recursive: true });

  if (!source) {
    return { source: null, target, copied };
  }

  for (const file of readdirSync(source)) {
    if (!file.endsWith('.json')) continue;
    copyFileSync(path.join(source, file), path.join(target, file));
    copied.push(file);
  }

  return { source, target, copied };
}

export function ensureTemplatesSynced(): TemplateSyncResult | null {
  if (findProjectDataDirWalk()) return null;
  return syncBundledTemplatesToGlobal();
}
