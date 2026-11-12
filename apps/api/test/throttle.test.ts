import { describe, expect, it } from 'vitest';
import { createThrottle, DEFAULT_LIMITS } from '../src/auth/throttle.ts';

const MINUTE_MS = 60_000;

// A throttle on a clock the test moves.
function throttleAt(start: number, opts: { maxKeys?: number } = {}) {
  const time = { ms: start };
  const throttle = createThrottle({ ...opts, nowMs: () => time.ms });
  return { throttle, time };
}

function spend(throttle: ReturnType<typeof createThrottle>, key: string, n: number): void {
  for (let i = 0; i < n; i++) expect(throttle.check('auth-ip', key)).toBe(0);
}

describe('the in-memory request throttle', () => {
  it('allows a key exactly its limit of requests in a minute', () => {
    const { throttle } = throttleAt(0);

    spend(throttle, 'a', DEFAULT_LIMITS['auth-ip']);

    expect(throttle.check('auth-ip', 'a')).toBeGreaterThan(0);
  });

  it('reports the seconds left in the window when it refuses', () => {
    const { throttle, time } = throttleAt(0);
    spend(throttle, 'a', DEFAULT_LIMITS['auth-ip']);
    time.ms = 15_500;

    expect(throttle.check('auth-ip', 'a')).toBe(45);
  });

  it('allows requests again once the minute has passed', () => {
    const { throttle, time } = throttleAt(0);
    spend(throttle, 'a', DEFAULT_LIMITS['auth-ip']);
    time.ms = MINUTE_MS;

    expect(throttle.check('auth-ip', 'a')).toBe(0);
  });

  it('counts each key separately', () => {
    const { throttle } = throttleAt(0);
    spend(throttle, 'a', DEFAULT_LIMITS['auth-ip']);

    expect(throttle.check('auth-ip', 'b')).toBe(0);
  });

  it('counts each bucket separately for one key', () => {
    const { throttle } = throttleAt(0);
    spend(throttle, 'a', DEFAULT_LIMITS['auth-ip']);

    expect(throttle.check('ip', 'a')).toBe(0);
  });

  it('keeps refusing a key that keeps asking, until its window ends', () => {
    const { throttle, time } = throttleAt(0);
    spend(throttle, 'a', DEFAULT_LIMITS['auth-ip']);
    time.ms = MINUTE_MS - 1;

    expect(throttle.check('auth-ip', 'a')).toBe(1);
  });

  it('never tracks more keys than its bound', () => {
    const { throttle } = throttleAt(0, { maxKeys: 3 });

    for (let i = 0; i < 10; i++) throttle.check('ip', `key-${i}`);

    expect(throttle.size()).toBe(3);
  });

  it('forgets finished windows before live ones when it is full', () => {
    const { throttle, time } = throttleAt(0, { maxKeys: 2 });
    throttle.check('ip', 'old');
    time.ms = MINUTE_MS;
    spend(throttle, 'live', DEFAULT_LIMITS['auth-ip']);

    throttle.check('ip', 'new');

    expect(throttle.check('auth-ip', 'live')).toBeGreaterThan(0);
  });
});
