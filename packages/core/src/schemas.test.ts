import { describe, expect, it } from 'vitest';
import { DisplayName, nameKey } from './schemas.ts';

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
