import type { Game, GamePlayer, GameRevision } from '@beer-die/core';
import { describe, expect, it } from 'vitest';
import {
  confirmNotice,
  describeChange,
  diffRevisions,
  offersReview,
  playerName,
  timeLeft,
} from './gameText';

const ANA = '0199f3a2-5c1e-7a00-8000-00000000000a';
const BO = '0199f3a2-5c1e-7a00-8000-00000000000b';
const CY = '0199f3a2-5c1e-7a00-8000-00000000000c';
const DI = '0199f3a2-5c1e-7a00-8000-00000000000d';
const ED = '0199f3a2-5c1e-7a00-8000-00000000000e';

const player = (
  membershipId: string,
  displayName: string,
  side: 'A' | 'B',
  points: number,
  sinks = 0,
): GamePlayer => ({
  membershipId,
  displayName,
  former: false,
  side,
  points,
  sinks,
  isSub: false,
  confirmation: null,
});

// Ana and Bo beat Cy and Di 11–9.
function revision(patch: Partial<GameRevision> = {}): GameRevision {
  return {
    id: '0199f3a2-5c1e-7a00-8000-0000000000a1',
    number: 1,
    status: 'superseded',
    createdBy: ANA,
    playedAt: '2026-10-18T11:30:00.000Z',
    winner: 'A',
    players: [
      player(ANA, 'Ana', 'A', 6),
      player(BO, 'Bo', 'A', 5),
      player(CY, 'Cy', 'B', 5),
      player(DI, 'Di', 'B', 4),
    ],
    ruleViolations: [],
    overrideStatus: null,
    teams: null,
    ...patch,
  };
}

describe('diffRevisions', () => {
  it('finds nothing between identical revisions', () => {
    expect(diffRevisions(revision(), revision({ number: 2 }))).toEqual([]);
  });

  it("lists each player's changed points and sinks", () => {
    const next = revision({
      players: [
        player(ANA, 'Ana', 'A', 6),
        player(BO, 'Bo', 'A', 5, 1),
        player(CY, 'Cy', 'B', 5),
        player(DI, 'Di', 'B', 3),
      ],
    });

    expect(diffRevisions(revision(), next)).toEqual([
      { kind: 'line', name: 'Bo', field: 'sinks', from: 0, to: 1 },
      { kind: 'line', name: 'Di', field: 'points', from: 4, to: 3 },
    ]);
  });

  it('notes a changed winner and play time', () => {
    const next = revision({ winner: 'B', playedAt: '2026-10-18T10:30:00.000Z' });

    expect(diffRevisions(revision(), next)).toEqual([
      { kind: 'playedAt', from: '2026-10-18T11:30:00.000Z', to: '2026-10-18T10:30:00.000Z' },
      { kind: 'winner', from: 'A', to: 'B' },
    ]);
  });

  it('notes a player who moved sides, joined, or left', () => {
    const next = revision({
      players: [
        player(ANA, 'Ana', 'A', 6),
        player(CY, 'Cy', 'A', 5),
        player(BO, 'Bo', 'B', 5),
        player(ED, 'Ed', 'B', 4),
      ],
    });

    expect(diffRevisions(revision(), next)).toEqual([
      { kind: 'side', name: 'Bo', from: 'A', to: 'B' },
      { kind: 'side', name: 'Cy', from: 'B', to: 'A' },
      { kind: 'left', name: 'Di', side: 'B' },
      { kind: 'joined', name: 'Ed', side: 'B', points: 4, sinks: 0 },
    ]);
  });
});

