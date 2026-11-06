// The storage port is what the revocation cascade trusts for "the bytes are
// gone", so the reference adapters get their own contract tests.
import { describe, it, expect } from 'vitest';
import {
  FailingDeleteAdapter,
  MemoryStorageAdapter,
  type StorageAdapter,
} from '../src/storage';

describe('MemoryStorageAdapter', () => {
  it('seeds from the constructor, accepting strings and bytes', async () => {
    const s = new MemoryStorageAdapter({ 'a.txt': 'héllo', 'b.bin': new Uint8Array([1, 2, 3]) });
    expect(s.keys().sort()).toEqual(['a.txt', 'b.bin']);
    // byte length, not string length: 'é' is two bytes in UTF-8
    expect((await s.head('a.txt'))?.bytes).toBe(6);
    expect((await s.head('b.bin'))?.bytes).toBe(3);
  });

  it('head reports the recorded checksum, or null when none was recorded', async () => {
    const s = new MemoryStorageAdapter();
    s.put('with', 'x', 'f'.repeat(64));
    s.put('without', 'x');
    expect(await s.head('with')).toEqual({ key: 'with', bytes: 1, checksum_sha256: 'f'.repeat(64) });
    expect(await s.head('without')).toEqual({ key: 'without', bytes: 1, checksum_sha256: null });
    expect(await s.head('missing')).toBeNull();
  });

  it('delete is true exactly once, and exists() reflects it', async () => {
    const s = new MemoryStorageAdapter({ k: 'v' });
    expect(await s.exists('k')).toBe(true);
    expect(await s.delete('k')).toBe(true);
    expect(await s.exists('k')).toBe(false);
    expect(await s.delete('k')).toBe(false);
    expect(s.keys()).toEqual([]);
  });

  it('put overwrites an existing key', async () => {
    const s = new MemoryStorageAdapter({ k: 'short' });
    s.put('k', 'much longer content');
    expect((await s.head('k'))?.bytes).toBe('much longer content'.length);
    expect(s.keys()).toEqual(['k']);
  });

  it('presignRead mints a URL-encoded, expiring URL for held keys only', async () => {
    const s = new MemoryStorageAdapter({ 'media/a b.mp3': 'x' });
    const before = Date.now();
    const url = await s.presignRead('media/a b.mp3', 60_000);
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.protocol).toBe('memory:');
    expect(url).toContain(encodeURIComponent('media/a b.mp3'));
    const exp = Number(parsed.searchParams.get('exp'));
    expect(exp).toBeGreaterThanOrEqual(before + 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(await s.presignRead('nope', 60_000)).toBeNull();
  });

  it('names itself for the receipt', () => {
    expect(new MemoryStorageAdapter().name).toBe('memory');
  });
});

describe('FailingDeleteAdapter', () => {
  it('throws on every delete with the configured reason and leaves the object in place', async () => {
    const inner = new MemoryStorageAdapter({ k: 'v' });
    const f = new FailingDeleteAdapter(inner, 'bucket is read-only');
    await expect(f.delete('k')).rejects.toThrow('bucket is read-only');
    expect(await f.exists('k')).toBe(true);
    expect(await inner.exists('k')).toBe(true);
  });

  it('has a default reason and a name that records the wrapped adapter', async () => {
    const f = new FailingDeleteAdapter(new MemoryStorageAdapter());
    expect(f.name).toBe('failing(memory)');
    await expect(f.delete('x')).rejects.toThrow('delete refused');
  });

  it('delegates presignRead and head to the wrapped adapter', async () => {
    const inner = new MemoryStorageAdapter();
    inner.put('k', 'abcd', '0'.repeat(64));
    const f = new FailingDeleteAdapter(inner);
    expect(await f.head('k')).toEqual({ key: 'k', bytes: 4, checksum_sha256: '0'.repeat(64) });
    expect(await f.presignRead('k', 1000)).toMatch(/^memory:\/\/k\?exp=\d+$/);
  });

  it('head resolves null when the wrapped adapter has no head()', async () => {
    const bare: StorageAdapter = {
      name: 'bare',
      presignRead: async () => null,
      delete: async () => true,
      exists: async () => true,
    };
    const f = new FailingDeleteAdapter(bare);
    expect(await f.head('anything')).toBeNull();
  });
});
