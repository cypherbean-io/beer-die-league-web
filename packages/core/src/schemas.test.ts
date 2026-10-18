import { describe, expect, it } from 'vitest';
import {
  AuditQuery,
  DisplayName,
  nameKey,
  playerLines,
  RulesBody,
  SettingsBody,
  SubmitGameBody,
} from './schemas.ts';

const accepts = (raw: string) => DisplayName.safeParse(raw).success;

describe('DisplayName', () => {
  it.each(["O'Neil", 'Ana', 'Jo', 'Mary-Kate', 'J.R. Smith', 'big_dog_99', 'Zoë', 'राम'])(
    'accepts %j',
    (raw) => {
      expect(accepts(raw)).toBe(true);
    },
  );

  it.each([
    ['markup', '<img src=x onerror=alert(1)>'],
    ['a single character', 'A'],
    ['25 characters', 'a'.repeat(25)],
    ['only spaces', '    '],
    ['a newline', 'Ana\nBo'],
    ['a tab', 'Ana\tBo'],
    ['an emoji', 'Ana 🍺'],
    ['quotes', '"Ana"'],
    ['a zero-width space', 'An\u200Ba'],
    ['an ampersand', 'Ana & Bo'],
  ])('rejects %s', (_label, raw) => {
    expect(accepts(raw)).toBe(false);
  });

  // Names that would render as, or impersonate, an existing member's name.
  it.each([
    ['a trailing variation selector', 'Ana\uFE0F'],
    ['a combining grapheme joiner', 'Ana\u034F'],
    ['a Mongolian free variation selector', 'Ana\u180B'],
    ['only Hangul fillers, which render blank', '\u3164\u3164'],
    ['only combining marks', '\u0301\u0301'],
    ['a leading combining mark', '\u0301Ana'],
    ['Cyrillic letters mixed with Latin', '\u0410n\u0430'],
    ['Greek letters mixed with Latin', 'B\u03BF'],
  ])('rejects %s', (_label, raw) => {
    expect(accepts(raw)).toBe(false);
  });

  // Mail clients auto-link anything shaped like a domain, so a name must not be one.
  it.each(['bdl-signin.com', 'evil.co', 'ana.example.org', 'St.John'])(
    'rejects the domain-like name %j',
    (raw) => {
      expect(accepts(raw)).toBe(false);
    },
  );

  it.each(['St. John', 'J.R. Smith', 'A.J.', 'Иван', 'Νίκος', '田中'])(
    'still accepts %j',
    (raw) => {
      expect(accepts(raw)).toBe(true);
    },
  );

  it('accepts exactly 24 characters', () => {
    expect(accepts('a'.repeat(24))).toBe(true);
  });

  it('counts characters, not UTF-16 code units', () => {
    // Each 𝒜 is one character but two code units; NFKC folds it to "A".
    expect(DisplayName.parse('𝒜'.repeat(12))).toBe('A'.repeat(12));
  });

  it('applies NFKC normalization', () => {
    expect(DisplayName.parse('Ａｎａ')).toBe('Ana');
  });

  it('turns typographic apostrophes into plain ones', () => {
    expect(DisplayName.parse('O’Neil')).toBe("O'Neil");
  });

  it('trims and collapses runs of spaces', () => {
    expect(DisplayName.parse('  Ana   Bo  ')).toBe('Ana Bo');
  });
});

describe('nameKey', () => {
  it('is the same for names differing only in case or compatibility form', () => {
    const key = nameKey(DisplayName.parse('Ana'));

    expect(nameKey(DisplayName.parse('ANA'))).toBe(key);
    expect(nameKey(DisplayName.parse('Ａｎａ'))).toBe(key);
  });

  it('differs for different names', () => {
    expect(nameKey('Ana')).not.toBe(nameKey('Ann'));
  });
});

