// A partnership's identity (SPEC §3.7): its two membership ids in sorted order, so a pair is
// the same whichever partner is named first. The API lists a pair's players in this order.
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
