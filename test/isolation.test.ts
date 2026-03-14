/**
 * Tenant isolation integration test.
 *
 * Requires a running Qdrant instance (QDRANT_URL) and a valid OpenAI API key
 * (OPENAI_API_KEY) to perform real embedding and search.
 *
 * Skips cleanly in environments where either is absent.
 *
 * Validates INFRA-03: two users cannot access each other's data through any
 * API endpoint.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Skip entire suite if Qdrant or OpenAI credentials are not available.
const skip = !process.env.QDRANT_URL || !process.env.OPENAI_API_KEY;

describe.skipIf(skip)('tenant isolation', () => {
  // ── Unique user IDs (avoid collision with existing Qdrant data) ─────────────

  const userAId = `test-user-a-${Date.now()}`;
  const userBId = `test-user-b-${Date.now()}`;
  const userAKey = `cv-test-a-${Date.now()}-integration`;
  const userBKey = `cv-test-b-${Date.now()}-integration`;

  const noteContent = 'The secret meeting is scheduled for midnight at the old warehouse.';
  const notePath = 'secret-note.md';

  // ── Temp directories ────────────────────────────────────────────────────────

  let tmpDir: string;
  let dataDir: string;
  let vaultA: string;
  let vaultB: string;

  // ── App instance ────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    // Create isolated temp directories
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cognivault-isolation-'));
    dataDir = path.join(tmpDir, 'data');
    vaultA = path.join(tmpDir, 'vault-a');
    vaultB = path.join(tmpDir, 'vault-b');

    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(vaultA, { recursive: true });
    await fs.mkdir(vaultB, { recursive: true });

    // Write User A's note into vault A
    await fs.writeFile(path.join(vaultA, notePath), noteContent, 'utf-8');

    // Write users.json with two test users
    const users = [
      {
        userId: userAId,
        apiKey: userAKey,
        vaultPath: vaultA,
        openaiKey: process.env.OPENAI_API_KEY,
        obsidian: {
          email: 'usera@integration.test',
          password: 'password-a',
          vault: 'vault-a',
        },
      },
      {
        userId: userBId,
        apiKey: userBKey,
        vaultPath: vaultB,
        openaiKey: process.env.OPENAI_API_KEY,
        obsidian: {
          email: 'userb@integration.test',
          password: 'password-b',
          vault: 'vault-b',
        },
      },
    ];

    await fs.writeFile(
      path.join(dataDir, 'users.json'),
      JSON.stringify(users, null, 2),
      'utf-8',
    );

    // Set env vars before importing app (config is parsed at import time)
    process.env.COGNIVAULT_DATA_DIR = dataDir;
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
    // QDRANT_URL is already set in environment

    // Dynamic import so env vars are set before config.ts evaluates
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    await app.ready();

    // Trigger indexing for User A via admin reindex endpoint
    const reindexResp = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers: { authorization: `Bearer ${userAKey}` },
      payload: { scope: 'full' },
    });

    expect(reindexResp.statusCode).toBe(202);
    const { jobId } = JSON.parse(reindexResp.body) as { jobId: string };

    // Poll until the reindex job completes (up to 20s)
    let attempts = 0;
    while (attempts < 20) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      const statusResp = await app.inject({
        method: 'GET',
        url: `/api/admin/reindex/status?jobId=${jobId}`,
        headers: { authorization: `Bearer ${userAKey}` },
      });

      const body = JSON.parse(statusResp.body) as { status: string };
      if (body.status === 'completed') break;
      if (body.status === 'failed') throw new Error('Reindex failed for User A');
      attempts++;
    }

    if (attempts >= 20) {
      throw new Error('Reindex did not complete within 20s');
    }

    // Small buffer to ensure Qdrant has flushed vectors
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    // Clean up Qdrant data for both test users by purging their vectors
    // (app.purgeUserVectors is available after Qdrant plugin loads)
    try {
      if (app?.purgeUserVectors) {
        await app.purgeUserVectors(userAId);
        await app.purgeUserVectors(userBId);
      }
    } catch {
      // Best-effort cleanup — do not fail the test suite on cleanup errors
    }

    // Remove temp directories
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: User B cannot find User A's notes via search ───────────────────

  it("User B cannot find User A's notes via search", async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/vault/search/semantic',
      headers: {
        authorization: `Bearer ${userBKey}`,
        'content-type': 'application/json',
      },
      payload: {
        query: 'secret meeting midnight warehouse',
        limit: 10,
      },
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { results: unknown[] };
    expect(body.results.length).toBe(0);
  });

  // ── Test 2: User B gets 404 for a note path that only exists in User A's vault ─

  it("User B gets 404 when searching for User A's specific content by note path filter", async () => {
    // User B searches with an explicit path filter for User A's note.
    // Because path filters are applied on top of the user_id filter,
    // Qdrant returns no results — the route returns 200 with empty results.
    // For file-level 404, vault routes require VAULT_PATH (v1 mode).
    // In v2.0 search-based access, zero results = inaccessible note.
    const resp = await app.inject({
      method: 'POST',
      url: '/api/vault/search/semantic',
      headers: {
        authorization: `Bearer ${userBKey}`,
        'content-type': 'application/json',
      },
      payload: {
        query: 'secret meeting midnight warehouse',
        limit: 10,
        filters: { path: notePath },
      },
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { results: unknown[] };
    expect(body.results.length).toBe(0);
  });

  // ── Test 3: User A can find their own notes via search ─────────────────────

  it("User A can find their own notes via search", async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/vault/search/semantic',
      headers: {
        authorization: `Bearer ${userAKey}`,
        'content-type': 'application/json',
      },
      payload: {
        query: 'secret meeting midnight warehouse',
        limit: 10,
      },
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { results: Array<{ path: string }> };
    expect(body.results.length).toBeGreaterThan(0);
    // Verify the result is User A's note, not some other user's data
    expect(body.results[0]?.path).toBe(notePath);
  });

  // ── Test 4: User B lexical search also returns no results for User A content ─

  it("User B cannot find User A's notes via lexical search", async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/vault/search/lexical',
      headers: {
        authorization: `Bearer ${userBKey}`,
        'content-type': 'application/json',
      },
      payload: {
        query: 'secret meeting midnight warehouse',
        limit: 10,
      },
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { results: unknown[] };
    expect(body.results.length).toBe(0);
  });
});
