import pino from 'pino';

// Importing the agent library never creates server directories or patches console.
const logger = pino({ name: 'canvas-agent', level: process.env.LOG_LEVEL || 'warn',
    redact: ['token', 'apiKey', 'authorization', 'headers.authorization'] });
export const createLogger = name => logger.child({ module: name });
