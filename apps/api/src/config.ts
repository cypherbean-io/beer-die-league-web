import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Sign-in codes travel by mail, so a remote SMTP server must use TLS. Plain `smtp://` only
// upgrades if the server offers STARTTLS, and a network attacker can strip that offer.
// `ignoreTLS=true` is an explicit plaintext opt-out, e.g. for Mailpit inside Compose.
function smtpTlsEnforced(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const flag = (name: string) => url.searchParams.get(name) === 'true';
  return (
    url.protocol === 'smtps:' ||
    (url.protocol === 'smtp:' &&
      (flag('requireTLS') || flag('ignoreTLS') || LOOPBACK_HOSTS.has(url.hostname)))
  );
}

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  APP_ORIGIN: z.url(),
  SMTP_URL: z
    .string()
    .refine(
      smtpTlsEnforced,
      'must be smtps://, set requireTLS=true, point at loopback, or opt out with ignoreTLS=true',
    ),
  MAIL_FROM: z.string().min(1),
});

export type Config = {
  databaseUrl: string;
  authSecret: string;
  appOrigin: string;
  smtpUrl: string;
  mailFrom: string;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Name each variable and the rule it broke, never its value (SMTP_URL holds credentials).
    const problems = parsed.error.issues.map(
      (issue) => `${String(issue.path[0])}: ${issue.message}`,
    );
    throw new Error(`Invalid or missing environment variables: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    authSecret: e.AUTH_SECRET,
    appOrigin: new URL(e.APP_ORIGIN).origin,
    smtpUrl: e.SMTP_URL,
    mailFrom: e.MAIL_FROM,
  };
}
