import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const indexedFiles = sqliteTable(
  'indexed_files',
  {
    path: text('path').primaryKey(),
    contentHash: text('content_hash').notNull(),
    mtime: integer('mtime').notNull(),
    size: integer('size').notNull(),
    indexedAt: text('indexed_at').notNull(),
    embeddingModelVersion: text('embedding_model_version'),
  },
  (table) => [index('content_hash_idx').on(table.contentHash)],
);

export type IndexedFile = typeof indexedFiles.$inferSelect;
export type NewIndexedFile = typeof indexedFiles.$inferInsert;
