import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const indexedFiles = sqliteTable(
  'indexed_files',
  {
    path: text('path').primaryKey(),
    contentHash: text('content_hash').notNull(),
    mtime: integer('mtime').notNull(),
    size: integer('size').notNull(),
    indexedAt: text('indexed_at').notNull(),
    embeddingModelVersion: text('embedding_model_version'),
    fileType: text('file_type'),
    linkedNotes: text('linked_notes'),
  },
  (table) => [index('content_hash_idx').on(table.contentHash)],
);

export type IndexedFile = typeof indexedFiles.$inferSelect;
export type NewIndexedFile = typeof indexedFiles.$inferInsert;

/**
 * Whole sections ("parent documents") a note was cut into, keyed by the chunk payload's
 * `parent_id`. Small-to-big retrieval matches a chunk in Qdrant and expands it to the
 * full section text stored here.
 *
 * The primary key is composite `(path, parent_id)` on purpose: `parent_id` is derived
 * from the section's ordinal + section path only, never the file path, so two different
 * notes can legitimately produce the same `parent_id`. Excluding the path is what keeps
 * a rename a cheap `UPDATE sections SET path` instead of a re-embed.
 */
export const sections = sqliteTable(
  'sections',
  {
    path: text('path').notNull(),
    parentId: text('parent_id').notNull(),
    sectionPath: text('section_path').notNull(),
    text: text('text').notNull(),
    contentHash: text('content_hash').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.path, table.parentId] }),
    index('sections_path_idx').on(table.path),
  ],
);

export type Section = typeof sections.$inferSelect;
export type NewSection = typeof sections.$inferInsert;

/**
 * Cached one-paragraph annotations of whole documents, prepended to every chunk of the
 * file before it is embedded. The cache is keyed by path and validated by
 * `content_hash`: an unchanged file never pays for the LLM call again, which is what
 * makes a full reindex cheap (the table lives on the backend's persistent volume).
 */
export const docSummaries = sqliteTable('doc_summaries', {
  path: text('path').primaryKey(),
  contentHash: text('content_hash').notNull(),
  summary: text('summary').notNull(),
});

export type DocSummary = typeof docSummaries.$inferSelect;
export type NewDocSummary = typeof docSummaries.$inferInsert;
