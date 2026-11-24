import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git } from '../server/git.js';

// Parallel subtasks add worktrees at the same time. Without serialising, git can read another add's half-written
// .git/worktrees entry and fail with "failed to read .git/worktrees/<name>/commondir".
test('concurrent worktree add and remove in one repository all succeed', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-worktree-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await realpath(directory);
  await git(repo, 'init', '--quiet');
  await writeFile(path.join(repo, 'file.txt'), 'x\n');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  const head = await git(repo, 'rev-parse', 'HEAD');
  const names = Array.from({ length: 30 }, (_, index) => (index % 2 ? 'backend' : 'frontend') + '-subtask-' + index);

  for (let round = 0; round < 2; round++) {
    const trees = names.map(name => path.join(repo, '..', path.basename(repo) + '-wt-' + round, name));
    await Promise.all(trees.map(tree => git(repo, 'worktree', 'add', '--detach', tree, head)));
    const listed = await git(repo, 'worktree', 'list', '--porcelain');
    for (const tree of trees) assert.ok(listed.includes(path.basename(tree)), 'missing ' + tree);
    await Promise.all(trees.map(tree => git(repo, 'worktree', 'remove', '--force', tree)));
    await rm(path.join(repo, '..', path.basename(repo) + '-wt-' + round), { recursive: true, force: true });
  }
  assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
});

test('a failed worktree command does not block the next one', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-worktree-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await realpath(directory);
  await git(repo, 'init', '--quiet');
  await assert.rejects(git(repo, 'worktree', 'remove', path.join(repo, 'does-not-exist')));
  assert.match(await git(repo, 'worktree', 'list'), /\S/);
});
