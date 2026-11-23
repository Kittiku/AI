import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  NO_WORK_NOTE, effectiveParallelLimit, isNoWorkRole, normalizeSubtasks, normalizeTeamSettings,
  runSubtaskScheduler, shouldCheckSubtask
} from '../server/team.js';

test('team settings default, clamp parallelism and preserve existing fields', () => {
  const legacy = Object.freeze({ mode: 'off', maxSubtasks: 5, extra: 'keep' });
  assert.deepEqual(normalizeTeamSettings(legacy), { ...legacy, parallel: 2, check: 'always' });
  assert.deepEqual(normalizeTeamSettings(), { parallel: 2, check: 'always' });
  assert.deepEqual(normalizeTeamSettings({ parallel: 0, check: 'hard' }), { parallel: 1, check: 'hard' });
  assert.deepEqual(normalizeTeamSettings({ parallel: 7, check: 'off' }), { parallel: 3, check: 'off' });
  assert.deepEqual(normalizeTeamSettings({ parallel: NaN, check: 'invalid' }), { parallel: 2, check: 'always' });
  assert.equal(normalizeTeamSettings({ parallel: 2.8 }).parallel, 2);
});

test('a role has no work only when its description, files and subtasks are empty', () => {
  assert.equal(NO_WORK_NOTE, 'แผนไม่มีงานส่วนนี้');
  for (const frontend of [undefined, '', '  ', ' NoNe ', 'ไม่มี', ' ไม่มีงาน ', 'ไม่มีงานส่วนนี้']) {
    assert.equal(isNoWorkRole({ frontend, frontendFiles: [], frontendTasks: [], backend: 'Build API' }, 'frontend'), true);
  }
  assert.equal(isNoWorkRole({ backend: 'none' }, 'backend'), true);
  assert.equal(isNoWorkRole({ frontend: 'none', frontendFiles: ['ui.js'] }, 'frontend'), false);
  assert.equal(isNoWorkRole({ frontend: 'ไม่มี', frontendTasks: [{ title: 'UI' }] }, 'frontend'), false);
  assert.equal(isNoWorkRole({ frontend: 'ไม่มีงานส่วนนี้ แต่ต้องแก้ปุ่ม' }, 'frontend'), false);
  assert.equal(isNoWorkRole({ frontendFiles: 'ui.js' }, 'frontend'), false);
  assert.equal(isNoWorkRole(null, 'frontend'), false);
  assert.equal(isNoWorkRole({}, 'review'), false);
});

test('subtask check modes use the plan complexity', () => {
  for (const complexity of ['simple', 'medium', 'hard', undefined]) {
    assert.equal(shouldCheckSubtask('always', complexity), true);
    assert.equal(shouldCheckSubtask('hard', complexity), complexity === 'hard');
    assert.equal(shouldCheckSubtask('off', complexity), false);
  }
  assert.equal(shouldCheckSubtask(undefined, 'simple'), true);
});

test('subtask normalization preserves positions and removes invalid and duplicate dependencies', () => {
  const dependencies = Object.freeze([2, 2, 1, 0, -1, 4, 1.5, '3', null]);
  const tasks = Object.freeze([Object.freeze({ title: 'First', dependsOn: dependencies }), {}, { dependsOn: '1' }]);
  assert.deepEqual(normalizeSubtasks(tasks), [{ title: 'First', dependsOn: [2] }, { dependsOn: [] }, { dependsOn: [] }]);
  assert.deepEqual(normalizeSubtasks(null), []);
});

test('subtask normalization breaks cycles and preserves other dependencies', () => {
  const tasks = [{ dependsOn: [2, 4] }, { dependsOn: [3] }, { dependsOn: [1, 4] }, {}, { dependsOn: [1, 4] }];
  const normalized = normalizeSubtasks(tasks);
  assert.deepEqual(normalized.map(task => task.dependsOn), [[2, 4], [3], [4], [], [1, 4]]);
  assert.deepEqual(normalizeSubtasks(normalized), normalized);
});

test('effective parallel limit respects both settings and the number of ready providers', () => {
  assert.equal(effectiveParallelLimit(1, 3), 1);
  assert.equal(effectiveParallelLimit(2, 3), 2);
  assert.equal(effectiveParallelLimit(3, 2), 2);
  assert.equal(effectiveParallelLimit(3, 1), 1);
  assert.equal(effectiveParallelLimit(3, 0), 1);
  assert.equal(effectiveParallelLimit(99, 99), 3);
});

