export const NO_WORK_NOTE = 'แผนไม่มีงานส่วนนี้';

const checkModes = ['always', 'hard', 'off'];

function normalizeParallel(value) {
  return Number.isFinite(value) ? Math.max(1, Math.min(3, Math.trunc(value))) : 2;
}

export function normalizeTeamSettings(team) {
  return {
    ...team,
    parallel: normalizeParallel(team?.parallel),
    check: checkModes.includes(team?.check) ? team.check : 'always'
  };
}

const emptyList = value => value == null || (Array.isArray(value) && value.length === 0);

export function isNoWorkRole(plan, role) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !['backend', 'frontend'].includes(role)) return false;
  const description = plan[role] ?? '';
  return typeof description === 'string' &&
    ['', 'none', 'ไม่มี', 'ไม่มีงาน', 'ไม่มีงานส่วนนี้'].includes(description.trim().toLowerCase()) &&
    emptyList(plan[role + 'Files']) && emptyList(plan[role + 'Tasks']);
}

export function shouldCheckSubtask(checkMode, complexity) {
  if (checkMode === 'off') return false;
  return checkMode !== 'hard' || complexity === 'hard';
}

export function normalizeSubtasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  const normalized = Array.from(tasks, (task, index) => {
    const dependencies = Array.isArray(task?.dependsOn) ? task.dependsOn : [];
    const valid = dependencies.filter(number => Number.isInteger(number) &&
      number >= 1 && number <= tasks.length && number !== index + 1);
    return { ...task, dependsOn: [...new Set(valid)] };
  });

  const visiting = new Set();
  const visited = new Set();
  // Drop edges back to a task on the current path. Keep dependencies between separate paths.
  function visit(number) {
    visiting.add(number);
    const task = normalized[number - 1];
    task.dependsOn = task.dependsOn.filter(dependency => {
      if (visiting.has(dependency)) return false;
      if (!visited.has(dependency)) visit(dependency);
      return true;
    });
    visiting.delete(number);
    visited.add(number);
  }
  for (let number = 1; number <= normalized.length; number++) {
    if (!visited.has(number)) visit(number);
  }
  return normalized;
}

export function effectiveParallelLimit(teamParallel, availableProviders) {
  const available = Number.isFinite(availableProviders) ? Math.trunc(availableProviders) : 0;
  return Math.max(1, Math.min(normalizeParallel(teamParallel), available));
}

// Prefer plan order among tasks whose dependencies are already in the merge order.
function subtaskOrder(tasks) {
  const pending = new Set(tasks.map((_, index) => index + 1));
  const order = [];
  while (pending.size) {
    for (const number of pending) {
      if (tasks[number - 1].dependsOn.some(dependency => pending.has(dependency))) continue;
      order.push(number);
      pending.delete(number);
      break;
    }
  }
  return order;
}

// runSubtask(task, number) resolves after implementation and any required check pass.
// With parallel = 1 it runs directly on the role branch, in dependency order with plan order as the tie-breaker.
// Otherwise mergeSubtask(task, result, number) applies an isolated result to the role branch.
// Return { conflict: true } after undoing a conflicted merge. rerunSequential(task, number)
// then applies and checks a replacement directly on the role branch and returns its result.
// availableProviders may be a function read before dispatching each set of ready tasks.
// onWaiting(task, waitingOn, number) reports changed dependency lists, including when cleared.
// The returned results are indexed in plan order even when a dependency points forward.
export async function runSubtaskScheduler({
  tasks, teamParallel, availableProviders, runSubtask, mergeSubtask, rerunSequential, onWaiting, signal
}) {
  const subtasks = normalizeSubtasks(tasks);
  const parallel = normalizeParallel(teamParallel);
  const countAvailable = typeof availableProviders === 'function' ? availableProviders : () => availableProviders;
  const results = [];
  const order = subtaskOrder(subtasks);
  const pending = new Set(order);
  const running = new Set();
  const completed = new Map();
  const merged = new Set();
  const waitingCounts = new Map();
  let failure;

  try {
    let nextMerge = 0;
    while (nextMerge < order.length) {
      signal?.throwIfAborted();
      if (failure) throw failure.error;

      const ready = [];
      for (const number of pending) {
        const task = subtasks[number - 1];
        const waitingOn = task.dependsOn.filter(dependency => !merged.has(dependency));
        if (waitingOn.length !== (waitingCounts.get(number) ?? 0)) {
          waitingCounts.set(number, waitingOn.length);
          onWaiting?.(task, waitingOn, number);
        }
        if (!waitingOn.length) ready.push(number);
      }

      // Confirm each result in order. Serial tasks have already written to the role branch.
      const number = order[nextMerge];
      if (completed.has(number)) {
        const task = subtasks[number - 1];
        const result = completed.get(number);
        const outcome = parallel === 1 ? null : await mergeSubtask(task, result, number);
        // Drain active work and pause dispatch while the conflicted task runs on the role branch.
        if (outcome?.conflict) await Promise.all(running);
        signal?.throwIfAborted();
        if (failure) throw failure.error;
        results[number - 1] = outcome?.conflict ? await rerunSequential(task, number) : result;
        signal?.throwIfAborted();
        merged.add(number);
        completed.delete(number);
        nextMerge++;
        continue;
      }

      if (ready.length && running.size < parallel) {
        const limit = parallel === 1 ? 1 : effectiveParallelLimit(parallel, countAvailable());
        const slots = Math.max(0, limit - running.size);
        for (const number of ready.slice(0, slots)) {
          pending.delete(number);
          const task = subtasks[number - 1];
          const work = Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return runSubtask(task, number);
          })
            .then(result => completed.set(number, result), error => { failure ??= { error }; })
            .finally(() => running.delete(work));
          running.add(work);
        }
      }
      await Promise.race(running);
    }
    return results;
  } finally {
    // The caller can clean up worktrees as soon as the scheduler settles.
    await Promise.all(running);
  }
}
