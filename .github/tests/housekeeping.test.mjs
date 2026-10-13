import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Script, createContext } from 'node:vm';

const workflow = readFileSync(new URL('../workflows/housekeeping.yml', import.meta.url), 'utf8');
const source = workflow.split('          script: |\n')[1].replace(/^ {12}/gm, '');
const policy = new Script(`(async () => {\n${source}\n})()`);
const stamp = id => new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString();
const run = (id, workflow_id = 1, extra = {}) => ({ id, workflow_id, name: `workflow-${workflow_id}`, created_at: stamp(id), status: 'completed', run_attempt: 1, ...extra });
const release = (id, extra = {}) => ({ id, tag_name: `v${id}`, draft: false, published_at: stamp(id), updated_at: stamp(id), assets: [{ id }], ...extra });

async function execute({ runs = [], refreshedRuns = runs, releases = [], current = null, dryRun = false, liveRuns = {}, liveReleases = {}, listError = false, deleteError = null, keep = '7' } = {}) {
  const calls = [];
  const logs = [];
  const rest = {
    actions: {
      listWorkflowRunsForRepo: 'runs',
      getWorkflowRun: async ({ run_id }) => {
        calls.push(['get-run', run_id]);
        return { data: liveRuns[run_id] || (current?.id === run_id ? current : runs.find(r => r.id === run_id)) };
      },
      deleteWorkflowRun: async ({ run_id }) => {
        if (deleteError) throw Object.assign(new Error('delete refused'), { status: deleteError });
        calls.push(['delete-run', run_id]);
      },
    },
    repos: {
      listReleases: 'releases',
      getRelease: async ({ release_id }) => {
        calls.push(['get-release', release_id]);
        return { data: liveReleases[release_id] || releases.find(r => r.id === release_id) };
      },
      deleteRelease: async ({ release_id }) => { calls.push(['delete-release', release_id]); },
    },
  };
  const github = {
    rest,
    paginate: async (method, args) => {
      assert.deepEqual(Object.keys(args).sort(), ['owner', 'per_page', 'repo']);
      assert.equal(args.per_page, 100);
      calls.push(['paginate', method]);
      if (method === 'releases' && listError) throw new Error('listing failed');
      if (method === 'runs') return calls.filter(c => c[0] === 'paginate' && c[1] === 'runs').length > 1 ? refreshedRuns : runs;
      return releases;
    },
  };
  const sandbox = createContext({
    github, context: { repo: { owner: 'canvas-ui', repo: 'test' }, runId: current?.id },
    process: { env: { KEEP_RUNS: keep, KEEP_RELEASES: keep, DRY_RUN: String(dryRun) } },
    core: { info: message => logs.push(message) },
  });
  try { await policy.runInContext(sandbox); }
  catch (error) { error.calls = calls; throw error; }
  return { calls, logs, deletedRuns: calls.filter(c => c[0] === 'delete-run').map(c => c[1]), deletedReleases: calls.filter(c => c[0] === 'delete-release').map(c => c[1]) };
}

test('keeps seven independently per workflow across branches and conclusions', async () => {
  const runs = [run(100, 1, { status: 'in_progress' }), run(101, 2, { status: 'queued' })];
  for (const workflow of [1, 2, 3]) {
    for (let n = 1; n <= 10; n++) runs.push(run(workflow * 10 + n, workflow, { conclusion: n % 2 ? 'failure' : 'success' }));
  }
  const result = await execute({ runs: runs.reverse() });
  assert.deepEqual(result.deletedRuns.sort((a, b) => a - b), [11, 12, 13, 21, 22, 23, 31, 32, 33]);
  assert.deepEqual(result.calls.slice(0, 2), [['paginate', 'runs'], ['paginate', 'releases']]);
});

test('covers removed workflows and more than 1,000 runs without filtered API searches', async () => {
  const runs = Array.from({ length: 1107 }, (_, i) => run(i + 1, 99));
  const result = await execute({ runs });
  assert.equal(result.deletedRuns.length, 1100);
  assert.equal(Math.max(...result.deletedRuns), 1100);
});

