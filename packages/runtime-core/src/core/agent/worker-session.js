import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export async function createWorkerSession({ rootPath, config, canvasEnv, onExit = () => {} }) {
    const runtime = config.config?.runtime || {};
    if (canvasEnv && runtime.canvasUrl) {
        const apiUrl = new URL(runtime.canvasUrl);
        if (!['http:', 'https:'].includes(apiUrl.protocol)) throw new Error('runtime.canvasUrl must use HTTP or HTTPS');
        canvasEnv = { ...canvasEnv, CANVAS_URL: apiUrl.href.replace(/\/$/, '') };
    }
    let child;
    let disposing = false;
    let url = runtime.url;
    let token = process.env.CANVAS_WORKER_TOKEN;
    if (runtime.type === 'process') {
        token = randomBytes(32).toString('hex');
        child = fork(new URL('./worker.js', import.meta.url), [], {
            env: { ...process.env, CANVAS_WORKER_TOKEN: token, CANVAS_WORKER_PORT: '0', CANVAS_WORKER_HOST: '127.0.0.1' },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        try {
            const port = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Worker startup timed out')), 30000);
                child.once('message', (message) => { clearTimeout(timer); resolve(message.port); });
                child.once('error', (error) => { clearTimeout(timer); reject(error); });
                child.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited')); });
            });
            url = `http://127.0.0.1:${port}`;
        } catch (error) { child.kill(); throw error; }
    }
    if (!url || !token) throw new Error('Remote workers require runtime.url and CANVAS_WORKER_TOKEN');
    const request = async (route, body = {}) => {
        const response = await fetch(new URL(route, url), {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Agent worker HTTP ${response.status}: ${await response.text()}`);
        return response;
    };
    let context;
    try {
        context = (await (await request('/start', { rootPath, config, canvasEnv })).json()).context;
    } catch (error) { child?.kill(); throw error; }
    child?.on('exit', () => { if (!disposing) onExit(); });
    const subscribers = new Set();
    let pending;
    const session = {
        isStreaming: false,
        sessionManager: {
            getSessionId: () => context.sessionId,
            getSessionFile: () => context.sessionFile,
            buildSessionContext: () => context,
        },
        subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
        async prompt(message, options) {
            if (session.isStreaming) throw new Error('Agent worker is already processing a prompt');
            session.isStreaming = true;
            pending = (async () => {
                const response = await request('/prompt', { message, options });
                let buffer = '';
                let completed = false;
                const decoder = new TextDecoder();
                for await (const chunk of response.body) {
                    buffer += decoder.decode(chunk, { stream: true });
                    let newline;
                    while ((newline = buffer.indexOf('\n')) !== -1) {
                        const entry = JSON.parse(buffer.slice(0, newline));
                        buffer = buffer.slice(newline + 1);
                        if (entry.error) throw new Error(entry.error);
                        if (entry.context) { context = entry.context; completed = true; }
                        if (entry.event) for (const listener of subscribers) listener(entry.event);
                    }
                }
                if (buffer.trim() || !completed) throw new Error('Incomplete worker response');
            })();
            try { await pending; } finally { session.isStreaming = false; }
        },
        agent: {
            abort: () => { void request('/abort').catch(() => {}); },
            waitForIdle: async () => { await pending?.catch(() => {}); },
        },
        async dispose() {
            disposing = true;
            try { await request('/stop'); } finally { child?.kill(); if (child?.connected) child.disconnect(); }
        },
    };
    return { session };
}
