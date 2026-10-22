// A record-game form in progress, kept on the device so a reload or a failed submit doesn't
// lose it. Its idempotency key and play time are fixed when the form opens, so submitting it
// again, after a reload too, resends the same game, which the server records at most once.
// Pure TypeScript behind a Storage interface: localStorage on the web, memory elsewhere.

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type Side = 'A' | 'B';

// Seats 0 and 1 are side A; seats 2 and 3 are side B. Seat 0 is the draft's owner.
export type DraftSeat = { membershipId: string | null; points: number; sinks: number };

export type GameDraft = {
  idempotencyKey: string;
  playedAt: string;
  kind: 'season' | 'exhibition';
  // The opposing team of a season game, once chosen.
  opponentId: string | null;
  seats: DraftSeat[];
  winner: Side | null;
  // Set once a submit has been tried, so the form still offers Retry after a reload.
  attempted: boolean;
};

export type DraftStore = {
  load(): GameDraft | null;
  save(draft: GameDraft): void;
  clear(): void;
};

// One entry holds every member's draft on this device, by membership id.
const STORAGE_KEY = 'beerdie:drafts';
const MAX_LINE_VALUE = 99;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function memoryStorage(): DraftStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

// The browser's localStorage when there is one; otherwise (native, or a browser that blocks
// storage, where even reading the property can throw) drafts last while the app runs.
export function browserStorage(
  scope: { readonly localStorage?: DraftStorage } = globalThis as { localStorage?: DraftStorage },
): DraftStorage {
  try {
    if (scope.localStorage) return scope.localStorage;
  } catch {
    // Storage is blocked.
  }
  return memoryStorage();
}

export function newDraft(
  ownerId: string,
  { makeKey = () => crypto.randomUUID(), now = new Date() } = {},
): GameDraft {
  const empty = { membershipId: null, points: 0, sinks: 0 };
  return {
    idempotencyKey: makeKey(),
    playedAt: now.toISOString(),
    kind: 'exhibition',
    opponentId: null,
    seats: [{ membershipId: ownerId, points: 0, sinks: 0 }, empty, empty, empty],
    winner: null,
    attempted: false,
  };
}

// A form as it opened has nothing worth keeping, and keeping it would fix an old play time on
// a game recorded later.
function untouched(draft: GameDraft): boolean {
  return (
    !draft.attempted &&
    draft.kind === 'exhibition' &&
    draft.winner === null &&
    draft.seats.every((s, i) => (i === 0 || s.membershipId === null) && !s.points && !s.sinks)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLineValue = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LINE_VALUE;

const isSeat = (value: unknown): value is DraftSeat =>
  isRecord(value) &&
  (value.membershipId === null ||
    (typeof value.membershipId === 'string' && UUID.test(value.membershipId))) &&
  isLineValue(value.points) &&
  isLineValue(value.sinks);

// Stored drafts are checked rather than trusted: storage outlives app versions and can be
// edited by hand. Anything malformed is dropped.
function isDraftOf(ownerId: string, value: unknown): value is GameDraft {
  return (
    isRecord(value) &&
    typeof value.idempotencyKey === 'string' &&
    UUID.test(value.idempotencyKey) &&
    typeof value.playedAt === 'string' &&
    !Number.isNaN(Date.parse(value.playedAt)) &&
    (value.kind === 'season' || value.kind === 'exhibition') &&
    (value.opponentId === null || typeof value.opponentId === 'string') &&
    Array.isArray(value.seats) &&
    value.seats.length === 4 &&
    value.seats.every(isSeat) &&
    (value.seats[0] as DraftSeat).membershipId === ownerId &&
    (value.winner === null || value.winner === 'A' || value.winner === 'B') &&
    typeof value.attempted === 'boolean'
  );
}

// Drafts are best effort: a device that refuses to store one (private mode, a full quota)
// still lets the form work for as long as it stays open.
function readAll(storage: DraftStorage): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(storage: DraftStorage, drafts: Record<string, unknown>): void {
  try {
    if (Object.keys(drafts).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Kept in the form's own state only.
  }
}

// The draft of one member, so members sharing a device never see each other's.
export function draftStore(storage: DraftStorage, membershipId: string): DraftStore {
  const clear = () => {
    const drafts = readAll(storage);
    delete drafts[membershipId];
    writeAll(storage, drafts);
  };
  return {
    load() {
      const draft = readAll(storage)[membershipId];
      return isDraftOf(membershipId, draft) ? draft : null;
    },
    save(draft) {
      if (untouched(draft)) return clear();
      writeAll(storage, { ...readAll(storage), [membershipId]: draft });
    },
    clear,
  };
}

// Signing out or deleting the account forgets every draft on the device.
export function clearAllDrafts(storage: DraftStorage): void {
  writeAll(storage, {});
}

// Sends the draft and clears it once the server has recorded the game. A failure keeps it,
// marked as tried, so a retry (after a reload too) resends the same idempotency key.
export async function submitDraft<T>(
  store: DraftStore,
  draft: GameDraft,
  send: (draft: GameDraft) => Promise<T>,
): Promise<T> {
  store.save({ ...draft, attempted: true });
  const result = await send(draft);
  store.clear();
  return result;
}
