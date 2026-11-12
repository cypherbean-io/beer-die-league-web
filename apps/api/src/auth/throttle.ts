// General request throttling, counted in this process's memory so that refusing a request
// costs no database work. It bounds how fast one client can drive the API; the limits that
// must hold exactly and survive a restart (sign-in codes, joins, game writes) are the
// database-backed ones in rateLimit.ts. Counters are per API process: they reset when it
// restarts, and would each count separately if more than one ran.

const WINDOW_MS = 60_000;

// Requests a minute.
export type ThrottleLimits = {
  // Everything from one address. Generous, because a whole league can share one.
  ip: number;
  // Everything under /api/auth from one address: the routes that work without a session.
  'auth-ip': number;
  // Everything from one signed-in user, across their sessions.
  user: number;
  // One user's stats and standings reads, which aggregate over the league's games.
  'stats-user': number;
};
export type ThrottleBucket = keyof ThrottleLimits;

export const DEFAULT_LIMITS: ThrottleLimits = {
  ip: 1200,
  'auth-ip': 30,
  user: 300,
  'stats-user': 60,
};

export type Throttle = {
  // Counts one request. Returns 0 when it is within the bucket's limit, otherwise the whole
  // seconds until the key's window ends.
  check(bucket: ThrottleBucket, key: string): number;
  // How many windows are tracked.
  size(): number;
};

// Fixed one-minute windows, each starting at a key's first request. Time comes from a
// monotonic clock, so a wall-clock step can't reopen or extend a window. At most `maxKeys`
// windows are kept: finished ones are dropped first, then the oldest, so a client would have
// to arrive from that many addresses to reset its own count.
export function createThrottle({
  limits = DEFAULT_LIMITS,
  nowMs = () => performance.now(),
  maxKeys = 100_000,
}: { limits?: ThrottleLimits; nowMs?: () => number; maxKeys?: number } = {}): Throttle {
  // In order of window start: a restarted window is re-inserted at the end.
  const windows = new Map<string, { start: number; count: number }>();

  function makeRoom(now: number): void {
    for (const [id, window] of windows) {
      if (now - window.start < WINDOW_MS && windows.size < maxKeys) break;
      windows.delete(id);
    }
  }

  return {
    check(bucket, key) {
      const now = nowMs();
      const id = `${bucket}:${key}`;
      let window = windows.get(id);
      if (!window || now - window.start >= WINDOW_MS) {
        windows.delete(id);
        if (windows.size >= maxKeys) makeRoom(now);
        window = { start: now, count: 0 };
        windows.set(id, window);
      }
      window.count += 1;
      if (window.count <= limits[bucket]) return 0;
      return Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000));
    },
    size: () => windows.size,
  };
}
