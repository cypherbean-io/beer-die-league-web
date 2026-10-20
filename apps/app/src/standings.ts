import type { StandingsMetric } from '@beer-die/core';

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
