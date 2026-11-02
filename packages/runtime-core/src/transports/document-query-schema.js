import { querySpecSchema, candidateSpecSchema } from 'canvas-synapsd/src/query/schema.js';

export const documentQuerySchema = {
  ...querySpecSchema,
  not: { required: ['query', 'lines'] },
  dependencies: { op: ['lines'] },
  properties: {
    ...querySpecSchema.properties,
    applyCanvasQuerySpec: { type: 'boolean', description: 'Apply saved canvas filters (default true) when selecting a canvas path.' },
    lines: {
      type: 'array', minItems: 1, maxItems: 16,
      description: 'Independent candidate specs and optional text refinement chains. Each line ANDs with the shared spec; op combines the resulting sets.',
      items: {
        ...candidateSpecSchema,
        properties: {
          ...candidateSpecSchema.properties,
          queries: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1 }, description: 'Text queries narrow sequentially; the last ranks survivors.' },
        },
      },
    },
    op: { type: 'string', enum: ['or', 'and'], description: 'Combine compound lines by union (default) or intersection.' },
  },
};
