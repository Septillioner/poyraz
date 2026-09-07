import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMarkerMerge,
  JSX_BLOCK_MARKER,
  JS_LINE_MARKER,
  validateEditRequest,
} from '../../tools/core/edit-merge.js';
import { editFile } from '../../tools/definitions/fs.js';

describe('validateEditRequest', () => {
  const existing = 'line1\nline2\nline3\nline4';

  it('allows new file partial content', () => {
    expect(validateEditRequest('new.ts', 'only new', false, '')).toBeNull();
  });

  it('rejects partial content without markers on existing file', () => {
    const err = validateEditRequest('a.ts', 'partial only', true, existing);
    expect(err).toContain('markers or the full file');
  });

  it('rejects single marker on existing file', () => {
    const edit = `line1\n// ... existing code ...\nchanged`;
    const err = validateEditRequest('a.ts', edit, true, existing);
    expect(err).toContain('BOTH before and after markers');
  });

  it('rejects // marker in JSX file', () => {
    const edit = [
      'export function App() {',
      JS_LINE_MARKER,
      '  return <div />;',
      JS_LINE_MARKER,
      '}',
    ].join('\n');
    const err = validateEditRequest('App.tsx', edit, true, existing);
    expect(err).toContain('JSX/TSX');
  });

  it('allows JSX block marker in tsx file', () => {
    const edit = [
      'export function App() {',
      JSX_BLOCK_MARKER,
      '  return <div><span /></div>;',
      JSX_BLOCK_MARKER,
      '}',
    ].join('\n');
    expect(validateEditRequest('App.tsx', edit, true, existing)).toBeNull();
  });

  it('allows full rewrite when edit lines >= existing lines', () => {
    const full = 'a\nb\nc\nd\ne';
    expect(validateEditRequest('a.ts', full, true, existing)).toBeNull();
  });
});

describe('applyMarkerMerge', () => {
  const existing = 'function greet() {\n  return "hi";\n}\n\nexport default greet;';

  it('merges when anchors match existing lines', () => {
    const simpleExisting = 'line1\nline2\nline3';
    const codeEdit = [
      'line1',
      '// ... existing code ...',
      'line2',
      '// ... existing code ...',
      'line3',
    ].join('\n');

    const result = applyMarkerMerge(simpleExisting, codeEdit);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('line1');
      expect(result.content).toContain('line2');
      expect(result.content).toContain('line3');
    }
  });

  it('fails merge when after-anchor is not in the file', () => {
    const result = applyMarkerMerge('line1\nline2\nline3', [
      'line1',
      '// ... existing code ...',
      'brand-new-line',
      '// ... existing code ...',
      'line3',
    ].join('\n'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('anchor');
    }
  });

  it('overwrites when no marker present', () => {
    const full = 'export const x = 1;';
    const result = applyMarkerMerge(existing, full);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe(full);
    }
  });

  it('parses JSX block markers', () => {
    const jsxExisting = 'export function App() {\n  return <div>old</div>;\n}';
    const codeEdit = [
      'export function App() {',
      '{/* ... existing code ... */}',
      '  return <div>new</div>;',
      '}',
    ].join('\n');

    const result = applyMarkerMerge(jsxExisting, codeEdit);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('<div>new</div>');
    }
  });
});

describe('editFile integration', () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poyraz-edit-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes full content to a new file', async () => {
    const result = await editFile({
      target_file: 'new.txt',
      code_edit: 'hello world',
    });
    expect(typeof result).toBe('object');
    if (typeof result === 'object') {
      expect(result.isError).toBeFalsy();
    }
    const written = await fs.readFile(path.join(tmpDir, 'new.txt'), 'utf-8');
    expect(written).toBe('hello world');
  });

  it('returns validation error for partial edit without markers', async () => {
    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'line1\nline2\nline3', 'utf-8');
    const result = await editFile({
      target_file: 'existing.txt',
      code_edit: 'only one line',
    });
    expect(typeof result).toBe('object');
    if (typeof result === 'object') {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('markers or the full file');
    }
  });
});
