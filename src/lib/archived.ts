/**
 * Folder names that mean "kept for history, not current".
 *
 * The Confluence sync builds the vault path out of the page's ancestor chain, so a
 * page filed under an "Архив" parent lands under that segment — which makes the path
 * the only trustworthy signal available at index time. The page BODY is not: a page
 * sitting in Архив was observed still carrying an "[АКТУАЛЬНО]" marker in its own
 * text, and the model believed the text over the folder.
 */
const ARCHIVE_SEGMENTS = new Set(['архив', 'архивное', 'archive', 'archived', 'deprecated']);

/**
 * Stale-content flag, from the folder tree or an explicit `archived:` frontmatter key.
 *
 * Deliberately conservative in two ways: it matches a WHOLE path segment, so a page
 * under "Архитектура" is not swept up by a prefix match; and it ignores the file's own
 * name, so a page *called* "Архив" is not itself archived — only its children are.
 */
export function isArchived(filePath: string, frontmatter: Record<string, unknown>): boolean {
  if (typeof frontmatter.archived === 'boolean') return frontmatter.archived;
  const ancestors = filePath.split('/').slice(0, -1);
  return ancestors.some((segment) => ARCHIVE_SEGMENTS.has(segment.trim().toLowerCase()));
}
