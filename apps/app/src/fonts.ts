import barlowBold from '../assets/fonts/Barlow-Bold.ttf';
import barlowMedium from '../assets/fonts/Barlow-Medium.ttf';
import barlowRegular from '../assets/fonts/Barlow-Regular.ttf';
import barlowSemiBold from '../assets/fonts/Barlow-SemiBold.ttf';
import condensedBold from '../assets/fonts/BarlowCondensed-Bold.ttf';
import condensedSemiBold from '../assets/fonts/BarlowCondensed-SemiBold.ttf';
import type { FontFile } from './theme';

// Barlow and Barlow Condensed (SIL Open Font License, `assets/fonts/OFL.txt`), bundled so they
// are served from our own origin, which the CSP requires.
export const fontFiles: Record<FontFile, number> = {
  'Barlow-Regular': barlowRegular,
  'Barlow-Medium': barlowMedium,
  'Barlow-SemiBold': barlowSemiBold,
  'Barlow-Bold': barlowBold,
  'BarlowCondensed-SemiBold': condensedSemiBold,
  'BarlowCondensed-Bold': condensedBold,
};
