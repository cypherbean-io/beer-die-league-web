import { isIPv6 } from 'node:net';
import { sql } from 'drizzle-orm';
import { hmacHex } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { rateLimits } from '../db/schema.ts';

export type RateLimitKind =
  | 'email'
  | 'ip'
  | 'verify-email'
  | 'verify-ip'
  | 'join'
  | 'game-write'
  | 'season-create'
  | 'team-propose';

// The eight 16-bit groups of a valid IPv6 address, `::` and a dotted IPv4 tail expanded.
function ipv6Groups(ip: string): number[] {
  const parse = (part: string | undefined): number[] =>
    part
      ? part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [parseInt(group, 16)];
          const [a, b, c, d] = group.split('.').map(Number) as [number, number, number, number];
          return [(a << 8) | b, (c << 8) | d];
        })
      : [];
  const [head, tail] = ip.split('::');
  const before = parse(head);
  if (tail === undefined) return before;
  const after = parse(tail);
  return [...before, ...new Array<number>(8 - before.length - after.length).fill(0), ...after];
}

// The address a per-address limit counts. One subscriber usually holds a whole IPv6 /64, so
// counting single addresses would let them rotate past the limit; an IPv4-mapped address
// counts as its IPv4 address.
export function rateLimitAddress(ip: string): string {
  const bare = ip.split('%')[0]!;
  if (!isIPv6(bare)) return ip;
  const g = ipv6Groups(bare);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join('.');
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

// The stored key is an HMAC, so neither the email nor the IP is kept in the clear.
export function rateLimitKey(secret: string, kind: RateLimitKind, value: string): string {
  return `${kind}:${hmacHex(secret, `rate-limit:${kind}:${value}`)}`;
}

// The longest window any limit may use. The worker deletes windows older than this
// (domain/purge.ts), so a longer one would be forgotten early.
export const RATE_LIMIT_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

// Records one hit and reports whether it is within `limit` for the current window. The
// window starts at the first hit and resets once it is `windowMs` old. A single upsert, so
// concurrent hits are all counted.
export async function hit(
  db: Db,
  key: string,
  limit: number,
  windowMs: number,
  now: Date,
): Promise<boolean> {
  if (windowMs > RATE_LIMIT_MAX_WINDOW_MS) {
    throw new RangeError('A rate-limit window may be at most RATE_LIMIT_MAX_WINDOW_MS');
  }
  const stale = sql`${rateLimits.windowStart} <= ${new Date(now.getTime() - windowMs).toISOString()}::timestamptz`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        windowStart: sql`case when ${stale} then ${now.toISOString()}::timestamptz else ${rateLimits.windowStart} end`,
        count: sql`case when ${stale} then 1 else ${rateLimits.count} + 1 end`,
      },
    })
    .returning({ count: rateLimits.count });
  return row !== undefined && row.count <= limit;
}