describe('RulesBody', () => {
  it.each([
    [{ targetScore: 1 }],
    [{ targetScore: 99 }],
    [{ winBy: 1 }],
    [{ winBy: 99 }],
    [{ sinkPoints: 0 }],
    [{ sinkPoints: 99 }],
    [{ sinkEndsGame: true }],
    [{ targetScore: 21, winBy: 1, sinkPoints: 3, sinkEndsGame: false }],
  ])('accepts %j', (body) => {
    expect(RulesBody.safeParse(body).success).toBe(true);
  });

  it.each([
    ['no rules at all', {}],
    ['a target score of 0', { targetScore: 0 }],
    ['a target score of 100', { targetScore: 100 }],
    ['a fractional target score', { targetScore: 10.5 }],
    ['a target score sent as a string', { targetScore: '11' }],
    ['a win-by of 0', { winBy: 0 }],
    ['a win-by of 100', { winBy: 100 }],
    ['negative sink points', { sinkPoints: -1 }],
    ['sink points of 100', { sinkPoints: 100 }],
    ['a non-boolean sink-ends-game flag', { sinkEndsGame: 'yes' }],
    ['a setting, which has its own route', { confirmationWindowDays: 7 }],
    ['an unknown key', { targetScore: 11, overtime: true }],
  ])('rejects %s', (_label, body) => {
    expect(RulesBody.safeParse(body).success).toBe(false);
  });
});

describe('SettingsBody', () => {
  it.each([
    [{ confirmationWindowDays: 1 }],
    [{ confirmationWindowDays: 30 }],
    [{ exhibitionCorrectionWindowDays: 0 }],
    [{ exhibitionCorrectionWindowDays: 365 }],
    [{ confirmationWindowDays: 3, exhibitionCorrectionWindowDays: 14 }],
  ])('accepts %j', (body) => {
    expect(SettingsBody.safeParse(body).success).toBe(true);
  });

  it.each([
    ['no settings at all', {}],
    ['a confirmation window of 0 days', { confirmationWindowDays: 0 }],
    ['a confirmation window of 31 days', { confirmationWindowDays: 31 }],
    ['a fractional confirmation window', { confirmationWindowDays: 1.5 }],
    ['a negative correction window', { exhibitionCorrectionWindowDays: -1 }],
    ['a correction window of 366 days', { exhibitionCorrectionWindowDays: 366 }],
    ['a rule, which has its own route', { targetScore: 21 }],
    ['an unknown key', { confirmationWindowDays: 7, name: 'Garage League' }],
  ])('rejects %s', (_label, body) => {
    expect(SettingsBody.safeParse(body).success).toBe(false);
  });
});

describe('AuditQuery', () => {
  const before = '0199f3a2-5c1e-7a00-8000-000000000000';

  it('accepts no parameters', () => {
    expect(AuditQuery.parse({})).toEqual({});
  });

  it('reads the limit from its query-string form', () => {
    expect(AuditQuery.parse({ limit: '25', before })).toEqual({ limit: 25, before });
  });

  it.each([
    ['a limit of 0', { limit: '0' }],
    ['a limit of 101', { limit: '101' }],
    ['a fractional limit', { limit: '2.5' }],
    ['a limit in exponent form', { limit: '1e2' }],
    ['a non-numeric limit', { limit: 'ten' }],
    ['an empty limit', { limit: '' }],
    ['a cursor that is not a UUID', { before: 'yesterday' }],
    ['an unknown parameter', { action: 'league.rules_updated' }],
  ])('rejects %s', (_label, query) => {
    expect(AuditQuery.safeParse(query).success).toBe(false);
  });
});

