// Pure media-delivery + direct-upload decision logic.
// No schema library, no DB, no network — safe to import from BOTH a browser
// bundle (the intake form) and server routes, and fully unit-testable.
import { isPubliclyVisible, type Status, type ConsentContext } from './moderation';

// ---- accepted media types ----
// Single source of truth, kept here (zero-dep, browser-safe) so the client form,
// the upload-token issuer and the submit route all gate on the SAME exact list.

// Includes the formats phones actually produce: iPhone voice memos
// (audio/x-m4a), iPhone photos (image/heic|heif), Android video (3gpp, mkv).
export const ALLOWED_MIME: Record<'image' | 'audio' | 'video', string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/webm', 'audio/3gpp', 'audio/amr'],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska', 'video/3gpp'],
};

/** Map a MIME type to a media kind, or null if not accepted. */
export function mediaKindForMime(mime: string): 'image' | 'audio' | 'video' | null {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  for (const kind of ['image', 'audio', 'video'] as const) {
    if (ALLOWED_MIME[kind].includes(m)) return kind;
  }
  return null;
}

// ---- direct-to-store upload (client upload) ----

/** Staging prefix for client-uploaded objects awaiting a submission. */
export const INCOMING_PREFIX = 'incoming/';

/**
 * Serverless platforms cap request bodies (commonly ~4.5 MB), so multipart
 * intake only works for small files. Anything above this goes directly from
 * the browser to the object store (client upload). 3.5 MB leaves headroom for
 * the other form fields + multipart framing under a 4.5 MB cap.
 */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = Math.floor(3.5 * 1024 * 1024);

/** Ceiling for client-uploaded recordings (enforced in the upload token AND re-checked at submit). */
export const MAX_CLIENT_MEDIA_BYTES = 200 * 1024 * 1024; // 200 MB

export type UploadVariant = 'multipart' | 'client-upload';

/** Which intake variant a file of `bytes` must use. */
export function uploadVariantFor(bytes: number): UploadVariant {
  return bytes > DIRECT_UPLOAD_THRESHOLD_BYTES ? 'client-upload' : 'multipart';
}

/** Sanitise an uploaded file name for use in a storage key. */
export function sanitiseFilename(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}

// Strict shape for a staged pathname: `incoming/<sanitised-name>` where the
// name is ASCII [A-Za-z0-9._-], does not start with a dot, and contains no
// further slashes. This matches exactly what sanitiseFilename() can produce
// (a leading _ or - is possible after unicode replacement; a leading dot is
// not) plus the `-<alphanumeric>` random suffix an object store may append —
// traversal sequences, unicode tricks, nested prefixes and empty names are
// all structurally impossible. Length cap: 120 (sanitised name) + ~40 suffix.
const INCOMING_PATHNAME_RE = /^incoming\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,169}$/;

/** True when `pathname` is a valid staged upload path under incoming/. */
export function incomingPathnameValid(pathname: unknown): pathname is string {
  if (typeof pathname !== 'string') return false;
  if (!INCOMING_PATHNAME_RE.test(pathname)) return false;
  // Defence in depth: the char class already excludes '/', so '..' cannot
  // traverse — but reject it outright so the invariant never depends on a
  // single regex reading.
  if (pathname.includes('..')) return false;
  return true;
}

// ---- public media delivery gate ----

/**
 * The ONLY rule under which a stored media file may be served publicly:
 * the contribution passes the publish-guard (status published AND consent
 * standing) AND the consent scope explicitly includes 'public-display'.
 * Everything else — including "the row exists" — must look like a 404.
 */
export function canServeMediaPublicly(
  status: Status,
  ctx: ConsentContext,
  scopeUses: readonly string[] | null | undefined
): boolean {
  return (
    isPubliclyVisible(status, ctx) &&
    Array.isArray(scopeUses) &&
    scopeUses.includes('public-display')
  );
}
