import http from 'node:http';

/** Deterministic OpenAI-compatible Ollama/STT/Kokoro stand-in for transport tests. */
export async function startModelService() {
    const calls = { completions: 0, transcriptions: 0, syntheses: 0 };
    const spoken = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (req.url === '/v1/models') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
        } else if (req.url === '/v1/chat/completions') {
            calls.completions++;
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1,
                model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
            res.write(chunk({ role: 'assistant', content: 'Local inference works.' }, null));
            res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
        } else if (req.url === '/v1/audio/transcriptions') {
            calls.transcriptions++;
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'Say hello' }));
        } else if (req.url === '/v1/audio/speech') {
            calls.syntheses++;
            spoken.push(JSON.parse(Buffer.concat(chunks).toString()).input);
            res.setHeader('content-type', 'audio/mpeg'); res.end(Buffer.from('test-audio'));
        } else res.writeHead(404).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, spoken,
        close: () => new Promise(resolve => server.close(resolve)) };
}