describe('SubmitGameBody', () => {
  const ids = [
    '0199f3a2-5c1e-7a00-8000-00000000000a',
    '0199f3a2-5c1e-7a00-8000-00000000000b',
    '0199f3a2-5c1e-7a00-8000-00000000000c',
    '0199f3a2-5c1e-7a00-8000-00000000000d',
  ] as const;
  const line = (membershipId: string, points: number, sinks = 0) => ({
    membershipId,
    points,
    sinks,
  });
  const valid = {
    idempotencyKey: '0199f3a2-5c1e-7a00-8000-0000000000ff',
    kind: 'exhibition',
    playedAt: '2026-10-18T11:30:00.000Z',
    sides: {
      A: { players: [line(ids[0], 6), line(ids[1], 5)] },
      B: { players: [line(ids[2], 5), line(ids[3], 4)] },
    },
    winner: 'A',
  };
  const withLine = (patch: object) => ({
    ...valid,
    sides: { ...valid.sides, A: { players: [{ ...line(ids[0], 6), ...patch }, line(ids[1], 5)] } },
  });

  it('accepts an exhibition game', () => {
    expect(SubmitGameBody.safeParse(valid).success).toBe(true);
  });

  it('accepts a time at the very start of 2000', () => {
    const body = { ...valid, playedAt: '2000-01-01T00:00:00.000Z' };

    expect(SubmitGameBody.safeParse(body).success).toBe(true);
  });

  it('accepts a request for commissioner review', () => {
    expect(SubmitGameBody.safeParse({ ...valid, requestOverride: true }).success).toBe(true);
  });

  it.each([
    ['0 points and 0 sinks', { points: 0, sinks: 0 }],
    ['99 points and 99 sinks', { points: 99, sinks: 99 }],
  ])('accepts a line of %s', (_label, patch) => {
    expect(SubmitGameBody.safeParse(withLine(patch)).success).toBe(true);
  });

  it.each([
    ['a season game, which needs seasons', { ...valid, kind: 'season' }],
    ['a missing winner', { ...valid, winner: undefined }],
    ['a winner other than A or B', { ...valid, winner: 'C' }],
    ['a date without a time', { ...valid, playedAt: '2026-10-18' }],
    ['a time before 2000', { ...valid, playedAt: '1999-12-31T23:59:59.999Z' }],
    ['a two-digit year', { ...valid, playedAt: '0049-10-18T11:30:00.000Z' }],
    ['an idempotency key that is not a UUID', { ...valid, idempotencyKey: 'draft-1' }],
    [
      'three players on one side',
      {
        ...valid,
        sides: {
          A: { players: [line(ids[0], 4), line(ids[1], 4), line(ids[2], 3)] },
          B: { players: [line(ids[3], 9)] },
        },
      },
    ],
    ['a missing side', { ...valid, sides: { A: valid.sides.A } }],
    ['a player id that is not a UUID', withLine({ membershipId: 'ana' })],
    ['100 points', withLine({ points: 100 })],
    ['negative sinks', withLine({ sinks: -1 })],
    ['fractional points', withLine({ points: 5.5 })],
    ['points sent as a string', withLine({ points: '6' })],
    ['a client-derived sub flag', withLine({ isSub: false })],
    [
      'a client-derived team total',
      { ...valid, sides: { ...valid.sides, B: { ...valid.sides.B, total: 9 } } },
    ],
    ['an unknown key', { ...valid, seasonId: ids[0] }],
  ])('rejects %s', (_label, body) => {
    expect(SubmitGameBody.safeParse(body).success).toBe(false);
  });
});

describe('playerLines', () => {
  it("lists side A's players, then side B's, each tagged with its side", () => {
    const a1 = { membershipId: 'a1', points: 6, sinks: 1 };
    const a2 = { membershipId: 'a2', points: 5, sinks: 0 };
    const b1 = { membershipId: 'b1', points: 5, sinks: 0 };
    const b2 = { membershipId: 'b2', points: 4, sinks: 0 };

    const lines = playerLines({ A: { players: [a1, a2] }, B: { players: [b1, b2] } });

    expect(lines).toEqual([
      { ...a1, side: 'A' },
      { ...a2, side: 'A' },
      { ...b1, side: 'B' },
      { ...b2, side: 'B' },
    ]);
  });
});
