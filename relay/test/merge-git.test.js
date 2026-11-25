import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git, previewMerge, rebaseForMerge, worktreePaths } from '../server/git.js';

const shared = 'ชื่อ งาน.txt';

async function repoWithJob(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-merge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await realpath(directory);
  const job = path.join(repo, 'job');
  const scratch = path.join(repo, 'scratch');
  await git(repo, 'init', '--quiet', '-b', 'main');
  await git(repo, 'config', 'core.autocrlf', 'false');
  const commit = async (cwd, file, text) => {
    await writeFile(path.join(cwd, file), text);
    await git(cwd, 'add', '--', file);
    await git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'Edit ' + file);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  await commit(repo, shared, 'base\n');
  await git(repo, 'worktree', 'add', '-b', 'relay/job', job);
  return { repo, job, scratch, commit };
}

test('isolated rebase puts the job on current main and keeps the original branch and local changes', async t => {
  const { repo, job, scratch, commit } = await repoWithJob(t);
  const tip = await commit(job, 'job.txt', 'job\n');
  const head = await commit(repo, shared, 'main\n');
  await writeFile(path.join(job, shared), 'local job edits\n');

  const preview = await previewMerge(repo, head, tip);
  assert.equal(preview.conflicts, null);
  const rebased = await rebaseForMerge(repo, scratch, head, tip, preview.tree);
  assert.notEqual(rebased.tip, tip);
  assert.equal(await git(repo, 'rev-parse', rebased.tip + '^'), head);
  assert.equal(await git(repo, 'rev-parse', rebased.tip + '^{tree}'), preview.tree);
  assert.equal(await git(repo, 'rev-parse', 'main'), head);
  assert.equal(await git(repo, 'rev-parse', 'relay/job'), tip);
  assert.equal(await readFile(path.join(job, shared), 'utf8'), 'local job edits\n');
  assert.deepEqual(await readdir(scratch), []);
  assert.equal((await worktreePaths(repo)).length, 2);

  await git(repo, 'merge', '--ff-only', rebased.tip);
  assert.equal(await readFile(path.join(repo, 'job.txt'), 'utf8'), 'job\n');
  assert.equal(await readFile(path.join(repo, shared), 'utf8'), 'main\n');
});

test('the merge preview returns original Unicode paths for conflicts', async t => {
  const { repo, job, commit } = await repoWithJob(t);
  const tip = await commit(job, shared, 'job\n');
  const head = await commit(repo, shared, 'main\n');
  assert.deepEqual(await previewMerge(repo, head, tip), { tree: null, conflicts: [shared] });
  assert.equal(await git(repo, 'rev-parse', 'main'), head);
  assert.equal(await git(repo, 'rev-parse', 'relay/job'), tip);
});

test('a conflict during patch replay leaves both original worktrees and branch tips intact', async t => {
  const { repo, job, scratch, commit } = await repoWithJob(t);
  await commit(job, shared, 'intermediate job edit\n');
  await commit(job, shared, 'base\n');
  const tip = await commit(job, 'job.txt', 'job\n');
  const head = await commit(repo, shared, 'main\n');
  const preview = await previewMerge(repo, head, tip);
  assert.equal(preview.conflicts, null);
  assert.deepEqual(await rebaseForMerge(repo, scratch, head, tip, preview.tree), { conflicts: [shared] });
  assert.equal(await git(repo, 'rev-parse', 'main'), head);
  assert.equal(await git(repo, 'rev-parse', 'relay/job'), tip);
  assert.equal(await git(job, 'status', '--porcelain'), '');
  assert.equal(await readFile(path.join(repo, shared), 'utf8'), 'main\n');
  assert.deepEqual(await readdir(scratch), []);
  assert.equal((await worktreePaths(repo)).length, 2);
});
