import { describe, it, expect } from 'vitest';
import { FailingDeleteAdapter, MemoryStorageAdapter, type StorageAdapter } from '../src/storage';

describe('MemoryStorageAdapter (the reference StorageAdapter contract)', () => {
  it('seeds from the constructor with strings and bytes', async () => {
    const s = new MemoryStorageAdapter({ 'a.txt': 'hello', 'b.bin': new Uint8Array([1, 2, 3]) });
    expect(s.keys().sort()).toEqual(['a.txt', 'b.bin']);
    expect(await s.head('a.txt')).toEqual({ key: 'a.txt', bytes: 5, checksum_sha256: null });
    expect(await s.head('b.bin')).toMatchObject({ bytes: 3 });
  });

  it('counts bytes, not characters, for multibyte text', async () => {
    const s = new MemoryStorageAdapter();
    s.put('uk.txt', 'звук'); // 4 Cyrillic letters = 8 UTF-8 bytes
    expect((await s.head('uk.txt'))?.bytes).toBe(8);
  });

  it('records the checksum supplied with put', async () => {
    const s = new MemoryStorageAdapter();
    s.put('k', 'x', 'f'.repeat(64));
    expect((await s.head('k'))?.checksum_sha256).toBe('f'.repeat(64));
  });

  it('delete reports whether the object existed, and exists() confirms', async () => {
    const s = new MemoryStorageAdapter({ k: 'x' });
    expect(await s.exists('k')).toBe(true);
    expect(await s.delete('k')).toBe(true);
    expect(await s.exists('k')).toBe(false);
    expect(await s.delete('k')).toBe(false); // second delete: nothing there
    expect(await s.head('k')).toBeNull();
  });

  it('presignRead returns null for a missing key and an encoded, expiring URL otherwise', async () => {
    const s = new MemoryStorageAdapter({ 'media/a b?.mp3': 'x' });
    expect(await s.presignRead('missing', 1000)).toBeNull();
    const before = Date.now();
    const url = await s.presignRead('media/a b?.mp3', 60_000);
    expect(url).toMatch(/^memory:\/\/media%2Fa%20b%3F\.mp3\?exp=\d+$/);
    const exp = Number(url!.split('exp=')[1]);
    expect(exp).toBeGreaterThanOrEqual(before + 60_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('put overwrites an existing key', async () => {
    const s = new MemoryStorageAdapter({ k: 'short' });
    s.put('k', 'much longer content');
    expect((await s.head('k'))?.bytes).toBe(19);
    expect(s.keys()).toEqual(['k']);
  });
});

describe('FailingDeleteAdapter', () => {
  it('fails every delete but leaves the object in place and readable', async () => {
    const inner = new MemoryStorageAdapter({ k: 'x' });
    const f = new FailingDeleteAdapter(inner, 'quota exceeded');
    expect(f.name).toBe('failing(memory)');
    await expect(f.delete('k')).rejects.toThrow('quota exceeded');
    expect(await f.exists('k')).toBe(true);
    expect(await f.head('k')).toMatchObject({ key: 'k', bytes: 1 });
    expect(await f.presignRead('k', 1000)).toMatch(/^memory:\/\//);
  });

  it('defaults the failure reason', async () => {
    const f = new FailingDeleteAdapter(new MemoryStorageAdapter());
    await expect(f.delete('k')).rejects.toThrow('delete refused');
  });

  it('head resolves null when the inner adapter has no head()', async () => {
    const bare: StorageAdapter = {
      name: 'bare',
      presignRead: async () => null,
      delete: async () => true,
      exists: async () => true,
    };
    const f = new FailingDeleteAdapter(bare);
    expect(f.name).toBe('failing(bare)');
    expect(await f.head('anything')).toBeNull();
  });
});
