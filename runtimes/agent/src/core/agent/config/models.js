import { getModels } from '@earendil-works/pi-ai';

const BASE_URLS = {
    anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1',
    ollama: 'http://localhost:11434/v1', 'lm-studio': 'http://localhost:1234/v1', vllm: 'http://localhost:8000/v1',
};
export function agentProviderBaseUrl(provider, baseUrl) {
    return String(baseUrl || BASE_URLS[provider] || '').replace(/\/+$/, '');
}

const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Account-visible models, enriched with limits from the runtime's model catalogue. */
export async function discoverAgentModels({ provider, apiKey, baseUrl }, { fetchImpl = fetch } = {}) {
    if (!['anthropic', 'openai', 'ollama', 'lm-studio', 'vllm', 'custom'].includes(provider)) throw new Error('Unsupported provider');
    const base = agentProviderBaseUrl(provider, baseUrl);
    if (!base) throw new Error('A provider base URL is required');
    const parsed = new URL(base);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid provider base URL');
    if (['anthropic', 'openai'].includes(provider) && !apiKey) throw new Error('Enter an API key to load models');
    const headers = { Accept: 'application/json' };
    if (provider === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
    } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const endpoint = `${base}${['anthropic', 'openai'].includes(provider) && !/\/v\d+$/.test(base) ? '/v1' : ''}/models`;
    const catalogue = new Map(getModels(provider).map(model => [model.id, model]));
    const rows = new Map();
    let cursor;
    const seen = new Set();
    do {
        const url = new URL(endpoint);
        if (cursor) url.searchParams.set('after_id', cursor);
        const response = await fetchImpl(url.href, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403
            ? 'Provider rejected the API key or its permissions' : `Unable to load models (HTTP ${response.status})`);
        const payload = await response.json();
        if (!Array.isArray(payload.data)) throw new Error('Provider returned an invalid model list');
        for (const row of payload.data) {
            if (typeof row.id !== 'string' || row.lifecycle === 'retired') continue;
            const known = catalogue.get(row.id);
            rows.set(row.id, {
                id: row.id, name: row.display_name || known?.name || row.id,
                contextWindow: positive(row.max_input_tokens) || positive(row.context_length) || positive(known?.contextWindow),
                maxTokens: positive(row.max_tokens) || positive(row.max_output_tokens) || positive(known?.maxTokens),
                limitsSource: positive(row.max_tokens) || positive(row.max_input_tokens) || positive(row.context_length) || positive(row.max_output_tokens)
                    ? 'provider' : known ? 'runtime' : null,
            });
        }
        cursor = payload.has_more ? payload.last_id : null;
        if (payload.has_more && (!cursor || seen.has(cursor))) throw new Error('Provider returned invalid model pagination');
        seen.add(cursor);
    } while (cursor);
    return [...rows.values()];
}

// These are the SDK's custom-model defaults, used only when a provider does
// not report limits. They are runtime budgets, not claimed provider limits.
const CUSTOM_MODEL_DEFAULTS = { contextWindow: 128000, maxTokens: 16384 };
const PROVIDER_APIS = {
    anthropic: 'anthropic-messages', openai: 'openai-responses',
    ollama: 'openai-completions', 'lm-studio': 'openai-completions', vllm: 'openai-completions', custom: 'openai-completions',
};

/** Make a live, account-visible model usable by sessions and session restoration. */
export async function resolveAgentModel(registry, { provider, modelId, baseUrl, apiKey, parameters = {} }, dependencies = {}) {
    const registered = registry.find(provider, modelId);
    if (registered) return registered;
    const api = PROVIDER_APIS[provider];
    if (!api) throw new Error(`Unsupported model provider: ${provider}`);
    const credential = apiKey || await registry.getApiKeyForProvider(provider);
    const models = await discoverAgentModels({ provider, baseUrl, apiKey: credential }, dependencies);
    const discovered = models.find(model => model.id === modelId);
    if (!discovered) throw new Error(`Model "${modelId}" is not available from ${provider}`);
    const definition = {
        id: discovered.id, name: discovered.name, api,
        baseUrl: agentProviderBaseUrl(provider, baseUrl),
        // The catalogue or a user model definition can enable provider-specific
        // reasoning. Discovery alone does not establish its wire protocol.
        reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: discovered.contextWindow || positive(parameters.numCtx) || CUSTOM_MODEL_DEFAULTS.contextWindow,
        maxTokens: discovered.maxTokens || positive(parameters.maxTokens) || CUSTOM_MODEL_DEFAULTS.maxTokens,
    };
    registry.registerProvider(provider, {
        api, baseUrl: definition.baseUrl, apiKey: credential || provider,
        // registerProvider replaces this provider's list; retain existing model
        // definitions so session restoration can still resolve them.
        models: [...registry.getAll().filter(model => model.provider === provider), definition],
    });
    return registry.find(provider, modelId);
}
