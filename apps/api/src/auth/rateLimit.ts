import { sql } from 'drizzle-orm';
import { hmacHex } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { rateLimits } from '../db/schema.ts';

export type RateLimitKind = 'email' | 'ip' | 'verify-email' | 'verify-ip' | 'join';

// The stored key is an HMAC, so neither the email nor the IP is kept in the clear.
export function rateLimitKey(secret: string, kind: RateLimitKind, value: string): string {
  return `${kind}:${hmacHex(secret, `rate-limit:${kind}:${value}`)}`;
}

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
