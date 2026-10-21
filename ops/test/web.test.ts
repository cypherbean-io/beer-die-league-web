import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { compose, ORIGIN, request } from './stack.ts';

// SPEC §4: same-origin only, inline styles for react-native-web, never framed.
const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const CODE_REQUESTS_PER_IP = 20;

describe.each(['/', '/api/health'])('security headers on %s', (path) => {
  it('sets the Content-Security-Policy', async () => {
    expect((await request(path)).headers['content-security-policy']).toBe(CSP);
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    expect((await request(path)).headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets Referrer-Policy: no-referrer, so invite tokens never leak in a Referer', async () => {
    expect((await request(path)).headers['referrer-policy']).toBe('no-referrer');
  });

  it('sends no HSTS for localhost, which would pin every local dev server to HTTPS', async () => {
    expect((await request(path)).headers['strict-transport-security']).toBeUndefined();
  });
});

describe('the web app', () => {
  it('serves the exported app shell at /', async () => {
    const res = await request('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('<div id="root"></div>');
  });

  it('serves the app shell for a client-side route such as an invite link', async () => {
    const [shell, route] = await Promise.all([request('/'), request('/invite/abc')]);

    expect(route.status).toBe(200);
    expect(route.body).toBe(shell.body);
  });

  it('serves every script the shell loads as JavaScript, as nosniff requires', async () => {
    const shell = await request('/');
    const scripts = [...shell.body.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]!);

    const replies = await Promise.all(scripts.map((src) => request(src)));

    expect(scripts.length).toBeGreaterThan(0);
    for (const res of replies) {
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/javascript/);
    }
  });

  it('redirects plain HTTP to HTTPS', async () => {
    const res = await request('http://localhost/standings');

    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`${ORIGIN}/standings`);
  });
});

describe('the API behind Caddy', () => {
  it('is served on the same origin under /api', async () => {
    const res = await request('/api/health');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('answers an unknown /api path itself, rather than with the app shell', async () => {
    const res = await request('/api/no-such-route');

    expect(res.status).toBe(404);
    expect(res.body).not.toContain('<div id="root">');
  });

  it('never logs a token from the path, in Caddy or in the API', async () => {
    const token = randomBytes(24).toString('base64url');
    await request(`/invite/${token}`);
    await request(`/api/invites/${token}`);

    const logs = await compose('logs', '--no-log-prefix', 'web', 'api');

    expect(logs).not.toContain(token);
  });
});

describe('client addresses behind Caddy', () => {
  // Without one, Docker relays IPv6 clients through docker-proxy, so Caddy would see them all
  // as the bridge gateway and they would share one rate-limit bucket. External IPv6 can't be
  // tested here; this checks what Docker needs to forward them with their own address.
  it('puts Caddy on an IPv6-enabled network', async () => {
    // /proc/net/if_inet6: address, interface index, prefix length, scope (00 is global).
    const lines = (await compose('exec', '-T', 'web', 'cat', '/proc/net/if_inet6')).trim();
    const scopes = lines.split('\n').map((line) => line.trim().split(/\s+/)[3]);

    expect(scopes).toContain('00');
  });

  // The budget this spends is the host's, which a reviewer's browser shares.
  afterAll(async () => {
    await compose(
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'postgres',
      '-d',
      'beerdie',
      '-c',
      "delete from rate_limits where key like 'ip:%'",
    );
  });

  it('ignores a spoofed X-Forwarded-For, so it cannot dodge the per-address code limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= CODE_REQUESTS_PER_IP; i++) {
      const res = await request('/api/auth/code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-forwarded-for': `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({ email: `spoof-${randomUUID()}@example.com` }),
      });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });
});

describe('when the API is down', () => {
  it('logs neither the path nor the client address of the request that failed', async () => {
    const token = randomBytes(24).toString('base64url');
    await compose('stop', 'api');
    let status: number;
    try {
      status = (await request(`/api/invites/${token}`)).status;
    } finally {
      // The same container, so it keeps the throwaway secrets scripts/stack.ts gave it.
      await compose('up', '-d', '--wait', '--no-deps', '--no-recreate', 'api');
    }

    const logs = await compose('logs', '--no-log-prefix', 'web');

    expect(status).toBe(502);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('remote_ip');
  });
});
