import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface EvalFixture {
  workspace: string;
  cleanup: () => Promise<void>;
}

export async function createFixture(prefix = 'poyraz-eval-'): Promise<EvalFixture> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    workspace,
    cleanup: async () => {
      await fs.rm(workspace, { recursive: true, force: true });
    },
  };
}

export async function writeFixtureFile(
  workspace: string,
  relativePath: string,
  content: string
): Promise<string> {
  const fullPath = path.join(workspace, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

export async function readFixtureFile(workspace: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(workspace, relativePath), 'utf-8');
}
