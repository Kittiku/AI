import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { editContexts, git, snapshot } from '../server/git.js';

async function temporaryRepo(t, contents) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = await realpath(directory);
  await git(cwd, 'init', '--quiet');
  await Promise.all(Object.entries(contents).map(async ([name, content]) => {
    const file = path.join(cwd, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }));
  await git(cwd, '-c', 'core.autocrlf=false', 'add', '--force', '--', ...Object.keys(contents));
  return cwd;
}

const namesOf = repo => repo.files.map(file => file.path);
const priorPaths = Array.from({ length: 38 }, (_, index) => 'src/prior-' + String(index).padStart(2, '0') + '.js');

test('CLI snapshot includes up to 30 distinct eligible prior files after required files', async t => {
  const taskFile = 'src/current.js';
  const planFile = 'src/planned.js';
  const findingFile = 'src/review.js';
  const contents = {
    'README.md': 'project notes',
    'src/ordinary.js': 'ordinary source',
    'src/01-removed.js': 'tracked but removed from the worktree',
    'src/02-unsupported.bin': 'unsupported extension',
    'src/00-large.js': 'x'.repeat(24_001),
    'package-lock.json': '{}',
    [taskFile]: 'ก'.repeat(10_000),
    [planFile]: 'selected by plan',
    [findingFile]: 'selected by review',
    ...Object.fromEntries(priorPaths.map(name => [name, 'previous source']))
  };
  const cwd = await temporaryRepo(t, contents);
  await rm(path.join(cwd, 'src/01-removed.js'));
  const priorChanges = ['src/missing.js', 'src/01-removed.js', 'src/02-unsupported.bin', 'package-lock.json', 'src/00-large.js',
    taskFile, planFile, findingFile, './SRC\\PRIOR-00.JS', priorPaths[0], ...priorPaths];
  const required = [taskFile, planFile, findingFile];
  const { geminiCliContext } = await editContexts(cwd, { subtask: { files: [taskFile] } }, required, priorChanges);
  const { repo } = JSON.parse(geminiCliContext);

  assert.deepEqual(repo.requiredPaths, required);
  assert.equal(repo.files[0].content, contents[taskFile]);
  assert.deepEqual(namesOf(repo), [...required, ...priorPaths.slice(0, 30), 'README.md', 'src/ordinary.js']);
  assert.ok(repo.omittedPaths.includes('src/00-large.js'));
  for (const name of priorPaths.slice(30)) {
    assert.ok(repo.trackedPaths.includes(name));
    assert.ok(repo.omittedPaths.includes(name));
  }
});

test('CLI snapshot limits optional files to 24,000 UTF-8 bytes each and 125,000 bytes total', async t => {
  const full = 'ก'.repeat(8_000);
  const tail = 'ก'.repeat(1_666) + 'ab';
  const taskFile = 'src/current.js';
  const tooLarge = 'src/00-large.js';
  const contents = {
    'README.md': 'shares the optional budget',
    [taskFile]: 'ก'.repeat(12_000),
    [tooLarge]: full + 'ก',
    ...Object.fromEntries(priorPaths.map((name, index) => [name, index === 5 ? tail : full]))
  };
  const cwd = await temporaryRepo(t, contents);
  const { geminiCliContext } = await editContexts(cwd, { subtask: { files: [taskFile] } }, [taskFile], [taskFile, tooLarge, ...priorPaths]);
  const { repo } = JSON.parse(geminiCliContext);

  assert.deepEqual(repo.requiredPaths, [taskFile]);
  assert.deepEqual(namesOf(repo), [taskFile, ...priorPaths.slice(0, 6)]);
  const sizes = repo.files.slice(1).map(file => Buffer.byteLength(file.content, 'utf8'));
  assert.deepEqual(sizes, [24_000, 24_000, 24_000, 24_000, 24_000, 5_000]);
  assert.equal(sizes.reduce((total, size) => total + size, 0), 125_000);
  assert.ok(repo.omittedPaths.includes(tooLarge) && repo.omittedPaths.includes('README.md'));
});

test('normal edit context matches the pre-WIP JSON byte for byte', async t => {
  const contents = {
    'README.md': 'project notes',
    'src/edit.js': 'ต้องแก้',
    'src/from-plan.js': 'mentioned in the plan',
    'src/from-review.js': 'mentioned in review findings',
    'src/large.js': 'x'.repeat(24_001),
    'src/prior.js': 'ก'.repeat(8_001),
    'src/z.js': 'optional source'
  };
  const cwd = await temporaryRepo(t, contents);
  const fields = {
    plan: { backendFiles: ['src/from-plan.js'] },
    project: { notes: 'บันทึก', recentWork: [] },
    subtask: { number: 2, files: ['src/edit.js'] },
    finishedSubtasks: [{ number: 1, summary: 'แก้แล้ว' }],
    problems: ['Review src/from-review.js']
  };
  const required = ['src/edit.js', 'src/from-plan.js', 'src/from-review.js'];
  const priorChanges = ['src/prior.js'];
  const included = [...required, 'src/prior.js', 'README.md', 'src/z.js'];
  const legacyRepo = {
    trackedPaths: [...required, 'src/prior.js', 'README.md', 'src/large.js', 'src/z.js'],
    files: included.map(name => ({ path: name, content: contents[name] })),
    omitted: 1,
    omittedPaths: ['src/large.js']
  };
  const { context, geminiCliContext } = await editContexts(cwd, fields, required, priorChanges);
  assert.equal(context, JSON.stringify({ ...fields, repo: legacyRepo }));
  assert.equal(await snapshot(cwd, [...required, ...priorChanges]), JSON.stringify(legacyRepo));
  assert.ok(!namesOf(JSON.parse(geminiCliContext).repo).includes(priorChanges[0]));
});
