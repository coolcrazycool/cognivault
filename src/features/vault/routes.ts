import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VaultManager } from '../../lib/vault.js';
import { PathTraversalError, VaultError } from '../../lib/vault.js';
import type {
  AppendContentBody,
  ContentQuery,
  CreateNoteBody,
  DeleteNoteBody,
  ListFilesQuery,
  MetadataQuery,
  MoveNoteBody,
  UpdateContentBody,
  UpdateMetadataBody,
} from './schemas.js';
import {
  appendContentSchema,
  contentSchema,
  createNoteSchema,
  deleteNoteSchema,
  listFilesSchema,
  metadataSchema,
  moveNoteSchema,
  updateContentSchema,
  updateMetadataSchema,
  uploadSchema,
} from './schemas.js';

function handleVaultError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof VaultError) {
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message },
    });
  }
  throw err;
}

function getUserVault(fastify: FastifyInstance, request: FastifyRequest): VaultManager {
  // v2.0 multi-tenant: get per-user vault from indexer
  const userId = request.user?.userId;
  if (userId) {
    const entry = fastify.indexers.get(userId);
    if (entry) {
      return entry.vault;
    }
  }
  // v1.0 fallback: global vault
  if (fastify.vault) {
    return fastify.vault;
  }
  throw new VaultError('No vault available for this user', 'VAULT_NOT_FOUND', 404);
}

export async function vaultRoutes(fastify: FastifyInstance): Promise<void> {
  // Upload a zip archive of files into the caller's vault. Files land in the
  // watched vault directory and are indexed by the poller within one cycle.
  // Lets users without cluster/storage access get their notes in over HTTP.
  fastify.post('/upload', { schema: uploadSchema }, async (request, reply) => {
    // Resolve the caller's vault first (404 if they have no active vault).
    let vault: VaultManager;
    try {
      vault = getUserVault(fastify, request);
    } catch (err: unknown) {
      return handleVaultError(err, reply);
    }

    // Read the single multipart file field.
    let file: Awaited<ReturnType<FastifyRequest['file']>>;
    try {
      file = await request.file();
    } catch {
      return reply.status(400).send({
        error: {
          code: 'INVALID_UPLOAD',
          message: 'Expected multipart/form-data with a file field',
        },
      });
    }
    if (!file) {
      return reply.status(400).send({
        error: { code: 'NO_FILE', message: 'No file was provided in the request' },
      });
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return reply.status(413).send({
        error: { code: 'FILE_TOO_LARGE', message: 'Uploaded archive exceeds the size limit' },
      });
    }

    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      return reply.status(400).send({
        error: { code: 'INVALID_ARCHIVE', message: 'File is not a valid zip archive' },
      });
    }

    const written: string[] = [];
    let skipped = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      let resolved: string;
      try {
        // Reuses the vault's zip-slip / dotfile guard.
        resolved = await vault.resolveWritePath(entry.entryName);
      } catch (err: unknown) {
        if (err instanceof PathTraversalError) {
          return reply.status(403).send({
            error: {
              code: 'PATH_TRAVERSAL',
              message: `Unsafe path in archive: ${entry.entryName}`,
            },
          });
        }
        // Dotfiles/dotfolders (e.g. .obsidian) — silently skip.
        skipped++;
        continue;
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, entry.getData());
      written.push(entry.entryName);
    }

    return reply.status(200).send({ uploaded: written.length, skipped, files: written });
  });

  fastify.get<{ Querystring: ListFilesQuery }>(
    '/files',
    { schema: listFilesSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const { path, recursive, ext } = request.query;
        const result = await vault.listFiles({ path, recursive, ext });
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.get<{ Querystring: ContentQuery }>(
    '/content',
    { schema: contentSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const result = await vault.readContent(request.query.path);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.get<{ Querystring: MetadataQuery }>(
    '/metadata',
    { schema: metadataSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const result = await vault.readMetadata(request.query.path);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.post<{ Body: CreateNoteBody }>(
    '/content',
    { schema: createNoteSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const { path, content, frontmatter } = request.body;
        const result = await vault.createNote(path, content, frontmatter);
        reply.status(201);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.put<{ Body: UpdateContentBody }>(
    '/content',
    { schema: updateContentSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const { path, content } = request.body;
        const result = await vault.updateContent(path, content);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.patch<{ Body: AppendContentBody }>(
    '/content',
    { schema: appendContentSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const { path, content, mode } = request.body;
        const result = await vault.appendContent(path, content, mode);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.delete<{ Body: DeleteNoteBody }>(
    '/content',
    { schema: deleteNoteSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const { path } = request.body;
        const result = await vault.deleteNote(path);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.post<{ Body: MoveNoteBody }>(
    '/move',
    { schema: moveNoteSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const { from, to } = request.body;
        const result = await vault.moveNote(from, to);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.patch<{ Body: UpdateMetadataBody }>(
    '/metadata',
    { schema: updateMetadataSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const { path, metadata } = request.body;
        const result = await vault.updateMetadata(path, metadata);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );
}
