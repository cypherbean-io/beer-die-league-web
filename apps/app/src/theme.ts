// The Night Game theme: a dark scoreboard look with one lime accent. Every screen takes its
// colours, type and spacing from here rather than hard-coding them.

export const colors = {
  bg: '#0B0D10',
  surface: '#15181D',
  raised: '#1D2127',
  // Decorative lines: card edges and row dividers.
  border: '#262B33',
  divider: '#22262D',
  // Edges that must stay visible against the background, such as text inputs (3:1).
  borderStrong: '#6B7380',
  text: '#F2F4F7',
  // Secondary text, also legible on `surface`.
  muted: '#9AA3AF',
  accent: '#C6F432',
  // Text on an accent fill.
  onAccent: '#0B0D10',
  danger: '#FF7A70',
  notice: '#7EE2A8',
  // The losing side's score: only ever large numerals.
  loser: '#6B7380',
} as const;

// The bundled font files, one per weight, each loaded under its own family name (`src/fonts.ts`).
export type FontFile =
  | 'Barlow-Regular'
  | 'Barlow-Medium'
  | 'Barlow-SemiBold'
  | 'Barlow-Bold'
  | 'BarlowCondensed-SemiBold'
  | 'BarlowCondensed-Bold';

// The two families a style may name. `resolveFont` turns one plus a weight into a loaded file.
export const fonts = { body: 'Barlow', display: 'BarlowCondensed' } as const;
export type Family = (typeof fonts)[keyof typeof fonts];

const isFamily = (name: unknown): name is Family => name === fonts.body || name === fonts.display;

const weightOf = (weight: unknown): number => {
  if (weight === 'bold') return 700;
  const n = Number(weight);
  return Number.isFinite(n) && n > 0 ? n : 400;
};

// The file that renders `family` at `weight`, rounded to the nearest one bundled. Condensed is
// bundled only at 600 and 700, since it's for headings and numerals.
export function fontFile(family: Family, weight: unknown): FontFile {
  const w = weightOf(weight);
  if (family === fonts.display) {
    return w >= 650 ? 'BarlowCondensed-Bold' : 'BarlowCondensed-SemiBold';
  }
  if (w >= 650) return 'Barlow-Bold';
  if (w >= 550) return 'Barlow-SemiBold';
  if (w >= 450) return 'Barlow-Medium';
  return 'Barlow-Regular';
}

// The font style for text whose own style names `fontFamily` and `fontWeight` (either may be
// missing, inheriting `inherited`). Each weight is a separate family, so the weight itself is
// reset to normal rather than synthesized on top. A family outside the theme, such as
// 'monospace', is left alone.
export function resolveFont(
  fontFamily: unknown,
  fontWeight: unknown,
  inherited: Family = fonts.body,
): { fontFamily: string; fontWeight: 'normal' } | null {
  if (fontFamily !== undefined && !isFamily(fontFamily)) return null;
  const family = isFamily(fontFamily) ? fontFamily : inherited;
  return { fontFamily: fontFile(family, fontWeight), fontWeight: 'normal' };
}

// A family as a style value, for components that don't go through the themed `Text`, such as
// `Link` and navigation headers.
export const font = (family: Family, weight: number) => ({
  fontFamily: fontFile(family, weight),
});

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;
export const radius = { sm: 8, md: 14, lg: 20, pill: 999 } as const;

// The widest a screen's content runs on a large window.
export const maxWidth = { narrow: 420, normal: 560, wide: 720 } as const;

// WCAG 2 contrast ratio between two `#rrggbb` colours, from 1 to 21.
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, bl] = channels.map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    ) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
