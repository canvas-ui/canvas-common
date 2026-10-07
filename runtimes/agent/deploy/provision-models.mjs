// Run explicitly after starting the optional Compose model services.
const ollama = (process.env.OLLAMA_URL || 'http://ollama:11434/v1').replace(/\/v1\/?$/, '').replace(/\/$/, '');
const speech = (process.env.STT_URL || 'http://speaches:8000').replace(/\/v1\/?$/, '').replace(/\/$/, '');
const model = process.env.OLLAMA_MODEL || 'qwen3:latest';
const sttModel = process.env.STT_MODEL || 'Systran/faster-whisper-small';

async function ready(url) {
    for (let attempt = 0; attempt < 60; attempt++) {
        if (await fetch(url, { signal: AbortSignal.timeout(5000) }).then(r => r.ok).catch(() => false)) return;
        if (attempt % 6 === 0) console.log(`Waiting for ${url}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error(`Service did not become ready: ${url}`);
}

async function download(url, body) {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30 * 60_000),
        headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Model download failed (${response.status}): ${await response.text()}`);
    await response.arrayBuffer();
}

await ready(`${ollama}/api/tags`);
console.log(`Downloading Ollama model ${model}`);
await download(`${ollama}/api/pull`, { model, stream: false });
await ready(`${speech}/v1/models`);
console.log(`Downloading speech recognition model ${sttModel}`);
await download(`${speech}/v1/models/${sttModel.split('/').map(encodeURIComponent).join('/')}`);
console.log('Models are ready. Kokoro supplies speech synthesis in its service image.');
