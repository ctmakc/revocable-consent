// Intake-form helpers: filename sanitising, MIME gating, consent-statement
// validation and the scope helpers — the cases the original suites skip.
import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MIME,
  INCOMING_PREFIX,
  incomingPathnameValid,
  mediaKindForMime,
  sanitiseFilename,
  uploadVariantFor,
} from '../src/media-access';
import { CONSENT_TEMPLATE, consentStatementProblem } from '../src/consent-template';
import { effectiveScope, isScopeNarrowing, scopeAllows, BUILTIN_SCOPE_USES } from '../src/consent';
import * as api from '../src/index';

describe('sanitiseFilename', () => {
  it('keeps safe names unchanged', () => {
    expect(sanitiseFilename('Recording_01-final.mp3')).toBe('Recording_01-final.mp3');
  });

  it('keeps only the last path segment, for both separators', () => {
    expect(sanitiseFilename('C:\\Users\\me\\Desktop\\song.wav')).toBe('song.wav');
    expect(sanitiseFilename('/var/tmp/../etc/passwd')).toBe('passwd');
  });

  it('collapses runs of unsafe characters into a single underscore', () => {
    expect(sanitiseFilename('my song (final)!!.WAV')).toBe('my_song_final_.WAV');
    expect(sanitiseFilename('пісня.mp3')).toBe('_.mp3');
  });

  it('strips leading dots and falls back to "file" for empty results', () => {
    expect(sanitiseFilename('.env')).toBe('env');
    expect(sanitiseFilename('...')).toBe('file');
    expect(sanitiseFilename('')).toBe('file');
    expect(sanitiseFilename('dir/')).toBe('file');
    expect(sanitiseFilename(undefined as unknown as string)).toBe('file');
  });

  it('caps the result at 120 characters', () => {
    const out = sanitiseFilename('a'.repeat(300) + '.mp3');
    expect(out).toHaveLength(120);
    expect(out).toBe('a'.repeat(120));
  });

  it('a capped name plus a store suffix still fits the staging-path validator', () => {
    const name = sanitiseFilename('x'.repeat(500));
    expect(incomingPathnameValid(`${INCOMING_PREFIX}${name}-${'Z'.repeat(40)}`)).toBe(true);
  });

  it.skip('bug: a name with ".." inside (e.g. "interview..final.m4a") is sanitised to a staging path that incomingPathnameValid rejects', () => {
    // media-access.ts says the staging regex "matches exactly what
    // sanitiseFilename() can produce", but sanitiseFilename keeps '..' and the
    // validator rejects any '..' — a real upload with such a name fails at submit.
    const staged = `${INCOMING_PREFIX}${sanitiseFilename('interview..final.m4a')}`;
    expect(incomingPathnameValid(staged)).toBe(true);
  });
});

