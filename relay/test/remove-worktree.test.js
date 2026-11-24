import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git, removeWorktreeFolder, worktreePaths } from '../server/git.js';

async function repoWithCommit(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-remove-worktree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await realpath(directory);
  await git(repo, 'init', '--quiet');
  await writeFile(path.join(repo, 'file.txt'), 'x\n');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  return repo;
}
const listed = async (repo, tree) => (await worktreePaths(repo)).some(entry => path.resolve(entry).toLowerCase() === path.resolve(tree).toLowerCase());

test('removes a normal worktree', async t => {
  const repo = await repoWithCommit(t);
  const tree = path.join(repo, 'trees', 'frontend-subtask-1');
  await git(repo, 'worktree', 'add', '--detach', tree);
  await removeWorktreeFolder(repo, tree);
  assert.equal(existsSync(tree), false);
  assert.equal(await listed(repo, tree), false);
});

// What a real job hit on Windows: git dropped its record of the worktree but the folder stayed,
// so a plain retry failed with "is not a working tree" and the whole role failed.
test('cleans up a folder git has already forgotten', async t => {
  const repo = await repoWithCommit(t);
  const tree = path.join(repo, 'trees', 'frontend-subtask-1');
  await git(repo, 'worktree', 'add', '--detach', tree);
  await writeFile(path.join(tree, 'leftover.txt'), 'still here\n');
  await rm(path.join(repo, '.git', 'worktrees', 'frontend-subtask-1'), { recursive: true, force: true });
  await assert.rejects(git(repo, 'worktree', 'remove', '--force', tree), /is not a working tree/);
  await removeWorktreeFolder(repo, tree);
  assert.equal(existsSync(tree), false);
  assert.equal(await listed(repo, tree), false);
});

test('a missing folder git never knew about is not an error', async t => {
  const repo = await repoWithCommit(t);
  await removeWorktreeFolder(repo, path.join(repo, 'trees', 'never-created'), { delayMs: 10 });
});
