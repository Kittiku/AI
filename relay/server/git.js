import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, readFile, readlink, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
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
export const isSafePath = validFile;

const missing = error => {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
  throw error;
};

async function worktreePath(cwd, name) {
  const parts = name.split('/');
  if (parts.some(part => !part || /^(?:\.|\.\.|\.git)$/i.test(part) ||
      (process.platform === 'win32' && (/[\\:]/.test(part) || /[. ]$/.test(part))))) {
    throw Error('พาธใน worktree ใช้ไม่ได้: ' + name);
  }
  let target = cwd;
  for (const part of parts.slice(0, -1)) {
    target = path.join(target, part);
    if ((await lstat(target).catch(missing))?.isSymbolicLink()) return null;
  }
  return path.join(target, parts.at(-1));
}

async function readWorktreeFile(cwd, name) {
  const target = await worktreePath(cwd, name);
  const info = target && await lstat(target).catch(missing);
  if (!info || info.isDirectory()) return null;
  if (info.isSymbolicLink()) return { link: await readlink(target) };
  if (!info.isFile()) throw Error('สำรองไฟล์ใน worktree ไม่ได้: ' + name);
  return { content: await readFile(target), mode: info.mode & 0o777 };
}

// Save the exact on-disk bytes of already dirty files, including untracked files from checks.
// Git supplies the original index entries, independently of the files on disk.
export async function attemptState(cwd, before) {
  const tokens = (await git(cwd, 'status', '--porcelain=v2', '--branch', '--no-renames', '-uall', '-z')).split('\0');
  const files = new Map();
  let head;
  for (const token of tokens) {
    if (token.startsWith('# branch.oid ')) head = token.slice(13);
    if (token.startsWith('? ')) {
      const name = token.slice(2);
      if (!files.has(name)) files.set(name, { head: null, index: null });
    }
    if (token.startsWith('u ')) throw Error('พบไฟล์ที่ยังแก้ conflict ไม่เสร็จใน worktree');
    if (!token.startsWith('1 ')) continue;
    const fields = token.split(' ', 8);
    const [, , submodule, headMode, indexMode, , headOid, indexOid] = fields;
    if (submodule.startsWith('S')) throw Error('พบ submodule ที่เปลี่ยนใน worktree');
    const name = token.slice(fields.join(' ').length + 1);
    files.set(name, {
      head: headMode === '000000' ? null : [headMode, headOid],
      index: indexMode === '000000' ? null : [indexMode, indexOid]
    });
  }
  for (const [name, entry] of files) {
    if (!before || before.files.has(name)) entry.file = await readWorktreeFile(cwd, name);
  }
  return { head, files };
}

function sameWorktreeFile(first, second) {
  if (first === second) return true;
  if (!first || !second) return false;
  if (first.link !== undefined) return first.link === second.link;
  return first.mode === second.mode && second.content?.equals(first.content);
}

function sameIndex(first, second) {
  return first?.[0] === second?.[0] && first?.[1] === second?.[1];
}

export function attemptChanges(before, after) {
  if (before.head !== after.head) throw Error('AI สร้าง commit เองหรือย้าย HEAD ของ worktree ระหว่างการลอง Relay จะย้อน HEAD กลับและไม่ใช้ผลนี้');
  return [...new Set([...before.files.keys(), ...after.files.keys()])].filter(name => {
    const first = before.files.get(name);
    const second = after.files.get(name);
    return !first || !second || !sameIndex(first.index, second.index) || !sameWorktreeFile(first.file, second.file);
  });
}

export async function restoreAttempt(cwd, before) {
  let after = await attemptState(cwd, before);
  if (after.head !== before.head) {
    // The AI made a commit of its own. Put the branch back to where the attempt started so that commit cannot
    // stay in the job; files that were already dirty are restored from the saved copies below.
    await git(cwd, 'reset', '--hard', before.head);
    after = await attemptState(cwd, before);
  }
  const changed = attemptChanges(before, after);
  const restoreIndex = [];
  const restoreFiles = [];
  for (const name of changed) {
    const first = before.files.get(name);
    const second = after.files.get(name);
    const originalIndex = first ? first.index : second.head;
    const currentIndex = second ? second.index : first.head;
    if (!sameIndex(originalIndex, currentIndex)) {
      if (originalIndex) restoreIndex.push([name, originalIndex]);
      else await git(cwd, '--literal-pathspecs', 'update-index', '--force-remove', '--', name);
    }
    if (first && second && sameWorktreeFile(first.file, second.file)) continue;
    if (first ? first.file : second.head) {
      restoreFiles.push([name, first]);
    } else {
      const target = await worktreePath(cwd, name);
      const info = target && await lstat(target).catch(missing);
      if (info && !info.isDirectory()) await rm(target);
    }
  }
  for (const [name, [mode, oid]] of restoreIndex) {
    await git(cwd, 'update-index', '--add', '--cacheinfo', mode, oid, name);
  }
  for (const [name, entry] of restoreFiles) {
    const target = await worktreePath(cwd, name);
    if (!target) throw Error('พบ symbolic link ในพาธ: ' + name);
    const info = await lstat(target).catch(missing);
    if (info?.isDirectory()) await rmdir(target);
    if (!entry) {
      await git(cwd, '--literal-pathspecs', 'restore', '--source=HEAD', '--worktree', '--', name);
    } else {
      if (info && !info.isDirectory()) await rm(target);
      await mkdir(path.dirname(target), { recursive: true });
      if (entry.file.link !== undefined) await symlink(entry.file.link, target);
      else {
        await writeFile(target, entry.file.content);
        await chmod(target, entry.file.mode);
      }
    }
  }
  if (attemptChanges(before, await attemptState(cwd, before)).length) {
    throw Error('worktree ยังมีไฟล์จากการลองก่อนหน้า');
  }
}

export async function snapshot(cwd, include = []) {
  const entries = (await git(cwd, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean);
  const files = [];
  const list = entries.flatMap(entry => {
    const tab = entry.indexOf('\t');
    const name = entry.slice(tab + 1);
    return /^100[67]/.test(entry) && validFile(name) ? [name] : [];
  });
  const wanted = new Set(include.map(name => String(name).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()));
  const priority = name => wanted.has(name.toLowerCase()) ? 0 : /(^|\/)(README\.md|package\.json|AGENTS\.md|CLAUDE\.md)$/i.test(name) ? 1 : 2;
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

// With `paths`, only those files are committed; anything else already staged in the index (for example by a
// test command) stays out of the commit. Without `paths` the whole index is committed.
export async function checkpoint(cwd, message, paths) {
  const only = Array.isArray(paths) ? ['--only', '--', ...paths] : [];
  if (Array.isArray(paths) && !paths.length) return null;
  const staged = await git(cwd, '--literal-pathspecs', 'diff', '--cached', '--name-only', ...(only.length ? ['--', ...paths] : []));
  if (!staged) return null;
  await git(cwd, '--literal-pathspecs', '-c', 'user.name=Relay', '-c', 'user.email=relay@localhost', 'commit', '-m', message, ...only);
  return git(cwd, 'rev-parse', 'HEAD');
}
