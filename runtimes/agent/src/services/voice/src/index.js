'use strict';

/**
 * Voice — speech-to-text + text-to-speech service (inferd pattern: nested
 * package, pure-DI constructor, zero env reads).
 *
 * Both sides speak the OpenAI audio API dialect, which every practical local
 * server implements:
 *   STT: POST {sttBaseUrl}/v1/audio/transcriptions (multipart)
 *        — speaches / faster-whisper-server / whisper.cpp server / OpenAI
 *   TTS: POST {ttsBaseUrl}/v1/audio/speech (json → audio bytes)
 *        — kokoro-fastapi / openedai-speech (piper) / OpenAI
 *
 * speak() takes the reply as the agent wrote it (markdown) and reads only
 * what makes sense aloud, see toSpeechText().
 */

function trimSlash(value = '') {
    return String(value || '').replace(/\/+$/, '');
}

function defined(values) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value != null && value !== ''));
}

function audioApiUrl(baseUrl, endpoint) {
    const base = trimSlash(baseUrl);
    return /\/v\d+$/.test(base) ? `${base}/audio/${endpoint}` : `${base}/v1/audio/${endpoint}`;
}

/**
 * Reduce markdown to the text a person would read aloud: code blocks, tables,
 * images and bare URLs are dropped, links keep their label, and list/heading/
 * emphasis markers are removed.
 * @param {string} markdown
 * @returns {string}
 */
export function toSpeechText(markdown) {
    return String(markdown ?? '')
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/^\s*\|.*\|\s*$/gm, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<?\bhttps?:\/\/[^\s>)]+>?/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/^\s{0,3}(#{1,6}|>+)\s*/gm, '')
        .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, '')
        .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
        .replace(/(\*\*|__|~~|\*|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9]))/g, '')
        .replace(/[ \t]*\n+[ \t]*/g, (breaks) => (breaks.includes('\n\n') ? '\n\n' : '\n'))
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

export class Voice {
    #stt;
    #tts;
    #logger;

    /**
     * @param {Object} options
     * @param {Object} [options.stt] - { baseUrl, apiKey?, model, language? }
     * @param {Object} [options.tts] - { baseUrl, apiKey?, model, voice, format? }
     * @param {Object} [options.logger]
     */
    constructor(options = {}) {
        this.#stt = options.stt?.baseUrl ? { model: 'whisper-1', ...defined(options.stt) } : null;
        this.#tts = options.tts?.baseUrl
            ? { model: 'kokoro', voice: 'af_heart', format: 'mp3', ...defined(options.tts) }
            : null;
        this.#logger = options.logger || console;
    }

    /**
     * This service with an agent's own settings laid over it. Each side takes
     * the agent's fields where set and these settings otherwise, so an agent
     * can name only a voice or a language and keep the shared speech server.
     * @param {Object} [overrides] - { stt?, tts? } in the constructor's shape
     * @returns {Voice}
     */
    for(overrides) {
        if (!overrides?.stt && !overrides?.tts) return this;
        return new Voice({
            stt: { ...this.#stt, ...defined(overrides.stt || {}) },
            tts: { ...this.#tts, ...defined(overrides.tts || {}) },
            logger: this.#logger,
        });
    }

    get sttEnabled() { return Boolean(this.#stt); }
    get ttsEnabled() { return Boolean(this.#tts); }

    /** Configured sides without endpoints or keys; null where not configured. */
    status() {
        return {
            stt: this.#stt ? { model: this.#stt.model, language: this.#stt.language || null } : null,
            tts: this.#tts ? { model: this.#tts.model, voice: this.#tts.voice } : null,
        };
    }

    /**
     * Transcribe an audio clip.
     * @param {Buffer} audio
     * @param {Object} [options]
     * @param {string} [options.mimeType]  - e.g. audio/webm
     * @param {string} [options.filename]
     * @param {string} [options.language]
     * @returns {Promise<{ text: string }>}
     */
    async transcribe(audio, options = {}) {
        if (!this.#stt) throw new Error('Speech-to-text is not configured');
        if (!audio?.length) throw new Error('audio is required');

        const mimeType = options.mimeType || 'audio/webm';
        const filename = options.filename
            || `audio.${(mimeType.split('/')[1] || 'webm').split(';')[0]}`;

        const form = new FormData();
        form.append('file', new Blob([audio], { type: mimeType }), filename);
        form.append('model', this.#stt.model);
        const language = options.language || this.#stt.language;
        if (language) form.append('language', language);

        const response = await fetch(audioApiUrl(this.#stt.baseUrl, 'transcriptions'), {
            method: 'POST',
            headers: this.#stt.apiKey ? { Authorization: `Bearer ${this.#stt.apiKey}` } : {},
            body: form,
            signal: AbortSignal.timeout(options.timeout || 60000),
        });

        if (!response.ok) {
            throw new Error(`STT failed: ${await this.#errorText(response)}`);
        }

        const payload = await response.json();
        const text = String(payload?.text ?? '').trim();
        this.#logger.debug?.(`voice: transcribed ${audio.length}b -> ${text.length} chars`);
        return { text };
    }

    /**
     * Synthesize speech for a text.
     * @param {string} text - plain text or markdown
     * @param {Object} [options]
     * @param {string} [options.voice]
     * @param {string} [options.format] - mp3 | wav | opus | flac (server-dependent)
     * @returns {Promise<{ audio: Buffer, mimeType: string, format: string, voice: string }>}
     */
    async speak(text, options = {}) {
        if (!this.#tts) throw new Error('Text-to-speech is not configured');
        const input = toSpeechText(text);
        if (!input) throw new Error('text is required');

        const voice = options.voice || this.#tts.voice;
        const format = options.format || this.#tts.format;

        const response = await fetch(audioApiUrl(this.#tts.baseUrl, 'speech'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.#tts.apiKey ? { Authorization: `Bearer ${this.#tts.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: this.#tts.model,
                input,
                voice,
                response_format: format,
            }),
            signal: AbortSignal.timeout(options.timeout || 60000),
        });

        if (!response.ok) {
            throw new Error(`TTS failed: ${await this.#errorText(response)}`);
        }

        const audio = Buffer.from(await response.arrayBuffer());
        this.#logger.debug?.(`voice: synthesized ${input.length} chars -> ${audio.length}b ${format}`);
        return {
            audio,
            mimeType: { mp3: 'audio/mpeg', opus: 'audio/ogg' }[format] || `audio/${format}`,
            format,
            voice,
        };
    }

    async #errorText(response) {
        const body = await response.text().catch(() => '');
        try {
            const payload = JSON.parse(body);
            const message = payload?.error?.message || payload?.message || payload?.detail;
            if (message) return `HTTP ${response.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`;
        } catch { /* non-json body */ }
        return `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
    }
}

export default Voice;
