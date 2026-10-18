// Periodic sweep. For now it only drains the email outbox; expiry, season finalization, and
// purges join it in later slices. Correctness never depends on this process running.
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { safeErrorFields, stdoutLog as log } from './log.ts';
import { drainOutbox } from './mail/outbox.ts';
import { createSmtpTransport } from './mail/transport.ts';

const TICK_MS = 2000;

const config = loadConfig(process.env);
const { db, close } = createDb(config.databaseUrl);
const transport = createSmtpTransport(config.smtpUrl);

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let current: Promise<void> = Promise.resolve();

async function tick(): Promise<void> {
  try {
    await drainOutbox({
      db,
      clock: systemClock,
      transport,
      mailFrom: config.mailFrom,
      authSecret: config.authSecret,
      log,
    });
  } catch (err) {
    log({ level: 'error', msg: 'outbox drain failed', ...safeErrorFields(err) });
  }
}

function schedule(): void {
  timer = setTimeout(() => {
    current = tick().then(() => {
      if (!stopping) schedule();
    });
  }, TICK_MS);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
    clearTimeout(timer);
    void current.finally(() => close());
  });
}

log({ level: 'info', msg: 'worker started' });
schedule();
