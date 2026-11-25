import type { StandingsMetric, StandingsRow, Team } from '@beer-die/core';

export const METRIC_LABELS: Record<StandingsMetric, string> = {
  win_pct: 'Win %',
  wins: 'Wins',
  point_diff: 'Point difference',
  points_for: 'Points for',
  sinks: 'Sinks',
  head_to_head: 'Head-to-head',
};

export const describeOrder = (order: StandingsMetric[]) =>
  order.map((metric) => METRIC_LABELS[metric]).join(', ');

// "1", or "T-2" for teams sharing a rank; a dash for a team without one.
export const rankLabel = (row: StandingsRow) =>
  row.rank === null ? '–' : row.tied ? `T-${row.rank}` : String(row.rank);

// The standings line of the approved team `membershipId` plays on in the season, or null when
// they play on none. Only approved teams have a line.
export function myStanding(
  teams: Team[],
  standings: StandingsRow[],
  membershipId: string,
): StandingsRow | null {
  const mine = teams.find(
    (t) => t.status === 'approved' && t.players.some((p) => p.membershipId === membershipId),
  );
  return (mine && standings.find((r) => r.team.id === mine.id)) ?? null;
}
