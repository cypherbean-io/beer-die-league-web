// Periodic sweep: drains the email outbox and materializes game expiry. Season finalization
// and purges join it in later slices. Correctness never depends on this process running.
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { sweepExpired } from './domain/games.ts';
import { safeErrorFields, stdoutLog as log } from './log.ts';
import { drainOutbox } from './mail/outbox.ts';
import { createSmtpTransport } from './mail/transport.ts';

const TICK_MS = 2000;
const EXPIRY_SWEEP_MS = 60_000;

const config = loadConfig(process.env);
const { db, close } = createDb(config.databaseUrl);
const transport = createSmtpTransport(config.smtpUrl);

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let current: Promise<void> = Promise.resolve();
// Monotonic, so a wall-clock step can't stall or rush the sweep.
let nextExpirySweep = 0;

// Every 60 s, or on the next tick while a backlog remains.
async function sweepExpiry(): Promise<void> {
  if (performance.now() < nextExpirySweep) return;
  nextExpirySweep = performance.now() + EXPIRY_SWEEP_MS;
  try {
    const { expired, done } = await sweepExpired({ db, clock: systemClock });
    if (expired > 0) log({ level: 'info', msg: 'expiry sweep', expired });
    if (!done) nextExpirySweep = 0;
  } catch (err) {
    log({ level: 'error', msg: 'expiry sweep failed', ...safeErrorFields(err) });
  }
}

// The outbox drains first, and each sweep is bounded, so mail such as sign-in codes waits
// behind at most one budget of expiry work, never a whole backlog.
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
  await sweepExpiry();
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
