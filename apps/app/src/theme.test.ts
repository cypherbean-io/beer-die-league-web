import { describe, expect, it } from 'vitest';
import { colors, contrastRatio, fontFile, fonts, resolveFont } from './theme';

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('is symmetric', () => {
    expect(contrastRatio(colors.accent, colors.bg)).toBe(contrastRatio(colors.bg, colors.accent));
  });
});

describe('theme colours', () => {
  const grounds = { bg: colors.bg, surface: colors.surface, raised: colors.raised };

  // Body text, on every ground it is drawn on, meets WCAG AA (4.5:1).
  it.each(['text', 'muted', 'accent', 'danger', 'notice'] as const)('%s text is legible', (fg) => {
    for (const [name, ground] of Object.entries(grounds)) {
      expect(contrastRatio(colors[fg], ground), `${fg} on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('text on an accent fill is legible', () => {
    expect(contrastRatio(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
  });

  // Only ever large numerals, so the large-text threshold (3:1) applies.
  it('the losing score is legible as large text', () => {
    expect(contrastRatio(colors.loser, colors.surface)).toBeGreaterThanOrEqual(3);
  });

  // An input's edge is what shows where to type, so it needs non-text contrast (3:1).
  it('input edges stand out from the grounds', () => {
    for (const ground of Object.values(grounds)) {
      expect(contrastRatio(colors.borderStrong, ground)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('fontFile', () => {
  it('picks the bundled body weight nearest the one asked for', () => {
    expect(fontFile(fonts.body, undefined)).toBe('Barlow-Regular');
    expect(fontFile(fonts.body, 'normal')).toBe('Barlow-Regular');
    expect(fontFile(fonts.body, '400')).toBe('Barlow-Regular');
    expect(fontFile(fonts.body, '500')).toBe('Barlow-Medium');
    expect(fontFile(fonts.body, '600')).toBe('Barlow-SemiBold');
    expect(fontFile(fonts.body, 700)).toBe('Barlow-Bold');
    expect(fontFile(fonts.body, 'bold')).toBe('Barlow-Bold');
    expect(fontFile(fonts.body, '900')).toBe('Barlow-Bold');
  });

  it('has condensed only at heading weights', () => {
    expect(fontFile(fonts.display, undefined)).toBe('BarlowCondensed-SemiBold');
    expect(fontFile(fonts.display, '600')).toBe('BarlowCondensed-SemiBold');
    expect(fontFile(fonts.display, '700')).toBe('BarlowCondensed-Bold');
  });
});

describe('resolveFont', () => {
  it('maps a theme family and weight to its file, without synthesizing the weight', () => {
    expect(resolveFont(fonts.display, '700')).toEqual({
      fontFamily: 'BarlowCondensed-Bold',
      fontWeight: 'normal',
    });
  });

  it('uses the inherited family when the style names none', () => {
    expect(resolveFont(undefined, '600')).toEqual({
      fontFamily: 'Barlow-SemiBold',
      fontWeight: 'normal',
    });
    expect(resolveFont(undefined, '600', fonts.display)?.fontFamily).toBe(
      'BarlowCondensed-SemiBold',
    );
  });

  it('leaves a family outside the theme alone', () => {
    expect(resolveFont('monospace', '400')).toBeNull();
  });
});
