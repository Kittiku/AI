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

export async function snapshot(cwd) {
  const entries = (await git(cwd, 'ls-files', '--stage', '-z')).split('\0').filter(Boolean);
  const files = [];
  const list = entries.flatMap(entry => {
    const tab = entry.indexOf('\t');
    const name = entry.slice(tab + 1);
    return /^100[67]/.test(entry) && validFile(name) ? [name] : [];
  });
  const priority = name => /(^|\/)(README\.md|package\.json|AGENTS\.md)$/i.test(name) ? 0 : 1;
  list.sort((a, b) => priority(a) - priority(b));
  let budget = 125_000;
  for (const name of list.slice(0, 400)) {
    if (!sourceFile.test(name) || /(^|\/)(package-lock\.json|pnpm-lock\.yaml)$/i.test(name)) continue;
    const file = await checkedPath(cwd, name);
    const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info?.isFile() || info.size > 24_000 || info.size > budget) continue;
    const content = await readFile(file, 'utf8');
    if (content.includes('\0')) continue;
    files.push({ path: name, content });
    budget -= info.size;
  }
  return JSON.stringify({ trackedPaths: list.slice(0, 400), files, omitted: list.length - files.length });
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
