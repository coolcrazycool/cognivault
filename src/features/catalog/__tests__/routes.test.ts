import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { Registry as PromRegistry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as schema from '../../../db/schema.js';

// Config is parsed at import time — pin the values the route reads instead of inheriting
// whatever .env happens to hold. This is the OpenAI install: the one with zero annotations
// by construction, which is exactly the case the route has to report unambiguously.
process.env.VAULT_PATH = '/tmp/test-vault';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.EMBEDDING_PROVIDER = 'openai';
process.env.INDEX_DOC_SUMMARY = 'true';

type UserDb = BetterSQLite3Database<typeof schema>;

const KEY_A = 'cv-test-catalog-a';
const KEY_B = 'cv-test-catalog-b';
const KEY_BARE = 'cv-test-catalog-bare';
const KEY_EMPTY = 'cv-test-catalog-empty';

/** API key → user id. Four tenants, four states of the two tables. */
const USERS: Record<string, string> = {
  [KEY_A]: 'user-a',
  [KEY_B]: 'user-b',
  [KEY_BARE]: 'user-bare',
  [KEY_EMPTY]: 'user-empty',
};

const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-routes-')));
const dbs = new Map<string, UserDb>();
const closers: Array<() => void> = [];

const { createDatabase } = await import('../../../db/client.js');
const { docSummaries, indexedFiles } = await import('../../../db/schema.js');

for (const userId of Object.values(USERS)) {
  const { db, sqlite } = createDatabase(path.join(tmpDir, `${userId}.db`));
  dbs.set(userId, db);
  closers.push(() => sqlite.close());
}

function indexDoc(userId: string, filePath: string, summary?: string): void {
  const db = dbs.get(userId) as UserDb;
  db.insert(indexedFiles)
    .values({
      path: filePath,
      contentHash: `hash-${filePath}`,
      mtime: 1,
      size: 1234,
      indexedAt: '2026-08-01T00:00:00.000Z',
      fileType: 'md',
    })
    .run();
  if (summary !== undefined) {
    db.insert(docSummaries)
      .values({ path: filePath, contentHash: `hash-${filePath}`, summary })
      .run();
  }
}

// user-a    — an annotated corpus, with one container page that has no annotation.
// user-b    — a different corpus, for tenant isolation.
// user-bare — documents indexed, doc_summaries empty: the OpenAI install.
// user-empty— nothing indexed at all.
indexDoc('user-a', 'Продукты/Fincert.md', 'Документ описывает продукт Fincert.');
indexDoc('user-a', 'Продукты.md');
indexDoc('user-b', 'tenant-b/secret.md', 'Аннотация чужого документа.');
indexDoc('user-bare', 'a.md');
indexDoc('user-bare', 'b.md');

/**
 * A minimal app around the real route: real auth, real TypeBox serialization, real
 * per-user databases. The indexer is deliberately absent — its poller would emit deletion
 * events for the fixture paths (they exist in SQLite, not on disk) and take the annotation
 * rows down with them.
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');
  const { default: fp } = await import('fastify-plugin');

  const app = Fastify({ logger: false });

  await app.register(
    fp(
      async (f) => {
        f.decorate('metrics', {
          promRegistry: new PromRegistry(),
        } as unknown as FastifyInstance['metrics']);
      },
      { name: 'metrics' },
    ),
  );

  await app.register(
    fp(
      async (f) => {
        f.decorate('registry', {
          getUserByApiKey: (key: string) => {
            const userId = USERS[key];
            return userId
              ? { userId, apiKey: key, vaultPath: `/tmp/vault-${userId}`, openaiKey: 'k' }
              : undefined;
          },
        } as unknown as FastifyInstance['registry']);
      },
      { name: 'registry' },
    ),
  );

  const { default: errorHandler } = await import('../../../plugins/error-handler.js');
  await app.register(errorHandler);
  const { default: authPlugin } = await import('../../../plugins/auth.js');
  await app.register(authPlugin);
  // Registered before the feature routes, exactly as buildApp does — that ordering is
  // what puts the route in the OpenAPI document at all.
  const { default: swaggerPlugin } = await import('../../../plugins/swagger.js');
  await app.register(swaggerPlugin);

  app.addHook('onRequest', async (request) => {
    if (request.user) {
      const db = dbs.get(request.user.userId);
      request.getUserDb = () => db as ReturnType<typeof request.getUserDb>;
    }
  });

  const { catalogRoutes } = await import('../routes.js');
  await app.register(catalogRoutes, { prefix: '/api/vault' });

  await app.ready();
  return app;
}

describe('GET /api/vault/catalog', () => {
  let app: FastifyInstance;

  function get(key: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/vault/catalog${query}`,
      headers: { authorization: `Bearer ${key}` },
    });
  }

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    for (const close of closers) close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('serves the annotations that until now only the indexer could read', async () => {
    const response = await get(KEY_A);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.total).toBe(2);
    expect(body.documents_with_summary).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.documents).toEqual([
      // Indexed but never annotated: a container page that produced no chunks. Listed,
      // because dropping it would make the catalogue deny that the page exists.
      { path: 'Продукты.md', title: 'Продукты', summary: null, size: 1234 },
      {
        path: 'Продукты/Fincert.md',
        title: 'Fincert',
        summary: 'Документ описывает продукт Fincert.',
        size: 1234,
      },
    ]);
  });

  it('an empty doc_summaries table is NOT reported as an empty corpus', async () => {
    // The failure this route exists to prevent: `documents: []` alone reads as "the base
    // is empty", and on an OpenAI install that statement is false — the corpus is fully
    // indexed and merely has no annotations.
    const response = await get(KEY_BARE);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('summaries_disabled');
    expect(body.status).not.toBe('empty_vault');
    expect(body.summaries_enabled).toBe(false);
    expect(body.reason).toContain('EMBEDDING_PROVIDER=gigachat');
    // The corpus is there — that is the whole point of reporting the counters separately.
    expect(body.total).toBe(2);
    expect(body.documents_with_summary).toBe(0);
    expect(body.documents.map((d: { summary: string | null }) => d.summary)).toEqual([null, null]);
  });

  it('reports empty_vault only when nothing is indexed', async () => {
    const body = (await get(KEY_EMPTY)).json();

    expect(body.status).toBe('empty_vault');
    expect(body.total).toBe(0);
    expect(body.documents).toEqual([]);
  });

  it('scopes the catalogue to the calling tenant', async () => {
    const a = (await get(KEY_A)).json();
    const b = (await get(KEY_B)).json();

    expect(a.documents.map((d: { path: string }) => d.path)).not.toContain('tenant-b/secret.md');
    expect(b.documents.map((d: { path: string }) => d.path)).toEqual(['tenant-b/secret.md']);
    expect(JSON.stringify(a)).not.toContain('чужого');
  });

  it('honours limit and offset and still reports the full total', async () => {
    const response = await get(KEY_A, '?limit=1&offset=1');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].path).toBe('Продукты/Fincert.md');
    expect(body.offset).toBe(1);
    expect(body.total).toBe(2);
  });

  it('rejects a limit outside the declared bounds', async () => {
    expect((await get(KEY_A, '?limit=0')).statusCode).toBe(400);
    expect((await get(KEY_A, '?limit=99999')).statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/vault/catalog' });
    expect(response.statusCode).toBe(401);
  });

  it('appears in the OpenAPI document, with the emptiness contract in the description', async () => {
    const spec = app.swagger() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const operation = spec.paths['/api/vault/catalog']?.get;

    expect(operation).toBeDefined();
    expect(Object.keys(operation?.responses ?? {})).toContain('200');
    // The four causes of an empty catalogue are documented where a client author reads,
    // not only in a comment in this repository.
    const rendered = JSON.stringify(spec.paths['/api/vault/catalog']);
    for (const status of ['ok', 'empty_vault', 'summaries_disabled', 'summaries_pending']) {
      expect(rendered).toContain(status);
    }
  });
});