describe('describeChange', () => {
  const at = (iso: string) => iso.slice(11, 16);

  it.each([
    [{ kind: 'line', name: 'Di', field: 'points', from: 4, to: 3 }, 'Di: 4 → 3 points'],
    [{ kind: 'line', name: 'Bo', field: 'sinks', from: 0, to: 1 }, 'Bo: 0 → 1 sinks'],
    [{ kind: 'winner', from: 'A', to: 'B' }, 'Winner: side A → side B'],
    [
      { kind: 'playedAt', from: '2026-10-18T11:30:00.000Z', to: '2026-10-18T10:30:00.000Z' },
      'Played: 11:30 → 10:30',
    ],
    [{ kind: 'side', name: 'Bo', from: 'A', to: 'B' }, 'Bo moved from side A to side B'],
    [{ kind: 'left', name: 'Di', side: 'B' }, 'Di no longer plays (was side B)'],
    [
      { kind: 'joined', name: 'Ed', side: 'B', points: 4, sinks: 1 },
      'Ed joins side B: 4 points, 1 sinks',
    ],
  ] as const)('describes %j', (change, text) => {
    expect(describeChange(change, at)).toBe(text);
  });
});

describe('timeLeft', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const later = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it.each([
    [7 * DAY, '7 days left'],
    [DAY + 3 * HOUR + 59 * MINUTE, '1 day 3 hours left'],
    [DAY, '1 day left'],
    [2 * HOUR + 5 * MINUTE, '2 hours 5 minutes left'],
    [HOUR, '1 hour left'],
    [59 * MINUTE + 59_000, '59 minutes left'],
    [MINUTE, '1 minute left'],
    [59_000, 'Less than a minute left'],
    [0, 'Closed'],
    [-HOUR, 'Closed'],
  ])('shows %i ms as %j', (ms, text) => {
    expect(timeLeft(later(ms), now)).toBe(text);
  });
});

// An exhibition game with the given revisions, pending unless one has confirmed.
function game(open: GameRevision | null, confirmed: GameRevision | null): Game {
  return {
    id: '0199f3a2-5c1e-7a00-8000-0000000000f1',
    kind: 'exhibition',
    seasonId: null,
    status: confirmed ? 'confirmed' : 'pending',
    rulesSnapshot: { targetScore: 11, winBy: 2, sinkPoints: 0, sinkEndsGame: false },
    windowExpiresAt: open ? '2026-10-25T12:00:00.000Z' : null,
    openRevision: open,
    confirmedRevision: confirmed,
  };
}

describe('confirmNotice', () => {
  const first = revision({ status: 'open' });
  const correction = revision({ id: '0199f3a2-5c1e-7a00-8000-0000000000a2', number: 2 });

  it('says the game now counts once the revision confirmed is the one counting', () => {
    const counted = game(null, { ...first, status: 'confirmed' });

    expect(confirmNotice(counted, first.id)).toBe(
      'Confirmed. All four players have confirmed, so the game now counts.',
    );
  });

  it('says the game counts once all four confirm while the others have yet to', () => {
    expect(confirmNotice(game(first, null), first.id)).toBe(
      'Confirmed. The game counts once all four players confirm it.',
    );
  });

  it('says the counted result stands until all four confirm a correction of a confirmed game', () => {
    const reopened = game({ ...correction, status: 'open' }, { ...first, status: 'confirmed' });

    expect(confirmNotice(reopened, correction.id)).toBe(
      'Confirmed. The counted result keeps counting until all four players confirm the correction.',
    );
  });
});

describe('offersReview', () => {
  it('offers a review of a complete result that breaks the rules the app knows', () => {
    expect(offersReview(true, 1, undefined)).toBe(true);
  });

  it('offers a review of a complete result the server refused for breaking its rules', () => {
    expect(offersReview(true, 0, 'RULES_VIOLATION')).toBe(true);
  });

  it('offers no review of a result that breaks no rules', () => {
    expect(offersReview(true, 0, undefined)).toBe(false);
    expect(offersReview(true, 0, 'STALE_REVISION')).toBe(false);
  });

  it('offers no review of an incomplete result', () => {
    expect(offersReview(false, 1, 'RULES_VIOLATION')).toBe(false);
  });
});

describe('playerName', () => {
  it('marks a former member', () => {
    expect(playerName({ displayName: 'Bo', former: true })).toBe('Bo (former member)');
  });

  it("leaves a member's name as it is", () => {
    expect(playerName({ displayName: 'Bo', former: false })).toBe('Bo');
  });
});
