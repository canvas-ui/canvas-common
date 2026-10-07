import { createLogger } from '../../../utils/log.js';

const logger = createLogger('websocket:context');

/**
 * Push-only WebSocket bridge for context events.
 *
 * Listens to **all** events emitted by ContextManager and forwards them to the
 * socket when the authenticated user has ACL/ownership access to the context.
 */
export default function registerContextWebSocket(fastify, socket) {
  const { contextManager } = fastify;
  if (!contextManager) {
    logger.debug('contextManager missing, skipping context WS setup');
    return;
  }

  const listeners = new Map();

  // Live state belongs to the context, so HTTP/CLI/extension reads inherit it
  // as well as web views. The owner controls it; authorized readers follow it.
  socket.on('context.filters.set', async (payload, ack) => {
    try {
      const { contextId, liveQuery } = payload || {};
      if (typeof contextId !== 'string' || !socket.user?.id
          || !socket.subscriptions?.has(`context:${contextId}`)) throw new Error('Subscribe to the context before controlling Live mode');
      const context = await contextManager.getContext(socket.user.id, contextId);
      if (!context) throw new Error('Context not found');
      const result = context.setLiveQuery(socket.user.id, liveQuery, socket.id);
      ack?.({ status: 'success', payload: { liveQuery: result } });
    } catch (error) {
      ack?.({ status: 'error', message: error.message });
      logger.debug(`Context filter preview rejected: ${error.message}`);
    }
  });

  const wildcardListener = async function (payload) {
    try {
      const eventName = this.event;
      const contextId = payload?.contextId || payload?.id;
      const userId = socket.user?.id;

      if (payload?.sourceSocketId === socket.id) return;

      if (!userId) {
        return;
      }

      if (contextId) {
        try {
          const identifier = payload?.ownerUserId ? `${payload.ownerUserId}/${contextId}` : contextId;
          const scopedSubscription = socket.subscriptions?.has(`context:${identifier}`);
          if (!scopedSubscription && !socket.subscriptions?.has(`context:${contextId}`)) return;
          const context = await contextManager.getContext(userId, scopedSubscription ? identifier : contextId);
          if (!context || (payload?.ownerUserId && context.userId !== payload.ownerUserId)) return;
        } catch (error) {
          logger.debug(`Context access check failed for ${userId}/${contextId}: ${error.message}`);
          return;
        }
      }

      socket.emit(eventName, payload);
      logger.debug(`Forwarded ${eventName} to ${userId}`);
    } catch (err) {
      logger.debug(`Error forwarding context event: ${err.message}`);
    }
  };

  contextManager.on('**', wildcardListener);
  listeners.set('contextWildcard', wildcardListener);

  logger.debug(`Context WebSocket bridge registered for socket ${socket.id}`);

  socket.on('disconnect', () => {
    listeners.forEach((listener) => contextManager.off('**', listener));
    listeners.clear();
    logger.debug(`Cleaned context WS listeners for socket ${socket.id}`);
  });
}
