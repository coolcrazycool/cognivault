# CogniVault Project Skills

Skills that apply to all work in this project — used by both interactive sessions and GSD agents.

## Fastify Plugin Pattern

When creating a new feature:

1. Create directory: `src/features/{name}/`
2. Create `routes.ts` with plugin export:
```typescript
import type { FastifyInstance } from 'fastify';

export async function {name}Routes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/{name}', { schema: getSchema }, async (request, reply) => {
    // handler
  });
}
```
3. Create `schemas.ts` with TypeBox schemas:
```typescript
import { Type, type Static } from '@sinclair/typebox';

export const GetResponseSchema = Type.Object({
  // fields
});

export type GetResponse = Static<typeof GetResponseSchema>;

export const getSchema = {
  response: { 200: GetResponseSchema },
};
```
4. Register in `src/app.ts`:
```typescript
await app.register(import('./features/{name}/routes.js'));
```
5. Create `__tests__/routes.test.ts` with `fastify.inject()` tests

## Error Response Format

All errors follow this structure:
```typescript
reply.status(statusCode).send({
  error: {
    code: 'ERROR_CODE',     // Machine-readable, UPPER_SNAKE_CASE
    message: 'Description',  // Human-readable
  },
});
```

Standard codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INTERNAL_ERROR`, `PATH_TRAVERSAL`

## Config Pattern

Add new env vars to `src/config.ts` Zod schema:
```typescript
export const configSchema = z.object({
  // existing...
  NEW_VAR: z.string().default('value'),
});
```

Access via `import { config } from './config.js'`. Never use `process.env` directly outside config.ts.

## Testing Pattern

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../app.js';
import type { FastifyInstance } from 'fastify';

describe('{feature} routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 200', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/{endpoint}',
      headers: { authorization: 'Bearer test-key' },
    });
    expect(response.statusCode).toBe(200);
  });
});
```

## Auth Middleware Pattern

Protected routes get auth automatically via the auth plugin registered at app level.
To skip auth for specific routes (health, readiness), use route-level config:

```typescript
fastify.get('/health', {
  config: { skipAuth: true },
  schema: healthSchema,
}, handler);
```

## Import Conventions

- Always use `.js` extension in imports (ESM + TypeScript)
- Use `type` keyword for type-only imports
- Prefer named exports, no default exports
- Group imports: node builtins > external packages > internal modules
