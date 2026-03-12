/**
 * Image tracking utilities.
 * Extracts backlinks from markdown files for image files tracked in SQLite.
 * Images are not embedded into Qdrant — only tracked with their linked notes.
 */

export const IMAGE_EXTENSIONS: Set<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.bmp',
]);

/**
 * Scan markdown content strings for Obsidian wikilink image embeds referencing `imageName`.
 *
 * Handles:
 * - Exact match:         ![[image.png]]
 * - Subfolder path:      ![[attachments/image.png]]   (matches by basename)
 * - Alias:               ![[image.png|My Caption]]
 * - Subfolder + alias:   ![[attachments/image.png|Caption]]
 *
 * @param imageName - Basename of the image file (e.g., "photo.jpg")
 * @param markdownContents - Array of { path, content } for markdown files to scan
 * @returns Array of markdown file paths that reference the image
 */
export function extractImageBacklinks(
  imageName: string,
  markdownContents: Array<{ path: string; content: string }>,
): string[] {
  const results: string[] = [];
  const EMBED_REGEX = /!\[\[([^\]]+)\]\]/g;

  for (const { path, content } of markdownContents) {
    let found = false;

    for (const match of content.matchAll(EMBED_REGEX)) {
      const inner = match[1];
      if (!inner) continue;

      // Strip alias: "path/image.png|alias" -> "path/image.png"
      const withoutAlias = inner.split('|')[0] ?? inner;

      // Get basename of the reference
      const refBasename = withoutAlias.split('/').at(-1) ?? withoutAlias;

      if (refBasename === imageName) {
        found = true;
        break;
      }
    }

    if (found) {
      results.push(path);
    }
  }

  return results;
}
