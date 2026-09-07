import { existsSync } from 'fs';
import path from 'path';
import { resolvePoyrazHomeDir } from './poyraz-home.js';

/** Yalnızca configs içeren data/ proje sayılır; cwd altındaki storage-only klasörler global modu bozmaz. */
const isProjectDataDir = (dir: string) => existsSync(path.join(dir, 'configs'));

export function findProjectDataDirWalk(startDir?: string): string | null {
  let dir = startDir ?? process.cwd();
  const root = path.parse(dir).root;

  while (true) {
    const candidate = path.join(dir, 'data');
    if (existsSync(candidate) && isProjectDataDir(candidate)) {
      return path.resolve(candidate);
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }

  return null;
}

export function resolvePoyrazGlobalDataDir(): string {
  return path.join(resolvePoyrazHomeDir(), 'data');
}

export function resolveProjectDataDir(): string {
  const project = findProjectDataDirWalk();
  if (project) return project;
  return path.resolve(resolvePoyrazGlobalDataDir());
}
