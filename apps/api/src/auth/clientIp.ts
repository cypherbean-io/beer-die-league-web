import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { rateLimitAddress } from './rateLimit.ts';

// The socket peer, or behind a trusted proxy the address it appended to X-Forwarded-For,
// as the per-address limits count it. Only the last entry is the proxy's; any before it
// came from the client.
export function clientIp(c: Context, trustProxy: boolean): string {
  const forwarded = trustProxy
    ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
    : undefined;
  const address = forwarded && isIP(forwarded) ? forwarded : getConnInfo(c).remote.address;
  return address ? rateLimitAddress(address) : 'unknown';
}
