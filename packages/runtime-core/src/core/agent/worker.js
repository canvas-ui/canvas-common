export * from '@augmentd-labs/canvas-agent-runtime/core/agent/worker.js';
import { startWorker } from '@augmentd-labs/canvas-agent-runtime/core/agent/worker.js';
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) startWorker();
