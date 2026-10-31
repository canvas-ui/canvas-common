import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../../utils/log.js';
import { BACKFILL_JOB_LIMIT, BackfillRequestError, requireBackfillRule, runBackfillBatch } from './backfill.js';

const logger = createLogger('hooks:backfill-jobs');

const KEEP_FINISHED = 20;
const PROGRESS_EVERY_MS = 1000;
const JOBS_FILE = 'backfill-jobs.json';

// Whole-rule backfills running inside the workspace. A job is saved after each
// batch, so a workspace stop leaves it `running` and the next start continues
// it from the last finished batch, repeating the documents of the batch that
// was cut off.
//
// Subscribers of the workspace channel see job.started, job.progress and
// job.finished, each carrying the job. `source: 'hook'` keeps them out of
// hook dispatch.
export default class BackfillJobs {
    #workspace;
    #track;
    #jobs = new Map(); // id -> job, oldest first
    #active = new Set();
    #cancelling = new Set();
    #stopping = false;

    // `track(promise)` lets the owner wait for runs when it shuts down.
    constructor(workspace, track = () => {}) {
        this.#workspace = workspace;
        this.#track = track;
    }

    start({ ruleIds, limit = BACKFILL_JOB_LIMIT }) {
        for (const ruleId of ruleIds) requireBackfillRule(this.#workspace.hooks, ruleId);
        const same = JSON.stringify(ruleIds);
        const running = [...this.#jobs.values()].find((job) => job.status === 'running' && JSON.stringify(job.ruleIds) === same);
        if (running) return { ...running };

        const job = {
            id: crypto.randomUUID(), kind: 'rule-backfill', ruleIds, limit, status: 'running',
            ruleIndex: 0, offset: 0, processed: 0, total: null,
            checked: 0, applied: 0, skipped: 0, failed: 0, error: null,
            startedAt: new Date().toISOString(), finishedAt: null,
        };
        this.#jobs.set(job.id, job);
        this.#save();
        this.#begin(job);
        return { ...job };
    }

    get(id) {
        const job = this.#jobs.get(id);
        return job ? { ...job } : null;
    }

    list() { return [...this.#jobs.values()].map((job) => ({ ...job })); }

    // Ends between documents; the job reports `cancelled` through job.finished.
    cancel(id) {
        const job = this.#jobs.get(id);
        if (!job) return null;
        if (job.status === 'running') this.#cancelling.add(id);
        return { ...job };
    }

    stop() { this.#stopping = true; }

    // Continue what the last stop left running.
    async resume() {
        await Promise.allSettled([...this.#active]);
        this.#stopping = false;
        this.#jobs = this.#load() ?? this.#jobs;
        for (const job of this.#jobs.values()) {
            if (job.status === 'running') this.#begin(job);
        }
    }

    #begin(job) {
        const run = this.#run(job).finally(() => this.#active.delete(run));
        this.#active.add(run);
        this.#track(run);
        this.#emit('job.started', job);
    }

    async #run(job) {
        const shouldStop = () => this.#stopping || this.#cancelling.has(job.id);
        let lastEvent = Date.now();
        const onResult = ({ status, actions = [] }) => {
            job.checked++;
            job.processed++;
            if (status === 'error') job.failed++;
            else if (status === 'skipped') { /* the rule does not apply to this document */ }
            else if (actions.some((action) => action.status === 'skipped')) job.skipped++;
            else job.applied++;
            if (Date.now() - lastEvent >= PROGRESS_EVERY_MS) {
                lastEvent = Date.now();
                this.#emit('job.progress', job);
            }
        };
        try {
            for (;;) {
                const ruleId = job.ruleIds[job.ruleIndex];
                while (job.offset !== null) {
                    const page = await runBackfillBatch(this.#workspace, { ruleId, limit: job.limit, offset: job.offset }, { onResult, shouldStop });
                    if (shouldStop()) break;
                    job.total = page.total ?? null;
                    job.offset = page.nextOffset;
                    this.#save();
                    lastEvent = Date.now();
                    this.#emit('job.progress', job);
                }
                if (shouldStop() || job.ruleIndex === job.ruleIds.length - 1) break;
                Object.assign(job, { ruleIndex: job.ruleIndex + 1, offset: 0, processed: 0, total: null });
                this.#save();
            }
            if (this.#cancelling.has(job.id)) this.#finish(job, 'cancelled');
            else if (!this.#stopping) this.#finish(job, 'done');
        } catch (error) {
            // A rule deleted or changed mid-run has nothing left to reconcile.
            if (error instanceof BackfillRequestError) this.#finish(job, 'cancelled');
            else this.#finish(job, 'failed', error.message);
        }
    }

    #finish(job, status, error = null) {
        this.#cancelling.delete(job.id);
        job.status = status;
        job.error = error;
        job.finishedAt = new Date().toISOString();
        const finished = [...this.#jobs.values()].filter((entry) => entry.status !== 'running');
        for (const old of finished.slice(0, -KEEP_FINISHED)) this.#jobs.delete(old.id);
        this.#save();
        this.#emit('job.finished', job);
    }

    #emit(event, job) {
        const { id, name } = this.#workspace;
        this.#workspace.emit?.(event, { workspaceId: id, workspaceName: name, source: 'hook', job: { ...job } });
    }

    get #file() {
        const dir = this.#workspace.varHooksPath;
        return dir ? path.join(dir, JOBS_FILE) : null;
    }

    #load() {
        if (!this.#file) return null;
        try {
            const jobs = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
            return new Map(jobs.map((job) => [job.id, job]));
        } catch (error) {
            if (error.code !== 'ENOENT') logger.warn(`Unreadable ${JOBS_FILE}: ${error.message}`);
            return null;
        }
    }

    // A failed save costs at most a repeated batch, never the run.
    #save() {
        const file = this.#file;
        if (!file) return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.list()));
            fs.renameSync(`${file}.tmp`, file);
        } catch (error) {
            logger.warn(`Could not save ${JOBS_FILE}: ${error.message}`);
        }
    }
}
