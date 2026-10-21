import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const base = {
  DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/beerdie',
  AUTH_SECRET: 'a'.repeat(32),
  APP_ORIGIN: 'https://league.example',
  MAIL_FROM: 'League <league@league.example>',
};

describe('loadConfig SMTP_URL', () => {
  it('refuses a remote SMTP server that may silently skip TLS', () => {
    expect(() =>
      loadConfig({ ...base, SMTP_URL: 'smtp://user:hunter22@mail.example:587' }),
    ).toThrow(/SMTP_URL/);
  });

  it('never echoes the SMTP_URL value, which carries credentials, in its error', () => {
    expect(() =>
      loadConfig({ ...base, SMTP_URL: 'smtp://user:hunter22@mail.example:587' }),
    ).not.toThrow(/hunter22|mail\.example/);
  });

  it.each([
    ['implicit TLS', 'smtps://user:pw@mail.example:465'],
    ['required STARTTLS', 'smtp://user:pw@mail.example:587?requireTLS=true'],
    ['an explicit plaintext opt-out', 'smtp://mailpit:1025?ignoreTLS=true'],
    ['a loopback server', 'smtp://127.0.0.1:1025'],
    ['localhost', 'smtp://localhost:1025'],
  ])('accepts %s', (_label, url) => {
    expect(loadConfig({ ...base, SMTP_URL: url }).smtpUrl).toBe(url);
  });
});

describe('loadConfig TRUST_PROXY', () => {
  const env = { ...base, SMTP_URL: 'smtp://127.0.0.1:1025' };

  it('trusts no proxy header unless TRUST_PROXY is set', () => {
    expect(loadConfig(env).trustProxy).toBe(false);
  });

  it('trusts the proxy-appended X-Forwarded-For when TRUST_PROXY=true', () => {
    expect(loadConfig({ ...env, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('rejects a TRUST_PROXY value other than true or false', () => {
    expect(() => loadConfig({ ...env, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });
});
