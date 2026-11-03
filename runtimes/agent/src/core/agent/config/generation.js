/** Apply the agent's generation settings without mutating the shared model catalogue. */
export function configureGeneration(session, config, provider) {
    const settings = config.connectors?.[provider] || {};
    const options = {};
    if (settings.maxTokens !== undefined) {
        if (!Number.isSafeInteger(settings.maxTokens) || settings.maxTokens < 1) throw new Error('Max output tokens must be a positive integer');
        options.maxTokens = settings.maxTokens;
    }
    if (provider !== 'anthropic' && settings.temperature !== undefined) {
        if (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2) throw new Error('Temperature must be between 0 and 2');
        options.temperature = settings.temperature;
    }
    const stream = session.agent.streamFn;
    session.agent.streamFn = (model, context, streamOptions) => {
        const requestOptions = { ...streamOptions, ...options };
        // Anthropic uses provider-default sampling, including models that reject temperature.
        if (provider === 'anthropic') delete requestOptions.temperature;
        return stream(model, context, requestOptions);
    };
}
