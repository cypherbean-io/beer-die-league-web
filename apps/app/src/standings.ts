import type { StandingsMetric, StandingsRow } from '@beer-die/core';

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