test('the scheduler fills free slots with independent tasks while a dependent waits for check and merge', async () => {
  const implementation = Promise.withResolvers();
  const check = Promise.withResolvers();
  const merge = Promise.withResolvers();
  const started = [];
  const checked = [];
  const merged = [];
  const waiting = [];
  const run = runSubtaskScheduler({
    tasks: [{}, { dependsOn: [1] }, {}, {}], teamParallel: 2, availableProviders: 3,
    async runSubtask(_task, number) {
      started.push(number);
      if (number === 1) {
        await implementation.promise;
        checked.push(number);
        await check.promise;
      }
      return 'result ' + number;
    },
    async mergeSubtask(_task, _result, number) {
      if (number === 1) await merge.promise;
      merged.push(number);
    },
    onWaiting(_task, waitingOn, number) { waiting.push([number, waitingOn]); }
  });

  await nextTurn();
  assert.deepEqual(started, [1, 3, 4]);
  assert.deepEqual(waiting, [[2, [1]]]);
  assert.deepEqual(merged, []);
  implementation.resolve();
  await nextTurn();
  assert.deepEqual(checked, [1]);
  assert.deepEqual(started, [1, 3, 4]);
  check.resolve();
  await nextTurn();
  assert.deepEqual(started, [1, 3, 4]);
  assert.deepEqual(waiting, [[2, [1]]]);
  merge.resolve();
  assert.deepEqual(await run, ['result 1', 'result 2', 'result 3', 'result 4']);
  assert.deepEqual(started, [1, 3, 4, 2]);
  assert.deepEqual(merged, [1, 2, 3, 4]);
  assert.deepEqual(waiting, [[2, [1]], [2, []]]);
});

test('parallel = 1 waits for forward dependencies and writes directly to the role branch', async () => {
  const events = [];
  const results = await runSubtaskScheduler({
    tasks: [{ dependsOn: [2] }, {}, {}], teamParallel: 1,
    availableProviders: () => assert.fail('serial mode needs no provider count'),
    async runSubtask(_task, number) {
      events.push(['start', number]);
      await nextTurn();
      events.push(['done', number]);
      return number;
    },
    onWaiting(_task, waitingOn, number) { events.push(['waiting', number, waitingOn]); },
    mergeSubtask: () => assert.fail('serial mode writes directly to the role branch')
  });
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(events, [
    ['waiting', 1, [2]], ['start', 2], ['done', 2], ['waiting', 1, []],
    ['start', 1], ['done', 1], ['start', 3], ['done', 3]
  ]);
});

test('the scheduler caps active work at the number of ready providers', async () => {
  for (const availableProviders of [2, 1, 0]) {
    let active = 0;
    let peak = 0;
    const merged = [];
    const results = await runSubtaskScheduler({
      tasks: [{}, {}, {}, {}], teamParallel: 3, availableProviders,
      async runSubtask(_task, number) {
        active++;
        peak = Math.max(peak, active);
        await nextTurn();
        active--;
        return number;
      },
      mergeSubtask(_task, result) { merged.push(result); }
    });
    assert.equal(peak, Math.max(1, availableProviders));
    assert.deepEqual(merged, [1, 2, 3, 4]);
    assert.deepEqual(results, [1, 2, 3, 4]);
  }
});

test('provider availability is rechecked before dispatch without interrupting active subtasks', async () => {
  const gates = Array.from({ length: 6 }, () => Promise.withResolvers());
  const started = [];
  const finished = [];
  let available = 3;
  const run = runSubtaskScheduler({
    tasks: gates.map(() => ({})), teamParallel: 3,
    availableProviders: () => available,
    async runSubtask(_task, number) {
      started.push(number);
      await gates[number - 1].promise;
      finished.push(number);
      return number;
    },
    mergeSubtask() {}
  });

  await nextTurn();
  assert.deepEqual(started, [1, 2, 3]);
  available = 1;
  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, [1, 2, 3]);
  gates[1].resolve();
  await nextTurn();
  assert.deepEqual(started, [1, 2, 3]);
  gates[2].resolve();
  await nextTurn();
  assert.deepEqual(finished, [1, 2, 3]);
  assert.deepEqual(started, [1, 2, 3, 4]);

  available = 2;
  gates[3].resolve();
  await nextTurn();
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6]);
  for (const gate of gates.slice(4)) gate.resolve();
  assert.deepEqual(await run, [1, 2, 3, 4, 5, 6]);
});