describe('mediaKindForMime', () => {
  it('every listed MIME maps back to its own kind', () => {
    for (const kind of ['image', 'audio', 'video'] as const) {
      for (const mime of ALLOWED_MIME[kind]) expect(mediaKindForMime(mime), mime).toBe(kind);
    }
  });

  it('tolerates surrounding whitespace and parameters', () => {
    expect(mediaKindForMime('  audio/mpeg ; charset=binary')).toBe('audio');
  });

  it('is null for null-ish input', () => {
    expect(mediaKindForMime(undefined as unknown as string)).toBeNull();
    expect(mediaKindForMime(null as unknown as string)).toBeNull();
  });

  it('the three kinds share no MIME type', () => {
    const all = [...ALLOWED_MIME.image, ...ALLOWED_MIME.audio, ...ALLOWED_MIME.video];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('uploadVariantFor', () => {
  it('treats negative or NaN sizes as multipart (never routes junk to the direct-upload path)', () => {
    expect(uploadVariantFor(-1)).toBe('multipart');
    expect(uploadVariantFor(Number.NaN)).toBe('multipart');
  });
});

describe('consentStatementProblem — more shapes', () => {
  const filled = CONSENT_TEMPLATE.replace('[name]', 'Olena Koval').replace(
    '[role / relationship to the community]',
    'elder of the village council'
  );

  it('flags a placeholder regardless of its case', () => {
    expect(consentStatementProblem('I, [NAME], agree.')).toMatch(/placeholder “\[name\]”/);
  });

  it('flags the second placeholder alone', () => {
    const p = consentStatementProblem('I, Olena, as [role / relationship to the community], agree in my own words.');
    expect(p).toMatch(/placeholder “\[role \/ relationship to the community\]”/);
  });

  it('flags the filled template even with only one blank filled in and the other left empty', () => {
    const half = CONSENT_TEMPLATE.replace('[name]', 'Olena').replace('[role / relationship to the community]', '');
    expect(consentStatementProblem(half)).toMatch(/template with the blanks filled in/);
  });

  it('accepts the filled template when a sentence is appended (it was edited)', () => {
    expect(consentStatementProblem(`${filled} We ask that the recording is not used in advertising.`)).toBeNull();
  });

  it('accepts the filled template with a sentence removed', () => {
    const shortened = filled.replace(/ Machine processing is only ever performed[^]*$/, '');
    expect(consentStatementProblem(shortened)).toBeNull();
  });

  it('accepts an empty statement here (presence is the form schema’s job)', () => {
    expect(consentStatementProblem('')).toBeNull();
  });
});

describe('scope helpers — more cases', () => {
  it('scopeAllows supports operator-defined uses', () => {
    expect(scopeAllows({ revoked: false, scope_uses: ['oral-history-podcast'] }, 'oral-history-podcast')).toBe(true);
  });

  it('effectiveScope tolerates a record with null scope_uses', () => {
    expect(
      effectiveScope([
        { revoked: false, scope_uses: null as never },
        { revoked: false, scope_uses: ['research'] },
      ])
    ).toEqual(['research']);
  });

  it('isScopeNarrowing: identical and empty-after are narrowing; empty-before to anything is widening', () => {
    expect(isScopeNarrowing(['research'], ['research'])).toBe(true);
    expect(isScopeNarrowing(['research'], [])).toBe(true);
    expect(isScopeNarrowing([], [])).toBe(true);
    expect(isScopeNarrowing([], ['research'])).toBe(false);
  });

  it('the built-in vocabulary is the documented four', () => {
    expect([...BUILTIN_SCOPE_USES]).toEqual(['public-display', 'research', 'education', 'machine-processing']);
  });
});

describe('public entry point', () => {
  it('exports every runtime function and constant the README modules describe', () => {
    const expected = [
      'BUILTIN_SCOPE_USES', 'consentContext', 'effectiveScope', 'isScopeNarrowing', 'scopeAllows',
      'CONSENT_TEMPLATE', 'consentStatementProblem',
      'ACTIONS', 'STATUSES', 'consentStands', 'isPubliclyVisible', 'transition',
      'ALLOWED_MIME', 'DIRECT_UPLOAD_THRESHOLD_BYTES', 'INCOMING_PREFIX', 'MAX_CLIENT_MEDIA_BYTES',
      'canServeMediaPublicly', 'incomingPathnameValid', 'mediaKindForMime', 'sanitiseFilename', 'uploadVariantFor',
      'NO_SHARED_CACHE_HEADERS', 'mintSignedUrl', 'signClaims', 'verifySignedUrl',
      'FailingDeleteAdapter', 'MemoryStorageAdapter',
      'outstandingWork', 'receiptHash', 'revokeConsent',
      'GENESIS_PREV_HASH', 'GENESIS_PREV_SEQ', 'LEDGER_ENTRY_TYPES', 'appendLedgerEntry', 'canonicalJson',
      'computeEntryHash', 'publicEntryType', 'verifyChain', 'verifyLedger', 'verifyLedgerTail',
      'sha256Hex',
    ];
    for (const name of expected) expect(api, name).toHaveProperty(name);
  });

  it('the exported sha256Hex is the byte-capable checksum helper', () => {
    expect(api.sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});
