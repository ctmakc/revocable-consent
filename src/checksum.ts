// SHA-256 helper (Node runtime).
import { createHash } from 'node:crypto';

/** Hex-encoded SHA-256 of a buffer/byte array. */
export function sha256Hex(data: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