test('forward dependencies and cycles still yield results in plan order', async () => {
  const merged = [];
  const results = await runSubtaskScheduler({
    tasks: [{ dependsOn: [2] }, { dependsOn: [1] }, {}], teamParallel: 2, availableProviders: 2,
    runSubtask(_task, number) {
      if (number === 1) assert.deepEqual(merged, [2]);
      return number;
    },
    mergeSubtask(_task, result) { merged.push(result); }
  });
  assert.deepEqual(merged, [2, 1, 3]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(await runSubtaskScheduler({ tasks: [] }), []);
});

test('a conflict reruns the task on the merged code before unlocking its dependents', async () => {
  const rerun = Promise.withResolvers();
  const branch = [];
  const events = [];
  const waiting = [];
  const run = runSubtaskScheduler({
    tasks: [{}, {}, { dependsOn: [1, 2] }], teamParallel: 3, availableProviders: 3,
    runSubtask(_task, number) {
      events.push('start ' + number);
      if (number === 3) assert.deepEqual(branch, ['isolated 1', 'rerun 2']);
      return 'isolated ' + number;
    },
    mergeSubtask(_task, result, number) {
      events.push('merge ' + number);
      if (number === 2) return { conflict: true };
      branch.push(result);
    },
    async rerunSequential(_task, number) {
      events.push('rerun ' + number);
      assert.deepEqual(branch, ['isolated 1']);
      await rerun.promise;
      branch.push('rerun 2');
      return 'rerun 2';
    },
    onWaiting(_task, waitingOn, number) { waiting.push([number, waitingOn]); }
  });

  await nextTurn();
  assert.deepEqual(events, ['start 1', 'start 2', 'merge 1', 'merge 2', 'rerun 2']);
  assert.deepEqual(waiting, [[3, [1, 2]], [3, [2]]]);
  rerun.resolve();
  assert.deepEqual(await run, ['isolated 1', 'rerun 2', 'isolated 3']);
  assert.deepEqual(branch, ['isolated 1', 'rerun 2', 'isolated 3']);
  assert.deepEqual(waiting, [[3, [1, 2]], [3, [2]], [3, []]]);
});

test('a conflict rerun waits for active siblings and pauses new work until it finishes', async () => {
  const second = Promise.withResolvers();
  const third = Promise.withResolvers();
  const rerun = Promise.withResolvers();
  const events = [];
  const run = runSubtaskScheduler({
    tasks: [{}, {}, {}, { dependsOn: [2] }], teamParallel: 2, availableProviders: 2,
    async runSubtask(_task, number) {
      events.push('start ' + number);
      if (number === 2) await second.promise;
      if (number === 3) await third.promise;
      events.push('done ' + number);
      return number;
    },
    mergeSubtask(_task, _result, number) {
      events.push('merge ' + number);
      if (number === 2) return { conflict: true };
    },
    async rerunSequential(_task, number) {
      events.push('rerun ' + number);
      await rerun.promise;
      return 'rerun ' + number;
    }
  });

  await nextTurn();
  assert.deepEqual(events, ['start 1', 'done 1', 'start 2', 'merge 1', 'start 3']);
  second.resolve();
  await nextTurn();
  assert.deepEqual(events.slice(-2), ['done 2', 'merge 2']);
  assert.ok(!events.includes('rerun 2'));
  third.resolve();
  await nextTurn();
  assert.deepEqual(events.slice(-2), ['done 3', 'rerun 2']);
  assert.ok(!events.includes('start 4'));
  rerun.resolve();
  assert.deepEqual(await run, [1, 'rerun 2', 3, 4]);
  assert.deepEqual(events.slice(-4), ['merge 3', 'start 4', 'done 4', 'merge 4']);
});

test('a failed check blocks dependents and lets already running work settle before cleanup', async () => {
  const independent = Promise.withResolvers();
  const failure = Error('check failed');
  const started = [];
  let settled = false;
  const run = runSubtaskScheduler({
    tasks: [{}, { dependsOn: [1] }, {}, {}], teamParallel: 2, availableProviders: 2,
    async runSubtask(_task, number) {
      started.push(number);
      if (number === 1) throw failure;
      await independent.promise;
    },
    mergeSubtask: () => assert.fail('a failed run must not merge')
  });
  const rejection = assert.rejects(run.finally(() => { settled = true; }), error => error === failure);

  await nextTurn();
  assert.deepEqual(started, [1, 3]);
  assert.equal(settled, false);
  independent.resolve();
  await rejection;
  assert.deepEqual(started, [1, 3]);
});
