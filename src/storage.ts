// The storage port the revocation cascade deletes through, plus an in-memory
// implementation used by the tests and by anyone evaluating the library.
//
// Deliberately tiny: presign a read, delete an object, confirm it is gone.
// "Confirm it is gone" is a first-class operation — a deletion that is not
// read back is a claim, and this component's whole purpose is to replace
// claims about revocation with evidence.

export interface StoredObject {
  key: string;
  bytes: number;
  /** Lowercase hex SHA-256 of the object's content, when the operator recorded one. */
  checksum_sha256?: string | null;
}

export interface StorageAdapter {
  /** Human-readable adapter id, recorded in the deletion receipt. */
  readonly name: string;
  /** A short-lived read URL for one key, or null when the adapter cannot mint one. */
  presignRead(key: string, ttlMs: number): Promise<string | null>;
  /** Delete one object. Resolves `true` when the object existed and was deleted. */
  delete(key: string): Promise<boolean>;
  /** Does the object still exist? Used to VERIFY a deletion after the fact. */
  exists(key: string): Promise<boolean>;
  /** Optional metadata read, used to record what was deleted. */
  head?(key: string): Promise<StoredObject | null>;
}

/**
 * Optional companion port for a CDN or shared cache in front of the store.
 * Purging is best-effort by nature, so the cascade records the outcome rather
 * than depending on it for correctness (correctness comes from short-lived,
 * epoch-bound signed URLs — see signed-url.ts).
 */
export interface CachePurger {
  readonly name: string;
  purge(keys: readonly string[]): Promise<{ ok: boolean; detail?: string }>;
}

/** In-memory StorageAdapter. Test double, and a runnable example of the contract. */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly name = 'memory';
  private objects = new Map<string, { bytes: Uint8Array; checksum?: string | null }>();

  constructor(seed: Record<string, Uint8Array | string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.put(k, v);
  }

  put(key: string, content: Uint8Array | string, checksum?: string | null): void {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.objects.set(key, { bytes, checksum });
  }

  async presignRead(key: string, ttlMs: number): Promise<string | null> {
    if (!this.objects.has(key)) return null;
    return `memory://${encodeURIComponent(key)}?exp=${Date.now() + ttlMs}`;
  }

  async delete(key: string): Promise<boolean> {
    return this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async head(key: string): Promise<StoredObject | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return { key, bytes: o.bytes.byteLength, checksum_sha256: o.checksum ?? null };
  }

  /** Test helper: every key currently held. */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}

/**
 * A StorageAdapter that fails every delete. Used to prove the cascade reports
 * an incomplete deletion instead of writing a receipt that claims success.
 */
export class FailingDeleteAdapter implements StorageAdapter {
  readonly name: string;
  constructor(private inner: StorageAdapter, private reason = 'delete refused') {
    this.name = `failing(${inner.name})`;
  }
  presignRead(key: string, ttlMs: number) {
    return this.inner.presignRead(key, ttlMs);
  }
  async delete(_key: string): Promise<boolean> {
    throw new Error(this.reason);
  }
  exists(key: string) {
    return this.inner.exists(key);
  }
  head(key: string) {
    return this.inner.head ? this.inner.head(key) : Promise.resolve(null);
  }
}
