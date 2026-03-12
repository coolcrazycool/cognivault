import { describe, expect, it } from 'vitest';
import { extractImageBacklinks, IMAGE_EXTENSIONS } from '../image-tracker.js';

describe('IMAGE_EXTENSIONS', () => {
  it('contains .png', () => {
    expect(IMAGE_EXTENSIONS.has('.png')).toBe(true);
  });

  it('contains .jpg', () => {
    expect(IMAGE_EXTENSIONS.has('.jpg')).toBe(true);
  });

  it('contains .jpeg', () => {
    expect(IMAGE_EXTENSIONS.has('.jpeg')).toBe(true);
  });

  it('contains .gif', () => {
    expect(IMAGE_EXTENSIONS.has('.gif')).toBe(true);
  });

  it('contains .svg', () => {
    expect(IMAGE_EXTENSIONS.has('.svg')).toBe(true);
  });

  it('contains .webp', () => {
    expect(IMAGE_EXTENSIONS.has('.webp')).toBe(true);
  });

  it('contains .bmp', () => {
    expect(IMAGE_EXTENSIONS.has('.bmp')).toBe(true);
  });
});

describe('extractImageBacklinks', () => {
  it('finds ![[image.png]] references in markdown content', () => {
    const markdownContents = [
      { path: 'notes/a.md', content: 'Hello ![[image.png]] world' },
      { path: 'notes/b.md', content: 'No image here' },
    ];
    const result = extractImageBacklinks('image.png', markdownContents);
    expect(result).toEqual(['notes/a.md']);
  });

  it('handles path variants — matches by basename for subfolder/image.png', () => {
    const markdownContents = [
      { path: 'notes/a.md', content: 'See ![[attachments/image.png]] for details' },
    ];
    const result = extractImageBacklinks('image.png', markdownContents);
    expect(result).toEqual(['notes/a.md']);
  });

  it('handles alias variants — matches image.png|alias', () => {
    const markdownContents = [{ path: 'notes/a.md', content: 'See ![[image.png|My Image]] here' }];
    const result = extractImageBacklinks('image.png', markdownContents);
    expect(result).toEqual(['notes/a.md']);
  });

  it('handles subfolder path with alias', () => {
    const markdownContents = [
      { path: 'notes/a.md', content: '![[attachments/photo.jpg|Photo of me]]' },
    ];
    const result = extractImageBacklinks('photo.jpg', markdownContents);
    expect(result).toEqual(['notes/a.md']);
  });

  it('returns empty array when no references found', () => {
    const markdownContents = [
      { path: 'notes/a.md', content: 'No image references here' },
      { path: 'notes/b.md', content: 'Also no images' },
    ];
    const result = extractImageBacklinks('image.png', markdownContents);
    expect(result).toEqual([]);
  });

  it('returns multiple paths when multiple notes reference the same image', () => {
    const markdownContents = [
      { path: 'notes/a.md', content: 'First ref ![[logo.svg]]' },
      { path: 'notes/b.md', content: 'Second ref ![[logo.svg]]' },
      { path: 'notes/c.md', content: 'No image here' },
    ];
    const result = extractImageBacklinks('logo.svg', markdownContents);
    expect(result).toContain('notes/a.md');
    expect(result).toContain('notes/b.md');
    expect(result).not.toContain('notes/c.md');
  });

  it('does not match a different image name', () => {
    const markdownContents = [{ path: 'notes/a.md', content: '![[other-image.png]]' }];
    const result = extractImageBacklinks('image.png', markdownContents);
    expect(result).toEqual([]);
  });

  it('handles empty markdown contents array', () => {
    const result = extractImageBacklinks('image.png', []);
    expect(result).toEqual([]);
  });
});
