import type { StandingsRow, Team, TeamStatus } from '@beer-die/core';
import { describe, expect, it } from 'vitest';
import { myStanding } from './standings';

const SEASON = '0199f3a2-5c1e-7a00-8000-000000000100';
const ANA = '0199f3a2-5c1e-7a00-8000-00000000000a';
const BO = '0199f3a2-5c1e-7a00-8000-00000000000b';
const CY = '0199f3a2-5c1e-7a00-8000-00000000000c';
const DI = '0199f3a2-5c1e-7a00-8000-00000000000d';
const ED = '0199f3a2-5c1e-7a00-8000-00000000000e';
const SHARKS = '0199f3a2-5c1e-7a00-8000-000000000201';
const JETS = '0199f3a2-5c1e-7a00-8000-000000000202';
const OLD_SHARKS = '0199f3a2-5c1e-7a00-8000-000000000203';

const team = (id: string, name: string, players: string[], status: TeamStatus): Team => ({
  id,
  seasonId: SEASON,
  name,
  status,
  proposedBy: players[0]!,
  players: players.map((membershipId) => ({ membershipId, displayName: 'x', former: false })),
  createdAt: '2026-11-01T00:00:00.000Z',
});

const row = (id: string, name: string, rank: number | null): StandingsRow => ({
  team: { id, name },
  rank,
  tied: false,
  gamesPlayed: 3,
  wins: 2,
  losses: 1,
  winPct: 2 / 3,
  pointsFor: 30,
  pointsAgainst: 25,
  pointDiff: 5,
  sinks: 1,
});

const teams = [
  team(OLD_SHARKS, 'Old Sharks', [ANA, ED], 'withdrawn'),
  team(SHARKS, 'Sharks', [ANA, BO], 'approved'),
  team(JETS, 'Jets', [CY, DI], 'approved'),
];
const standings = [row(JETS, 'Jets', 1), row(SHARKS, 'Sharks', null)];

describe('myStanding', () => {
  it('finds the standings line of the team the member plays on', () => {
    expect(myStanding(teams, standings, CY)?.team.name).toBe('Jets');
  });

  it('includes a team that has no rank yet', () => {
    expect(myStanding(teams, standings, BO)?.team.name).toBe('Sharks');
  });

  it('ignores a team the member is on that was never approved', () => {
    expect(myStanding(teams, standings, ED)).toBeNull();
  });

  it('is null for a member on no team', () => {
    expect(myStanding(teams, standings, '0199f3a2-5c1e-7a00-8000-0000000000ff')).toBeNull();
  });
});
