import type { Game, GameRevision } from '@beer-die/core';

type Side = 'A' | 'B';

// What a correction changed against the revision before it.
export type RevisionChange =
  | { kind: 'playedAt'; from: string; to: string }
  | { kind: 'winner'; from: Side; to: Side }
  | { kind: 'side'; name: string; from: Side; to: Side }
  | { kind: 'line'; name: string; field: 'points' | 'sinks'; from: number; to: number }
  | { kind: 'left'; name: string; side: Side }
  | { kind: 'joined'; name: string; side: Side; points: number; sinks: number };

// The play time and winner first, then each earlier player in order, then anyone new.
export function diffRevisions(before: GameRevision, after: GameRevision): RevisionChange[] {
  const changes: RevisionChange[] = [];
  if (before.playedAt !== after.playedAt) {
    changes.push({ kind: 'playedAt', from: before.playedAt, to: after.playedAt });
  }
  if (before.winner !== after.winner) {
    changes.push({ kind: 'winner', from: before.winner, to: after.winner });
  }
  for (const was of before.players) {
    const now = after.players.find((p) => p.membershipId === was.membershipId);
    const name = now?.displayName ?? was.displayName;
    if (!now) {
      changes.push({ kind: 'left', name, side: was.side });
      continue;
    }
    if (was.side !== now.side) changes.push({ kind: 'side', name, from: was.side, to: now.side });
    for (const field of ['points', 'sinks'] as const) {
      if (was[field] !== now[field]) {
        changes.push({ kind: 'line', name, field, from: was[field], to: now[field] });
      }
    }
  }
  for (const p of after.players) {
    if (!before.players.some((was) => was.membershipId === p.membershipId)) {
      changes.push({
        kind: 'joined',
        name: p.displayName,
        side: p.side,
        points: p.points,
        sinks: p.sinks,
      });
    }
  }
  return changes;
}

export function describeChange(change: RevisionChange, formatTime: (iso: string) => string) {
  switch (change.kind) {
    case 'playedAt':
      return `Played: ${formatTime(change.from)} → ${formatTime(change.to)}`;
    case 'winner':
      return `Winner: side ${change.from} → side ${change.to}`;
    case 'side':
      return `${change.name} moved from side ${change.from} to side ${change.to}`;
    case 'line':
      return `${change.name}: ${change.from} → ${change.to} ${change.field}`;
    case 'left':
      return `${change.name} no longer plays (was side ${change.side})`;
    case 'joined':
      return `${change.name} joins side ${change.side}: ${change.points} points, ${change.sinks} sinks`;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

// How long a confirmation window has left, to the two largest units.
export function timeLeft(expiresAt: string, now: Date): string {
  const ms = Date.parse(expiresAt) - now.getTime();
  if (ms <= 0) return 'Closed';
  if (ms < MINUTE) return 'Less than a minute left';
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const parts =
    days > 0
      ? [count(days, 'day'), hours > 0 ? count(hours, 'hour') : '']
      : hours > 0
        ? [count(hours, 'hour'), minutes > 0 ? count(minutes, 'minute') : '']
        : [count(minutes, 'minute')];
  return `${parts.filter(Boolean).join(' ')} left`;
}

// What to tell a player who has just confirmed revision `revisionId`, from the game the server
// sent back: whether it counts now, and if not, what does meanwhile.
export function confirmNotice(game: Game, revisionId: string): string {
  if (game.confirmedRevision?.id === revisionId) {
    return 'Confirmed. All four players have confirmed, so the game now counts.';
  }
  if (game.confirmedRevision !== null) {
    return 'Confirmed. The counted result keeps counting until all four players confirm the correction.';
  }
  return 'Confirmed. The game counts once all four players confirm it.';
}

// Whether the game form offers sending a complete result for a commissioner's review: when it
// breaks the rules as the app knows them, or when the server, whose rules may have changed
// since, refused it for breaking them (`errorCode` is the last attempt's).
export function offersReview(
  complete: boolean,
  violationCount: number,
  errorCode: string | undefined,
): boolean {
  return complete && (violationCount > 0 || errorCode === 'RULES_VIOLATION');
}

// A member's name as a game, stat line, or roster shows it, marked once they have left the
// league.
export function playerName(player: { displayName: string; former: boolean }): string {
  return player.former ? `${player.displayName} (former member)` : player.displayName;
}
