'use strict';

import { documentQuerySchema } from '../document-query-schema.js';
import ResponseObject from '../ResponseObject.js';
import schemaRegistry from '@augmentd-labs/canvas-synapsd/src/schemas/SchemaRegistry.js';

/**
 * Schema routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function schemaRoutes(fastify, _options) {
  fastify.get('/query', { schema: { description: 'JSON Schema for the complete native document search request, including exact text, compound lines and bitmap predicates.' } }, async (_request, reply) => {
    return reply.send(new ResponseObject().found(documentQuerySchema, 'Document query schema').getResponse());
  });

  // List all data schemas
  fastify.get('/', {
  }, async (request, reply) => {
    try {
      const schemas = schemaRegistry.listSchemas('data');
      const response = new ResponseObject().found(schemas, 'Schemas retrieved successfully', 200, schemas.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list schemas');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Schema descriptor / JSON Schema for one id. A splat, not a named param:
  // schema ids are hierarchical (`data/schema/message/email` spans two
  // segments, which `:param` cannot match). `<id>.json` serves the derived
  // JSON Schema; the bare id serves the registration descriptor — the old
  // handler returned the CLASS, which JSON-serializes to `{}`.
  fastify.get('/data/schema/*', {
    schema: {
      description: 'Get document type fields, required/optional lists, JSON Schema, examples and normalization notes from Synapsd. The wildcard is the schema suffix (e.g. link, task, message/email). Append .json for JSON Schema only.',
      params: {
        type: 'object',
        required: ['*'],
        properties: {
          '*': { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const splat = request.params['*'] || '';
      const wantsJson = splat.endsWith('.json');
      const tail = wantsJson ? splat.slice(0, -'.json'.length) : splat;
      // Closed-enum children (application/flatpak) are registered. An unknown
      // extra segment still resolves to its nearest ancestor rather than 404.
      const requestedId = `data/schema/${tail}`;
      const schemaId = schemaRegistry.hasSchema(requestedId)
        ? requestedId
        : schemaRegistry.resolveSchemaId(requestedId);

      if (!schemaId) {
        const response = new ResponseObject().notFound(`Schema not found: ${requestedId}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const payload = wantsJson
        ? schemaRegistry.getJsonSchema(schemaId)
        : schemaRegistry.getSchemaDescriptor(schemaId);
      if (!wantsJson && payload) payload.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const message = wantsJson ? 'JSON schema retrieved successfully' : 'Schema retrieved successfully';
      const response = new ResponseObject().found(payload, message);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to get schema');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
