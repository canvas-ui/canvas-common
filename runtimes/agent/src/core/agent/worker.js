import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import Agent from './Agent.js';

// One worker owns one agent. A supervisor may restart it independently of Canvas.
export function createWorkerServer({ token, createAgent = (options) => new Agent(options) }) {
    if (!token) throw new Error('CANVAS_WORKER_TOKEN is required');
    let agent;
    const server = http.createServer(async (req, res) => {
        const supplied = Buffer.from(req.headers.authorization || '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            res.writeHead(401).end(); return;
        }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        try {
            let body = '';
            for await (const chunk of req) {
                body += chunk;
                if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Request too large');
            }
            const data = JSON.parse(body || '{}');
            if (req.url === '/start') {
                await agent?.stop();
                agent = createAgent({ rootPath: data.rootPath, config: data.config });
                await agent.start({ canvasEnv: data.canvasEnv, localWorker: true });
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ context: agent.getSessionContext() }));
            } else if (!agent) {
                res.writeHead(409).end(JSON.stringify({ error: 'Worker not started' }));
            } else if (req.url === '/prompt') {
                res.setHeader('Content-Type', 'application/x-ndjson');
                res.flushHeaders();
                const disconnected = () => { if (!res.writableEnded) agent.abort(); };
                res.once('close', disconnected);
                try {
                    await agent.stream(data.message, (event) => res.write(`${JSON.stringify({ event })}\n`), data.options);
                } finally {
                    res.off('close', disconnected);
                }
                res.end(`${JSON.stringify({ context: agent.getSessionContext() })}\n`);
            } else if (req.url === '/abort') {
                agent.abort(); res.end('{}');
            } else if (req.url === '/stop') {
                await agent.stop(); res.end('{}');
            } else {
                res.writeHead(404).end();
            }
        } catch (error) {
            if (res.headersSent) res.end(`${JSON.stringify({ error: error.message })}\n`);
            else res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
        }
    });
    server.on('close', () => { void agent?.stop(); });
    return server;
}

export function startWorker() {
    const server = createWorkerServer({ token: process.env.CANVAS_WORKER_TOKEN });
    server.listen(Number(process.env.CANVAS_WORKER_PORT || 0), process.env.CANVAS_WORKER_HOST || '127.0.0.1', () => {
        const port = server.address().port;
        if (process.send) process.send({ port });
        else console.log(`Canvas agent worker listening on port ${port}`);
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
        server.close(() => { if (process.connected) process.disconnect(); });
        server.closeIdleConnections();
    });
    process.on('disconnect', () => server.close());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) startWorker();
