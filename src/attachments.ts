/**
 * What an attachment may be, shared by the broker (which checks uploaded bytes) and the bridge
 * (which checks local files before reading them). Images are recognized by their magic bytes,
 * never by their name alone; text documents must be valid UTF-8. Nothing here touches a disk.
 */
import { z } from 'zod';

/** At most this many attachments per message. */
export const MAX_ATTACHMENTS = 5;
/** Broker defaults; each can be changed through the environment (see docs/OPERATIONS.md). */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;
export const DEFAULT_LOBBY_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
// A day after the last message that uses it, as messages themselves are kept a day.
export const DEFAULT_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** An upload that no send referenced within this time is removed. */
export const DEFAULT_ATTACHMENT_GRACE_MS = 60 * 60 * 1000;
/** Uploads are refused when they would leave less free disk than this beside the database. */
export const DEFAULT_ATTACHMENT_DISK_RESERVE_BYTES = 256 * 1024 * 1024;
/** Upload bodies the broker holds in memory at once, across all uploads. */
export const DEFAULT_UPLOAD_INFLIGHT_BYTES = 32 * 1024 * 1024;

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const TEXT_MIME_TYPES = [
  'text/markdown',
  'text/plain',
  'text/csv',
  'application/json',
] as const;
export const ATTACHMENT_MIME_TYPES = [...IMAGE_MIME_TYPES, ...TEXT_MIME_TYPES] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];
export type AttachmentKind = 'image' | 'text';

const IMAGE_EXTENSIONS: Record<string, true> = {
  png: true,
  jpg: true,
  jpeg: true,
  gif: true,
  webp: true,
};
const TEXT_EXTENSIONS: Record<string, AttachmentMime> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  log: 'text/plain',
};
export const ALLOWED_EXTENSIONS =
  'png, jpg, jpeg, gif and webp images, or md, txt, csv, json and log text';
/** Where a file of another type goes instead, in the wording of the evidence field. */
export const OTHER_FILES =
  'For other files, put a logical location each machine resolves itself, such as dropbox:MDP/reports/run-42, in the evidence field';

export const kindOf = (mime: string): AttachmentKind =>
  mime.startsWith('image/') ? 'image' : 'text';

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** The kind a file name promises, or null for a name this release does not accept. */
export function kindForFilename(filename: string): AttachmentKind | null {
  const extension = extensionOf(filename);
  if (IMAGE_EXTENSIONS[extension]) return 'image';
  if (TEXT_EXTENSIONS[extension]) return 'text';
  return null;
}

/** An image type from the file's first bytes, or null. */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  const at = (offset: number, ...values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61))) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** Valid UTF-8 without NUL bytes, which no text document of these types contains. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export type Classification =
  { ok: true; kind: AttachmentKind; mime_type: AttachmentMime } | { ok: false; reason: string };

/**
 * What a named file's bytes are. An image name must hold image bytes (the type comes from the
 * bytes, so a JPEG saved as .png is attached as JPEG); a text name must hold UTF-8 text.
 */
export function classify(filename: string, bytes: Uint8Array): Classification {
  const kind = kindForFilename(filename);
  if (!kind) return { ok: false, reason: `only ${ALLOWED_EXTENSIONS} can be attached` };
  if (kind === 'image') {
    const mime = sniffImage(bytes);
    return mime
      ? { ok: true, kind, mime_type: mime }
      : {
          ok: false,
          reason: 'its name says image, but its contents are not PNG, JPEG, GIF or WebP',
        };
  }
  if (sniffImage(bytes) || !isText(bytes))
    return { ok: false, reason: 'its name says text, but its contents are not UTF-8 text' };
  return { ok: true, kind, mime_type: TEXT_EXTENSIONS[extensionOf(filename)]! };
}

/** The bytes alone, for an upload: an image by magic bytes, else UTF-8 text, else nothing. */
export function kindOfBytes(bytes: Uint8Array): AttachmentKind | null {
  if (sniffImage(bytes)) return 'image';
  return isText(bytes) ? 'text' : null;
}

/** A plain file name: no directories, no control characters, not hidden, a known extension. */
export const AttachmentFilename = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 255, 'File name exceeds 255 bytes')
  .refine(
    (value) => !/[\\/\p{Cc}\p{Zl}\p{Zp}]/u.test(value) && !value.startsWith('.'),
    'Use a plain file name without directories, control characters or a leading dot',
  )
  .refine((value) => kindForFilename(value) !== null, `Attach ${ALLOWED_EXTENSIONS}`);

/** One attachment of a send, as the bridge describes it after reading the file. */
export const AttachmentDescriptor = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/u, 'A lowercase hex SHA-256'),
    filename: AttachmentFilename,
    mime_type: z.enum(ATTACHMENT_MIME_TYPES),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (value) => kindForFilename(value.filename) === kindOf(value.mime_type),
    'The file name and type disagree',
  );
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptor>;

/** Width and height from an image header, without decoding it; null when unreadable. */
export function imageDimensions(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === 'image/png') return { width: view.getUint32(16), height: view.getUint32(20) };
    if (mime === 'image/gif')
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (mime === 'image/webp') {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === 'VP8 ')
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X')
        return {
          width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
          height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
        };
      return null;
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        if (marker === 0xff) {
          offset++;
          continue;
        }
        const length = view.getUint16(offset + 2);
        // Start-of-frame markers, excluding DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
        offset += 2 + length;
      }
    }
  } catch {
    /* A truncated header. */
  }
  return null;
}

export interface MarkdownHeading {
  /** Where the heading line starts, in characters (UTF-16 code units, as get_attachment counts). */
  offset: number;
  level: number;
  title: string;
  /** Characters up to the next heading of the same or a higher level, or the end. */
  length: number;
}
/**
 * The ATX headings of a Markdown document (`#` to `######`), outside fenced code blocks and a
 * leading YAML front matter block, so a reader can jump to a section with its offset.
 */
export function markdownHeadings(text: string): MarkdownHeading[] {
  const headings: Omit<MarkdownHeading, 'length'>[] = [];
  let fence: string | null = null;
  let frontMatter = /^---\r?\n/u.test(text);
  let offset = 0;
  for (const line of text.split('\n')) {
    const content = line.replace(/\r$/u, '');
    if (frontMatter) {
      if (offset > 0 && /^(---|\.\.\.)\s*$/u.test(content)) frontMatter = false;
    } else {
      if (fence !== null) {
        // A closing fence is the same character, at least as long, then only whitespace.
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(content)?.[1];
        if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
        offset += line.length + 1;
        continue;
      }
      const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(content)?.[1];
      if (marker) fence = marker;
      else {
        const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u.exec(content);
        const title = heading?.[2]?.trim();
        if (heading && title)
          headings.push({ offset, level: heading[1]!.length, title: title.slice(0, 200) });
      }
    }
    offset += line.length + 1;
  }
  // A section ends at the next heading of the same or a higher level: one pass with a stack
  // of open sections, so a document with many headings costs linear time.
  const ends = new Array<number>(headings.length).fill(text.length);
  const open: number[] = [];
  headings.forEach((heading, index) => {
    while (open.length && headings[open.at(-1)!]!.level >= heading.level)
      ends[open.pop()!] = heading.offset;
    open.push(index);
  });
  return headings.map((heading, index) => ({ ...heading, length: ends[index]! - heading.offset }));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}
