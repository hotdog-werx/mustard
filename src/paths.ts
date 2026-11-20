import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { safePath } from './coverage.ts';
import type { Fix } from './config.ts';

function posix(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function strip(path: string, prefix: string): string {
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
}

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

export function normalizePath(raw: string, workspace: string, root: string, fixes: Fix[]): string {
  let path = posix(raw);
  for (const [from, to] of fixes) {
    const prefix = posix(from);
    if (path.startsWith(prefix)) path = posix(to) + path.slice(prefix.length);
  }
  const rootPath = posix(root).replace(/\/$/, '');
  path = strip(strip(path, rootPath), posix(workspace));
  path = strip(path, strip(rootPath, posix(workspace)));
  return posix(path);
}

export function existsIn(workspace: string, path: string): boolean {
  if (!safePath(path)) return false;
  const absolute = resolve(workspace, path);
  return existsSync(absolute) && within(workspace, realpathSync(absolute)) && statSync(absolute).isFile();
}