test('reserves one of housekeeping’s seven slots for the current run, even an old rerun', async () => {
  const current = run(1, 8, { status: 'in_progress' });
  const runs = [current, ...Array.from({ length: 8 }, (_, i) => run(100 + i, 8))];
  const result = await execute({ runs, current });
  assert.deepEqual(result.deletedRuns, [101, 100]);
  assert(!result.deletedRuns.includes(current.id));
});

test('pagination duplicates do not consume retention slots', async () => {
  const runs = Array.from({ length: 8 }, (_, i) => run(i + 1));
  const result = await execute({ runs: [...runs, run(8), run(8)], releases: [release(9), release(9)] });
  assert.deepEqual(result.deletedRuns, [1]);
  assert.deepEqual(result.deletedReleases, []);
});

test('orders releases by publication date across tag prefixes, including prereleases', async () => {
  const releases = Array.from({ length: 10 }, (_, i) => release(i + 1, { tag_name: `${i % 2 ? 'cli' : 'web'}-v${i}`, prerelease: i % 2 === 1 }));
  releases[0].published_at = stamp(20); // Old commit, newly published release.
  const result = await execute({ releases: releases.reverse() });
  assert.deepEqual(result.deletedReleases, [4, 3, 2]);
});

test('removes empty drafts while preserving published releases and drafts with assets', async () => {
  const releases = [release(1), release(20, { draft: true, published_at: null, assets: [] }), release(21, { draft: true, published_at: null })];
  const result = await execute({ releases });
  assert.deepEqual(result.deletedReleases, [20]);
});

test('defers empty drafts while a producer is queued, running or waiting for approval', async () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const result = await execute({ runs: [run(1, 2, { status })], releases: [release(2, { draft: true, published_at: null, assets: [] })] });
    assert.deepEqual(result.deletedReleases, []);
  }
});

test('rechecks old runs so newly running or recently rerun jobs are not deleted', async () => {
  const runs = Array.from({ length: 9 }, (_, i) => run(i + 1));
  const result = await execute({ runs, liveRuns: { 1: run(1, 1, { status: 'in_progress' }), 2: run(2, 1, { run_attempt: 2 }) } });
  assert.deepEqual(result.deletedRuns, []);
});

test('defers empty drafts if a publisher starts during run cleanup', async () => {
  const result = await execute({
    refreshedRuns: [run(100, 2, { status: 'queued' })],
    releases: [release(20, { draft: true, published_at: null, assets: [] })],
  });
  assert.deepEqual(result.deletedReleases, []);
  assert(result.logs.some(line => line.includes('another workflow started')));
});

test('rechecks releases so new uploads and publications are not discarded', async () => {
  const releases = [...Array.from({ length: 8 }, (_, i) => release(i + 1)), release(20, { draft: true, published_at: null, assets: [] })];
  const result = await execute({ releases, liveReleases: { 1: release(1, { updated_at: stamp(30) }), 20: release(20, { draft: true, published_at: null }) } });
  assert.deepEqual(result.deletedReleases, []);
});

test('dry runs preview candidates without invoking deletion or recheck APIs', async () => {
  const result = await execute({ dryRun: true, runs: Array.from({ length: 8 }, (_, i) => run(i + 1)), releases: [release(20, { draft: true, published_at: null, assets: [] })] });
  assert.deepEqual(result.calls, [['paginate', 'runs'], ['paginate', 'releases']]);
  assert(result.logs.some(line => line.includes('Would delete run 1')));
  assert(result.logs.some(line => line.includes('Would delete release 20')));
});

test('incomplete inventories and invalid limits cannot cause partial cleanup', async () => {
  await assert.rejects(execute({ listError: true, runs: Array.from({ length: 8 }, (_, i) => run(i + 1)) }), error => {
    assert(!error.calls.some(c => c[0].startsWith('delete')));
    return error.message === 'listing failed';
  });
  await assert.rejects(execute({ keep: '0' }), /positive integers/);
});

test('already removed items are harmless; permission and rate-limit errors fail the job', async () => {
  const runs = Array.from({ length: 8 }, (_, i) => run(i + 1));
  await execute({ runs, deleteError: 404 });
  for (const deleteError of [403, 429]) await assert.rejects(execute({ runs, deleteError }), /delete refused/);
});
