import { describe, expect, it } from 'vitest';
import {
  browserStorage,
  clearAllDrafts,
  type DraftStorage,
  draftStore,
  type GameDraft,
  memoryStorage,
  newDraft,
  submitDraft,
} from './drafts';

const ANA = '0199f3a2-5c1e-7a00-8000-00000000000a';
const BO = '0199f3a2-5c1e-7a00-8000-00000000000b';
const CY = '0199f3a2-5c1e-7a00-8000-00000000000c';
const KEY = '0199f3a2-5c1e-7a00-8000-0000000000ff';
const OPENED = new Date('2026-10-18T12:00:00.000Z');

// Ana's form after she has picked Bo and entered a few points.
function started(owner = ANA): GameDraft {
  const draft = newDraft(owner, { makeKey: () => KEY, now: OPENED });
  return {
    ...draft,
    seats: [
      { membershipId: owner, points: 6, sinks: 0 },
      { membershipId: BO, points: 5, sinks: 1 },
      { membershipId: null, points: 0, sinks: 0 },
      { membershipId: null, points: 0, sinks: 0 },
    ],
  };
}

const refused = () => Promise.reject(new Error('offline'));

describe('a new draft', () => {
  it('holds a fresh idempotency key and the time the form opened, with the owner in seat 1', () => {
    const draft = newDraft(ANA, { makeKey: () => KEY, now: OPENED });

    expect(draft).toEqual({
      idempotencyKey: KEY,
      playedAt: '2026-10-18T12:00:00.000Z',
      kind: 'exhibition',
      opponentId: null,
      seats: [
        { membershipId: ANA, points: 0, sinks: 0 },
        { membershipId: null, points: 0, sinks: 0 },
        { membershipId: null, points: 0, sinks: 0 },
        { membershipId: null, points: 0, sinks: 0 },
      ],
      winner: null,
      attempted: false,
    });
  });

  it('gets a different key each time a form opens', () => {
    expect(newDraft(ANA).idempotencyKey).not.toBe(newDraft(ANA).idempotencyKey);
  });
});

describe('the draft store', () => {
  it('keeps a draft across a reload', () => {
    const storage = memoryStorage();
    draftStore(storage, ANA).save(started());

    const reloaded = draftStore(storage, ANA);

    expect(reloaded.load()).toEqual(started());
  });

  it("doesn't keep a form nobody has touched", () => {
    const storage = memoryStorage();
    const store = draftStore(storage, ANA);
    store.save(started());

    store.save(newDraft(ANA));

    expect(store.load()).toBeNull();
  });

  it("keeps each member's draft apart", () => {
    const storage = memoryStorage();
    draftStore(storage, ANA).save(started(ANA));
    draftStore(storage, CY).save(started(CY));

    draftStore(storage, ANA).clear();

    expect(draftStore(storage, ANA).load()).toBeNull();
    expect(draftStore(storage, CY).load()).toEqual(started(CY));
  });

  it.each([
    ['text that is not JSON', '{'],
    ['a list', '[]'],
    ['a draft missing its key', JSON.stringify({ [ANA]: { ...started(), idempotencyKey: '' } })],
    ['a draft with three seats', JSON.stringify({ [ANA]: { ...started(), seats: [] } })],
    [
      'a draft with a negative score',
      JSON.stringify({
        [ANA]: {
          ...started(),
          seats: started().seats.map((s, i) => (i === 1 ? { ...s, points: -1 } : s)),
        },
      }),
    ],
    [
      'a draft with a fractional score',
      JSON.stringify({
        [ANA]: {
          ...started(),
          seats: started().seats.map((s, i) => (i === 1 ? { ...s, sinks: 0.5 } : s)),
        },
      }),
    ],
    ['a draft with an unknown kind', JSON.stringify({ [ANA]: { ...started(), kind: 'casual' } })],
    ['a draft with a bad play time', JSON.stringify({ [ANA]: { ...started(), playedAt: 'soon' } })],
    ['a draft with an unknown winner', JSON.stringify({ [ANA]: { ...started(), winner: 'C' } })],
    ['a draft where someone else sits first', JSON.stringify({ [ANA]: started(BO) })],
  ])('discards %s', (_label, stored) => {
    const storage = memoryStorage();
    storage.setItem('beerdie:drafts', stored);

    expect(draftStore(storage, ANA).load()).toBeNull();
  });

  it('still works when the device refuses to store anything', () => {
    const full: DraftStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    const store = draftStore(full, ANA);

    expect(() => store.save(started())).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it('forgets every draft on the device, for signing out', () => {
    const storage = memoryStorage();
    draftStore(storage, ANA).save(started(ANA));
    draftStore(storage, CY).save(started(CY));

    clearAllDrafts(storage);

    expect(draftStore(storage, ANA).load()).toBeNull();
    expect(draftStore(storage, CY).load()).toBeNull();
  });
});

describe('submitting a draft', () => {
  it('keeps the draft, marked as tried, after a failed submit', async () => {
    const storage = memoryStorage();
    const store = draftStore(storage, ANA);

    await expect(submitDraft(store, started(), refused)).rejects.toThrow('offline');

    expect(draftStore(storage, ANA).load()).toEqual({ ...started(), attempted: true });
  });

  it('resends the same idempotency key on every retry, after a reload too', async () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    const send = (draft: GameDraft) => {
      sent.push(draft.idempotencyKey);
      return Promise.reject(new Error('offline'));
    };

    await expect(submitDraft(draftStore(storage, ANA), started(), send)).rejects.toThrow();
    const reloaded = draftStore(storage, ANA);
    await expect(submitDraft(reloaded, reloaded.load()!, send)).rejects.toThrow();

    expect(sent).toEqual([KEY, KEY]);
  });

  it('clears the draft once the server has recorded the game', async () => {
    const storage = memoryStorage();
    const store = draftStore(storage, ANA);
    store.save(started());

    const result = await submitDraft(store, started(), () => Promise.resolve('recorded'));

    expect(result).toBe('recorded');
    expect(draftStore(storage, ANA).load()).toBeNull();
  });
});

describe('browser storage', () => {
  it("uses the browser's storage when it has one", () => {
    const backing = memoryStorage();

    browserStorage({ localStorage: backing }).setItem('k', 'v');

    expect(backing.getItem('k')).toBe('v');
  });

  it('falls back to memory where there is no browser storage', () => {
    const storage = browserStorage({});

    storage.setItem('k', 'v');

    expect(storage.getItem('k')).toBe('v');
  });

  it('falls back to memory where the browser blocks storage', () => {
    const blocked = {
      get localStorage(): DraftStorage {
        throw new Error('SecurityError');
      },
    };
    const storage = browserStorage(blocked);

    storage.setItem('k', 'v');

    expect(storage.getItem('k')).toBe('v');
  });
});
