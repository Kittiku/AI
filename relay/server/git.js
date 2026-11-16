import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
export const git = async (cwd, ...args) => (await execute('git', [
  '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
  '-c', 'commit.gpgSign=false', ...args
], { cwd, timeout: 45_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout.trimEnd();

export async function repository(folder) {
  if (!path.isAbsolute(folder) || folder.startsWith('\\\\')) throw Error('ระบุพาธเต็มของ Git repo บนเครื่อง');
  const cwd = await realpath(folder);
  return {
    root: await realpath(await git(cwd, 'rev-parse', '--show-toplevel')),
    base: await git(cwd, 'rev-parse', '--verify', 'HEAD')
  };
}

const privateFile = /(^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.npmrc$|\.netrc$|\.ssh\/|node_modules\/|vendor\/|credentials[^/]*$|secrets?(?:[./_-]|$))|\.(?:pem|key|p12|pfx|lock)$/i;
const sourceFile = /\.(?:html|css|scss|less|js|cjs|mjs|jsx|ts|tsx|json|md|txt|sql|prisma|vue|svelte|py|go|rs|java|cs|rb|php|yaml|yml|toml|sh|ps1|xml)$/i;
function validFile(name) {
  return typeof name === 'string' && name.length < 220 && !privateFile.test(name) &&
    !/[\\:*?"<>|\x00-\x1f]/.test(name) &&
    name.split('/').every(part => part && !/^\.{1,2}$/.test(part) && !/[. ]$/.test(part) &&
      !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}

// Files named in `include` (the ones a role must edit) are sent in full up to a larger limit;
// the rest of the repo fills a smaller budget. `omittedPaths` lists source files left out.
export async function snapshot(cwd, include = []) {
  const entries = (await git(cwd, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean);
  const files = [];
  const list = entries.flatMap(entry => {
    const tab = entry.indexOf('\t');
    const name = entry.slice(tab + 1);
    return /^100[67]/.test(entry) && validFile(name) ? [name] : [];
  });
  const wanted = new Set(include.map(name => String(name).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()));
  const priority = name => wanted.has(name.toLowerCase()) ? 0 : /(^|\/)(README\.md|package\.json|AGENTS\.md)$/i.test(name) ? 1 : 2;
  list.sort((a, b) => priority(a) - priority(b));
  let includeBudget = 1_200_000;
  let budget = 125_000;
  const omittedPaths = [];
  for (const name of list.slice(0, 400)) {
    if (!sourceFile.test(name) || /(^|\/)(package-lock\.json|pnpm-lock\.yaml)$/i.test(name)) continue;
    const file = await checkedPath(cwd, name);
    const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info?.isFile()) continue;
    const named = priority(name) === 0;
    const fits = named ? info.size <= 400_000 && info.size <= includeBudget : info.size <= 24_000 && info.size <= budget;
    if (!fits) { omittedPaths.push(name); continue; }
    const content = await readFile(file, 'utf8');
    if (content.includes('\0')) continue;
    files.push({ path: name, content });
    if (named) includeBudget -= info.size; else budget -= info.size;
  }
  return JSON.stringify({ trackedPaths: list.slice(0, 400), files, omitted: list.length - files.length, omittedPaths: omittedPaths.slice(0, 100) });
}

// Find/replace edits let an AI change part of a large file without resending all of it.
// Each `find` must appear exactly once; with dryRun the files are only checked.
export async function applyEdits(cwd, edits, { dryRun = false } = {}) {
  if (!Array.isArray(edits) || edits.length > 60) throw Error('รายการแก้ไขไม่ถูกต้อง');
  const pending = new Map();
  for (const edit of edits) {
    if (typeof edit?.find !== 'string' || !edit.find || typeof edit.replace !== 'string') throw Error('รายการแก้ไขต้องมีข้อความที่จะหาและข้อความแทน');
    const target = await checkedPath(cwd, edit.path);
    const key = target.toLowerCase();
    if (!pending.has(key)) {
      const content = await readFile(target, 'utf8').catch(() => { throw Error('ไม่พบไฟล์ที่จะแก้: ' + edit.path); });
      pending.set(key, { target, path: edit.path, content });
    }
    const entry = pending.get(key);
    const crlf = entry.content.includes('\r\n');
    const find = crlf && !edit.find.includes('\r') ? edit.find.replace(/\n/g, '\r\n') : edit.find;
    const replace = crlf && !edit.replace.includes('\r') ? edit.replace.replace(/\n/g, '\r\n') : edit.replace;
    const first = entry.content.indexOf(find);
    if (first < 0) throw Error('หาข้อความที่จะแก้ไม่เจอใน ' + edit.path + ': ' + edit.find.slice(0, 80));
    if (entry.content.indexOf(find, first + 1) >= 0) throw Error('ข้อความที่จะแก้ซ้ำหลายจุดใน ' + edit.path + ': ' + edit.find.slice(0, 80));
    entry.content = entry.content.slice(0, first) + replace + entry.content.slice(first + find.length);
  }
  if (dryRun) return;
  for (const { target, content } of pending.values()) await writeFile(target, content, 'utf8');
  if (pending.size) await git(cwd, '--literal-pathspecs', 'add', '--', ...[...pending.values()].map(entry => entry.path));
}

async function checkedPath(root, name) {
  if (!validFile(name)) throw Error('พาธไฟล์ใช้ไม่ได้: ' + String(name));
  let target = root;
  for (const part of name.split('/')) {
    target = path.join(target, part);
    const info = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw Error('พบ symbolic link ในพาธ: ' + name);
    if (info && (await realpath(target)).toLowerCase() !== target.toLowerCase()) throw Error('พาธไฟล์ไม่ตรงกับ worktree: ' + name);
  }
  return target;
}

export async function applyFiles(cwd, changes) {
  if (!Array.isArray(changes) || changes.length > 30) throw Error('ผลลัพธ์การแก้ไฟล์ไม่ถูกต้อง');
  const seen = new Set();
  const paths = [];
  for (const change of changes) {
    if (typeof change?.content !== 'string' || Buffer.byteLength(change.content) > 100_000) throw Error('เนื้อหาไฟล์ไม่ถูกต้อง');
    const target = await checkedPath(cwd, change.path);
    const key = target.toLowerCase();
    if (seen.has(key)) throw Error('พบชื่อไฟล์ซ้ำ: ' + change.path);
    if (await git(cwd, 'check-ignore', '--no-index', '--', change.path).catch(error => {
      if (error.code === 1) return '';
      throw error;
    })) throw Error('ไฟล์อยู่ใน .gitignore: ' + change.path);
    seen.add(key);
    paths.push([target, change]);
  }
  for (const [target, change] of paths) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, change.content, 'utf8');
  }
  if (paths.length) await git(cwd, '--literal-pathspecs', 'add', '--', ...changes.map(change => change.path));
}

export async function checkpoint(cwd, message) {
  if (!(await git(cwd, 'diff', '--cached', '--name-only'))) return null;
  await git(cwd, '-c', 'user.name=Relay', '-c', 'user.email=relay@localhost', 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
