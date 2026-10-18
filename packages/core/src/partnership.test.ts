import { describe, expect, it } from 'vitest';
import { pairKey } from './partnership.ts';

// UUIDv7s minted a moment apart, so `ana` sorts before `bo`.
const ana = '0199f3a2-5c1e-7a00-8000-00000000000a';
const bo = '0199f3a2-5c1e-7a00-8000-00000000000b';
const cy = '0199f3a2-5c1f-7a00-8000-00000000000c';

describe('pairKey', () => {
  it('is the two membership ids in sorted order', () => {
    expect(pairKey(ana, bo)).toBe(`${ana}:${bo}`);
  });

  it('is the same whichever partner comes first', () => {
    expect(pairKey(bo, ana)).toBe(pairKey(ana, bo));
  });

  it('tells pairs that share a player apart', () => {
    expect(new Set([pairKey(ana, bo), pairKey(ana, cy), pairKey(bo, cy)]).size).toBe(3);
  });
});
