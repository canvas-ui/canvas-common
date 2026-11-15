'use strict';

import { discoverAgentModels, agentProviderBaseUrl } from '../../../core/agent/config/models.js';
import { validateViewContext } from '../../../core/agent/view-context.js';
import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/validate-user.js';
import { rejectAgentTokens } from '../../middleware/agent-acl.js';

/**
 * Agent routes handler
 * @param {FastifyInstance} fastify
 */
const agentArg = { ':agentIdentifier': { name: 'agent', description: 'Agent name or id, as returned by agent_list.' } };
const mcp = (name, description, extra = {}) => ({ mcp: { name, description, args: agentArg, ...extra } });

export default async function agentRoutes(fastify, _options) {

    // Agent tokens are data-plane only — an agent may not manage agents
    // (including itself).
    fastify.addHook('preHandler', rejectAgentTokens);

    fastify.post('/models', {
        onRequest: [fastify.authenticate],
        schema: { body: { type: 'object', required: ['provider'], additionalProperties: false, properties: {
            provider: { type: 'string', enum: ['anthropic', 'openai', 'ollama', 'lm-studio', 'vllm', 'custom'] },
            apiKey: { type: 'string' }, baseUrl: { type: 'string' }, agentIdentifier: { type: 'string' },
        } } },
    }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const options = { ...request.body };
            if (!options.apiKey && options.agentIdentifier) {
                const agent = await fastify.agents.open(request.user.id, options.agentIdentifier, request.user.id);
                if (!agent) return reply.code(404).send(new ResponseObject().notFound('Agent not found').getResponse());
                if (agent.llmProvider === options.provider && agentProviderBaseUrl(options.provider, options.baseUrl) === agentProviderBaseUrl(agent.llmProvider, agent.agentConfig.baseUrl)) {
                    options.apiKey = agent.agentConfig.apiKey;
                }
            }
            const models = await discoverAgentModels(options);
            return reply.send(new ResponseObject().success(models, 'Provider models loaded').getResponse());
        } catch (error) {
            return reply.code(400).send(new ResponseObject().badRequest(error.message).getResponse());
        }
    });

    const normalizePromptImages = (images) => {
        if (!Array.isArray(images)) return [];
        return images
            .filter((image) => image && typeof image.data === 'string' && typeof image.mimeType === 'string')
            .map((image) => ({
                type: 'image',
                data: image.data,
                mimeType: image.mimeType,
            }));
    };

    const normalizeStreamingBehavior = (value) => (
        value === 'steer' ? 'steer' : 'followUp'
    );

    const requireUser = (request, reply) => {
        if (!validateUser(request.user, ['id', 'email'])) {
            const r = new ResponseObject().unauthorized('Valid authentication required');
            reply.code(r.statusCode).send(r.getResponse());
            return false;
        }
        return true;
    };

    const handlePromptRequest = async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const viewContext = validateViewContext(request.body?.viewContext);
            if (request.params.sessionId) {
                const selected = await fastify.agents.selectSession(
                    request.user.id,
                    request.params.agentIdentifier,
                    { mode: 'persistent', sessionId: request.params.sessionId },
                    request.user.id
                );
                if (!selected) {
                    const r = new ResponseObject().notFound('Agent or session not found');
                    return reply.code(r.statusCode).send(r.getResponse());
                }
            }

            const agent = await fastify.agents.start(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }

            const { message, images, streamingBehavior } = request.body;
            const text = typeof message === 'string' ? message : '';
            const normalizedImages = normalizePromptImages(images);
            if (!text && normalizedImages.length === 0) {
                const r = new ResponseObject().badRequest('message or images are required');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const streamingBehaviorValue = normalizeStreamingBehavior(streamingBehavior);
            const wasProcessing = agent.isProcessing;
            const messages = await agent.prompt(text, {
                images: normalizedImages,
                viewContext,
                streamingBehavior: streamingBehaviorValue,
            });
            const r = new ResponseObject().success({
                messages,
                ...(wasProcessing ? { queued: true, streamingBehavior: streamingBehaviorValue } : {}),
            }, wasProcessing ? 'Prompt queued' : 'Prompt completed');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.startsWith('Session not found:')
                ? new ResponseObject().notFound(err.message)
                : new ResponseObject().error(err.message || 'Prompt failed', null, err.statusCode || 500);
            return reply.code(r.statusCode).send(r.getResponse());
        }
    };

    const handlePromptStreamRequest = async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const viewContext = validateViewContext(request.body?.viewContext);
            if (request.params.sessionId) {
                const selected = await fastify.agents.selectSession(
                    request.user.id,
                    request.params.agentIdentifier,
                    { mode: 'persistent', sessionId: request.params.sessionId },
                    request.user.id
                );
                if (!selected) {
                    const r = new ResponseObject().notFound('Agent or session not found');
                    return reply.code(r.statusCode).send(r.getResponse());
                }
            }

            const agent = await fastify.agents.start(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }

            const { message, images, streamingBehavior } = request.body;
            const text = typeof message === 'string' ? message : '';
            const normalizedImages = normalizePromptImages(images);
            if (!text && normalizedImages.length === 0) {
                const r = new ResponseObject().badRequest('message or images are required');
                return reply.code(r.statusCode).send(r.getResponse());
            }

            reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });

            const send = (payload) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
            send({ type: 'start' });

            const collectedMessages = [];

            const onEvent = (event) => {
                switch (event.type) {
                    case 'message_update': {
                        const ae = event.assistantMessageEvent;
                        if (ae?.type === 'text_delta')     send({ type: 'chunk', delta: ae.delta });
                        if (ae?.type === 'thinking_delta') send({ type: 'thinking', delta: ae.delta });
                        break;
                    }
                    case 'tool_execution_start':
                        send({ type: 'tool_start', toolName: event.toolName });
                        break;
                    case 'tool_execution_end':
                        send({ type: 'tool_end', toolName: event.toolName, isError: event.isError ?? false });
                        break;
                    case 'message_end':
                        if (event.message?.role === 'assistant') {
                            collectedMessages.push(event.message);
                            if (event.message.stopReason === 'error') send({ type: 'error', error: event.message.errorMessage || 'Prompt stream failed' });
                        }
                        break;
                    case 'agent_end':
                        send({ type: 'complete', messages: collectedMessages });
                        break;
                }
            };

            const cancelStream = () => { if (!reply.raw.writableEnded) agent.abort(); };
            reply.raw.once('close', cancelStream);
            try {
                await agent.stream(text, onEvent, {
                    images: normalizedImages,
                    viewContext,
                    ...(streamingBehavior ? { streamingBehavior: normalizeStreamingBehavior(streamingBehavior) } : {}),
                });
            } catch (streamErr) {
                send({ type: 'error', error: streamErr.message });
            } finally { reply.raw.off('close', cancelStream); }

            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.startsWith('Session not found:')
                ? new ResponseObject().notFound(err.message)
                : new ResponseObject().error(err.message || 'Failed to start stream', null, err.statusCode || 500);
            return reply.code(r.statusCode).send(r.getResponse());
        }
    };

    /**
     * List agents
     */
    fastify.get('/', { onRequest: [fastify.authenticate], config: { mcp: { name: 'agent_list', description: 'List the agents you own or can use, with their model and whether each is running.' } } }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agents = await fastify.agents.listByUser(request.user.id, request.query.host);
            const r = new ResponseObject().found(agents, 'Agents retrieved', 200, agents.length);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError('Failed to list agents');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Create agent
     */
    fastify.post('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const {
                name, label, description, color, llmProvider, model, apiKey, baseUrl,
                prompts, tools, mcp, metadata, connectors, parameters, identity, memory, skills, session,
                config = {},
            } = request.body;
            const mergedConfig = {
                ...config,
                ...(apiKey !== undefined ? { apiKey } : {}),
                ...(baseUrl !== undefined ? { baseUrl } : {}),
                ...(identity !== undefined ? { identity: { ...(config.identity || {}), ...identity } } : {}),
                ...(prompts !== undefined ? { prompts: { ...(config.prompts || {}), ...prompts } } : {}),
                ...(tools !== undefined ? { tools: { ...(config.tools || {}), ...tools } } : {}),
                ...(connectors !== undefined ? { connectors: { ...(config.connectors || {}), ...connectors } } : {}),
                ...(parameters !== undefined ? { parameters: { ...(config.parameters || {}), ...parameters } } : {}),
                ...(memory !== undefined ? { memory } : {}),
                ...(skills !== undefined ? { skills } : {}),
                ...(session !== undefined ? { session: { ...(config.session || {}), ...session } } : {}),
                ...(mcp !== undefined ? { mcp } : {}),
            };
            const agent = await fastify.agents.create(request.user.id, name, {
                owner: request.user.id, label, description, color, llmProvider, model, metadata, config: mergedConfig,
            });
            const r = new ResponseObject().created(agent, 'Agent created');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message.includes('already exists')
                ? new ResponseObject().conflict(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to create agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Get agent
     */
    fastify.get('/:agentIdentifier', { onRequest: [fastify.authenticate], config: mcp('agent_get', 'Read one agent: model, configuration, workspace binding and status.') }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.open(request.user.id, request.params.agentIdentifier, request.user.id);
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().found(agent.toJSON(), 'Agent retrieved');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError('Failed to get agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Get agent status
     */
    fastify.get('/:agentIdentifier/status', { onRequest: [fastify.authenticate], config: mcp('agent_status_get', 'Check whether an agent is running before prompting it.') }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.open(request.user.id, request.params.agentIdentifier, request.user.id);
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().found(
                { id: agent.id, name: agent.name, status: agent.status, isActive: agent.isActive, model: agent.model },
                'Status retrieved'
            );
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError('Failed to get agent status');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Get persisted/default session context
     */
    fastify.get('/:agentIdentifier/session', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.open(request.user.id, request.params.agentIdentifier, request.user.id);
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().found(agent.getSessionContext(), 'Session retrieved');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to get agent session');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.get('/:agentIdentifier/sessions', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const sessions = await fastify.agents.listSessions(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!sessions) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().found(sessions, 'Sessions retrieved', 200, Array.isArray(sessions) ? sessions.length : null, Array.isArray(sessions) ? sessions.length : null);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to list sessions');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.post('/:agentIdentifier/sessions', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.createSession(
                request.user.id,
                request.params.agentIdentifier,
                { mode: request.body?.mode, name: request.body?.name },
                request.user.id
            );
            if (!result) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().created(result, 'Session created');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to create session');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Prompt a specific persistent session (non-streaming).
     */
    fastify.post('/:agentIdentifier/sessions/:sessionId/prompt', { onRequest: [fastify.authenticate] }, handlePromptRequest);

    fastify.put('/:agentIdentifier/session', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.selectSession(
                request.user.id,
                request.params.agentIdentifier,
                { mode: request.body?.mode, sessionId: request.body?.sessionId },
                request.user.id
            );
            if (!result) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(result, 'Session selected');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to select session');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.patch('/:agentIdentifier/sessions/:sessionId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.renameSession(
                request.user.id,
                request.params.agentIdentifier,
                { sessionId: request.params.sessionId, name: request.body?.name },
                request.user.id
            );
            if (!result) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(result, 'Session renamed');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to rename session');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.delete('/:agentIdentifier/sessions/:sessionId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.deleteSession(
                request.user.id,
                request.params.agentIdentifier,
                { sessionId: request.params.sessionId },
                request.user.id
            );
            if (!result) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(result, 'Session deleted');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to delete session');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.get('/:agentIdentifier/skills', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const skills = await fastify.agents.listSkills(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!skills) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().found(skills, 'Skills retrieved', 200, skills.length);
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to list skills');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.post('/:agentIdentifier/skills', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const skills = await fastify.agents.installSkill(
                request.user.id, request.params.agentIdentifier, request.body || {}, request.user.id
            );
            if (!skills) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().created(skills, 'Skill installed');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.includes('required')
                ? new ResponseObject().badRequest(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to install skill');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.delete('/:agentIdentifier/skills/:skillName', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const skills = await fastify.agents.removeSkill(
                request.user.id, request.params.agentIdentifier, request.params.skillName, request.user.id
            );
            if (!skills) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(skills, 'Skill removed');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.startsWith('Skill not found:')
                || err.message?.startsWith('Skill package not found:')
                ? new ResponseObject().notFound(err.message)
                : err.message?.includes('required')
                    ? new ResponseObject().badRequest(err.message)
                    : new ResponseObject().serverError(err.message || 'Failed to remove skill');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Resolved tool definitions (runtime-injected; read-only view).
     */
    fastify.get('/:agentIdentifier/tools', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.getToolDefinitions(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            const r = new ResponseObject().found(result, 'Agent tool definitions retrieved');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.startsWith('Agent not found')
                ? new ResponseObject().notFound(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to get tool definitions');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Named access grants independently scope the agent to workspaces, paths,
     * contexts or global access. Each grant has its own canvas-agent-* token. The token value is returned exactly
     * once in API responses; the private runtime env holds the worker credentials.
     */
    fastify.get('/:agentIdentifier/access', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const access = await fastify.agents.getAccess(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            const r = new ResponseObject().found(access, access ? 'Agent access retrieved' : 'Agent is unbound');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.startsWith('Agent not found')
                ? new ResponseObject().notFound(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to get agent access');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    const grantSchema = {
        type: 'object', additionalProperties: false, required: ['binding', 'permissions'],
        properties: {
            id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
            label: { type: 'string', maxLength: 120 },
            binding: { type: 'object', additionalProperties: false, required: ['type'], properties: {
                type: { type: 'string', enum: ['workspace', 'path', 'context', 'global'] },
                workspace: { type: 'string' }, path: { type: 'string' }, context: { type: 'string' },
            } },
            permissions: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['read', 'write'] } },
        },
    };
    fastify.put('/:agentIdentifier/access', {
        onRequest: [fastify.authenticate],
        schema: { body: { type: 'object', additionalProperties: false, required: ['grants'], properties: {
            grants: { type: 'array', minItems: 1, maxItems: 32, items: { ...grantSchema, required: [...grantSchema.required, 'id'] } },
        } } },
    }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.setAccess(
                request.user.id, request.params.agentIdentifier, request.body, request.user.id
            );
            const r = new ResponseObject().created(result, 'Agent access bound — store the token now, it is not shown again');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.includes('not found') || err.message?.includes('Invalid')
                || err.message?.includes('required')
                ? new ResponseObject().badRequest(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to set agent access');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.put('/:agentIdentifier/access/grants/:grantId', {
        onRequest: [fastify.authenticate], schema: { body: grantSchema },
    }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.setAccessGrant(request.user.id, request.params.agentIdentifier, request.params.grantId, request.body, request.user.id);
            return reply.code(201).send(new ResponseObject().created(result, 'Connection saved; its token is shown once').getResponse());
        } catch (error) {
            return reply.code(400).send(new ResponseObject().badRequest(error.message).getResponse());
        }
    });
    fastify.delete('/:agentIdentifier/access/grants/:grantId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.revokeAccessGrant(request.user.id, request.params.agentIdentifier, request.params.grantId, request.user.id);
            return new ResponseObject().success(result, 'Connection revoked').getResponse();
        } catch (error) {
            return reply.code(400).send(new ResponseObject().badRequest(error.message).getResponse());
        }
    });

    fastify.post('/:agentIdentifier/access/grants/:grantId/token', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const result = await fastify.agents.rotateAgentToken(
                request.user.id, request.params.agentIdentifier, request.params.grantId, request.user.id
            );
            const r = new ResponseObject().created(result, 'Agent token rotated — store the token now, it is not shown again');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.includes('not found')
                ? new ResponseObject().badRequest(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to rotate agent token');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.delete('/:agentIdentifier/access', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const revoked = await fastify.agents.revokeAccess(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            const r = revoked
                ? new ResponseObject().success(null, 'Agent access revoked')
                : new ResponseObject().notFound('Agent has no access binding');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.startsWith('Agent not found')
                ? new ResponseObject().notFound(err.message)
                : new ResponseObject().serverError(err.message || 'Failed to revoke agent access');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Update agent config
     */
    fastify.put('/:agentIdentifier', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const {
                name, label, description, color, llmProvider, model, apiKey, baseUrl,
                prompts, tools, mcp, metadata, connectors, parameters, identity, memory, skills, session,
                config = {},
            } = request.body;
            const updateData = {};
            if (name        !== undefined) updateData.name        = name;
            if (label       !== undefined) updateData.label       = label;
            if (description !== undefined) updateData.description = description;
            if (color       !== undefined) updateData.color       = color;
            if (llmProvider !== undefined) updateData.llmProvider = llmProvider;
            if (model       !== undefined) updateData.model       = model;
            const mergedConfig = {
                ...config,
                ...(apiKey !== undefined ? { apiKey } : {}),
                ...(baseUrl !== undefined ? { baseUrl } : {}),
                ...(identity !== undefined ? { identity: { ...(config.identity || {}), ...identity } } : {}),
                ...(prompts !== undefined ? { prompts: { ...(config.prompts || {}), ...prompts } } : {}),
                ...(tools !== undefined ? { tools: { ...(config.tools || {}), ...tools } } : {}),
                ...(connectors !== undefined ? { connectors: { ...(config.connectors || {}), ...connectors } } : {}),
                ...(parameters !== undefined ? { parameters: { ...(config.parameters || {}), ...parameters } } : {}),
                ...(memory !== undefined ? { memory } : {}),
                ...(skills !== undefined ? { skills } : {}),
                ...(session !== undefined ? { session: { ...(config.session || {}), ...session } } : {}),
                ...(mcp !== undefined ? { mcp } : {}),
            };
            if (Object.keys(mergedConfig).length > 0) updateData.config = mergedConfig;
            if (metadata    !== undefined) updateData.metadata    = metadata;

            const agent = await fastify.agents.update(
                request.user.id, request.params.agentIdentifier, updateData, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(agent.toJSON(), 'Agent updated');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to update agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Delete agent
     */
    fastify.delete('/:agentIdentifier', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const success = await fastify.agents.delete(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!success) {
                const r = new ResponseObject().notFound('Agent not found or failed to delete');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success({ success: true }, 'Agent deleted');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to delete agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Start agent
     */
    fastify.post('/:agentIdentifier/start', { onRequest: [fastify.authenticate], config: mcp('agent_start', 'Start an agent. Prompting starts it on demand, so this is only needed to warm it up or after agent_stop.') }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.start(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found or failed to start');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(agent.toJSON(), 'Agent started');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to start agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Stop agent
     */
    fastify.post('/:agentIdentifier/stop', { onRequest: [fastify.authenticate], config: mcp('agent_stop', 'Stop a running agent and abort what it is doing. Its sessions are kept.') }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const success = await fastify.agents.stop(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!success) {
                const r = new ResponseObject().notFound('Agent not found or failed to stop');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success({ success: true }, 'Agent stopped');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to stop agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Restart agent
     */
    fastify.post('/:agentIdentifier/restart', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        try {
            const agent = await fastify.agents.restart(
                request.user.id, request.params.agentIdentifier, request.user.id
            );
            if (!agent) {
                const r = new ResponseObject().notFound('Agent not found or failed to restart');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const r = new ResponseObject().success(agent.toJSON(), 'Agent restarted');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = new ResponseObject().serverError(err.message || 'Failed to restart agent');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    /**
     * Voice for a conversation with this agent. A client records a clip,
     * transcribes it, sends the text as an ordinary (streaming) prompt and
     * has the reply spoken:
     *
     *   GET  /:agent/voice            - { stt, tts }, null where not configured
     *   POST /:agent/voice/transcribe - multipart audio file -> { text }
     *   POST /:agent/voice/speak      - { text, voice?, format? } -> audio bytes
     *
     * The routes belong to the agent so a remote agent runtime serves them
     * with its own speech models. An agent's `config.voice` ({ stt, tts })
     * is laid over the host's speech settings, field by field.
     */
    const openVoice = async (request, reply, side) => {
        if (!requireUser(request, reply)) return false;
        const agent = await fastify.agents.open(request.user.id, request.params.agentIdentifier, request.user.id);
        if (!agent) {
            const r = new ResponseObject().notFound('Agent not found');
            reply.code(r.statusCode).send(r.getResponse());
            return false;
        }
        const voice = fastify.voice.for(agent.agentConfig.voice);
        if (side && !voice[`${side}Enabled`]) {
            const r = new ResponseObject().error(
                side === 'stt' ? 'Speech-to-text is not configured' : 'Text-to-speech is not configured',
                null, 501,
            );
            reply.code(r.statusCode).send(r.getResponse());
            return false;
        }
        return voice;
    };

    const sendVoiceError = (reply, err, fallback) => {
        fastify.log.error(err);
        const r = /required/.test(err.message || '')
            ? new ResponseObject().badRequest(err.message)
            : new ResponseObject().error(err.message || fallback, null, 502);
        return reply.code(r.statusCode).send(r.getResponse());
    };

    fastify.get('/:agentIdentifier/voice', {
        onRequest: [fastify.authenticate],
        config: mcp('agent_voice_get', 'Report whether an agent can transcribe speech (stt) and speak replies (tts); a side that is null is not configured.'),
    }, async (request, reply) => {
        const voice = await openVoice(request, reply);
        if (!voice) return reply;
        const r = new ResponseObject().found(voice.status(), 'Voice status retrieved');
        return reply.code(r.statusCode).send(r.getResponse());
    });

    fastify.post('/:agentIdentifier/voice/transcribe', {
        onRequest: [fastify.authenticate],
        schema: { description: 'Transcribe a recorded audio clip (multipart field "file") to text. Send the text to the agent with the prompt route.' },
    }, async (request, reply) => {
        const voice = await openVoice(request, reply, 'stt');
        if (!voice) return reply;
        try {
            const file = request.isMultipart?.() ? await request.file() : null;
            if (!file) {
                const r = new ResponseObject().badRequest('Send the audio clip as multipart field "file"');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const result = await voice.transcribe(await file.toBuffer(), {
                mimeType: file.mimetype,
                filename: file.filename,
                language: request.query?.language,
            });
            const r = new ResponseObject().success(result, 'Audio transcribed');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            return sendVoiceError(reply, err, 'Transcription failed');
        }
    });

    fastify.post('/:agentIdentifier/voice/speak', {
        onRequest: [fastify.authenticate],
        schema: {
            description: 'Synthesize speech for a reply. Accepts the reply as written (markdown); returns audio bytes.',
            body: {
                type: 'object',
                required: ['text'],
                additionalProperties: false,
                properties: {
                    text: { type: 'string', minLength: 1, description: 'Text or markdown to read aloud' },
                    voice: { type: 'string', description: 'Voice id of the speech server; default is the configured voice' },
                    format: { type: 'string', enum: ['mp3', 'wav', 'opus', 'flac'] },
                },
            },
        },
    }, async (request, reply) => {
        const voice = await openVoice(request, reply, 'tts');
        if (!voice) return reply;
        try {
            const { audio, mimeType } = await voice.speak(request.body.text, {
                voice: request.body.voice,
                format: request.body.format,
            });
            return reply.code(200).header('Content-Type', mimeType).send(audio);
        } catch (err) {
            return sendVoiceError(reply, err, 'Speech synthesis failed');
        }
    });

    /**
     * Prompt (non-streaming): waits for completion, returns messages.
     */
    fastify.post('/:agentIdentifier', { onRequest: [fastify.authenticate] }, handlePromptRequest);
    fastify.post('/:agentIdentifier/prompt', {
        onRequest: [fastify.authenticate],
        config: mcp('agent_prompt', 'Send a message to an agent and wait for its complete reply. The agent keeps its conversation, so follow-up messages continue it.', { only: ['message'], required: ['message'] }),
        schema: { body: { type: 'object', properties: { message: { type: 'string', description: 'What to ask or tell the agent.' } } } },
    }, handlePromptRequest);

    /**
     * Prompt streaming (SSE)
     *
     * Event types forwarded to client:
     *   { type: 'chunk',        delta: string }          — assistant text delta
     *   { type: 'thinking',     delta: string }          — thinking delta
     *   { type: 'tool_start',   toolName: string }
     *   { type: 'tool_end',     toolName: string, isError: boolean }
     *   { type: 'complete',     messages: AgentMessage[] }
     *   { type: 'error',        error: string }
     */
    fastify.post('/:agentIdentifier/prompt/stream', { onRequest: [fastify.authenticate], config: { mcp: false } }, handlePromptStreamRequest);
    fastify.post('/:agentIdentifier/sessions/:sessionId/prompt/stream', { onRequest: [fastify.authenticate], config: { mcp: false } }, handlePromptStreamRequest);
}
