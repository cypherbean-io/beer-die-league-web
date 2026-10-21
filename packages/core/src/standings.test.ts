import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDINGS_CONFIG, type StandingsConfig, type StandingsMetric } from './schemas.ts';
import { rankStandings, type StandingsGame, type StandingsTeam } from './standings.ts';

const team = (name: string): StandingsTeam => ({ id: `team-${name.toLowerCase()}`, name });

const aces = team('Aces');
const bears = team('Bears');
const cats = team('Cats');
const dukes = team('Dukes');
const eels = team('Eels');
const foxes = team('Foxes');

// `winner` beat `loser` by the given score, with no sinks unless stated.
function beat(
  winner: StandingsTeam,
  loser: StandingsTeam,
  [wp, lp]: [number, number] = [11, 9],
  [ws, ls]: [number, number] = [0, 0],
): StandingsGame {
  return {
    winner: { teamId: winner.id, points: wp, sinks: ws },
    loser: { teamId: loser.id, points: lp, sinks: ls },
  };
}

const config = (patch: Partial<StandingsConfig> = {}): StandingsConfig => ({
  ...DEFAULT_STANDINGS_CONFIG,
  ...patch,
});

// The table as the Standings screen shows it: rank label, then team name.
function table(teams: StandingsTeam[], games: StandingsGame[], c = config()) {
  return rankStandings(teams, games, c).map((row) => [
    row.rank === null ? '–' : row.tied ? `T-${row.rank}` : String(row.rank),
    row.team.name,
  ]);
}

describe('rankStandings', () => {
  it("totals each team's games, record, points for and against, and sinks", () => {
    const [row] = rankStandings(
      [aces, bears],
      [beat(aces, bears, [11, 9], [1, 0]), beat(bears, aces, [12, 10], [2, 1])],
      config(),
    ).filter((r) => r.team.id === aces.id);

    expect(row).toEqual({
      team: aces,
      rank: 1,
      tied: true,
      gamesPlayed: 2,
      wins: 1,
      losses: 1,
      winPct: 0.5,
      pointsFor: 21,
      pointsAgainst: 21,
      pointDiff: 0,
      sinks: 2,
    });
  });

  it('sorts by the primary metric, win% by default', () => {
    const games = [beat(cats, aces), beat(cats, bears), beat(bears, aces)];

    expect(table([aces, bears, cats], games)).toEqual([
      ['1', 'Cats'],
      ['2', 'Bears'],
      ['3', 'Aces'],
    ]);
  });

  it('compares win% exactly, so 2 of 3 ties with 4 of 6', () => {
    const games = [
      ...[beat(aces, eels), beat(aces, eels), beat(eels, aces)],
      ...[beat(bears, foxes), beat(bears, foxes), beat(foxes, bears)],
      ...[beat(bears, foxes), beat(bears, foxes), beat(foxes, bears)],
    ];

    const rows = rankStandings([aces, bears, eels, foxes], games, config({ order: ['win_pct'] }));

    expect(rows.slice(0, 2).map((r) => [r.team.name, r.rank, r.tied])).toEqual([
      ['Aces', 1, true],
      ['Bears', 1, true],
    ]);
  });

  // In each case Bears lead Aces on the metric alone. Ties go by name, so a metric that
  // weren't applied would put Aces first.
  it.each<[StandingsMetric, string, StandingsGame[]]>([
    ['win_pct', 'Bears 1–0, Aces 1–1', [beat(bears, dukes), beat(aces, dukes), beat(dukes, aces)]],
    [
      'wins',
      'Bears 2–2, Aces 1–0',
      [
        beat(bears, dukes),
        beat(bears, dukes),
        beat(dukes, bears),
        beat(eels, bears),
        beat(aces, dukes),
      ],
    ],
    ['point_diff', 'Bears +11, Aces +2', [beat(bears, dukes, [11, 0]), beat(aces, dukes, [11, 9])]],
    ['points_for', 'Bears 13, Aces 11', [beat(bears, dukes, [13, 11]), beat(aces, dukes, [11, 0])]],
    ['sinks', 'Bears 2, Aces 0', [beat(bears, dukes, [11, 9], [2, 0]), beat(aces, dukes, [11, 9])]],
  ])('ranks by %s alone (%s)', (metric, _lines, games) => {
    const rows = rankStandings([aces, bears, dukes, eels], games, config({ order: [metric] }));

    expect(rows.slice(0, 2).map((r) => r.team.name)).toEqual(['Bears', 'Aces']);
  });

  it('breaks a two-way tie on win% by head-to-head before point difference', () => {
    // Aces and Bears are both 1–1; Aces beat Bears, though Bears have the better difference.
    const games = [beat(aces, bears, [11, 9]), beat(bears, cats, [11, 0]), beat(dukes, aces)];

    expect(table([aces, bears, cats, dukes], games)).toEqual([
      ['1', 'Dukes'],
      ['2', 'Aces'],
      ['3', 'Bears'],
      ['4', 'Cats'],
    ]);
  });

  it('uses only games among the tied teams in a three-way head-to-head', () => {
    // Aces, Bears, and Cats are all 2–2. Among themselves Aces went 2–0, Bears 1–1, and Cats
    // 0–2, but their games against Dukes and Eels reverse the point difference.
    const games = [
      beat(aces, bears),
      beat(aces, cats),
      beat(bears, cats),
      beat(dukes, aces, [11, 0]),
      beat(dukes, aces, [11, 0]),
      beat(dukes, bears, [11, 5]),
      beat(bears, eels, [11, 9]),
      beat(cats, eels, [11, 0]),
      beat(cats, eels, [11, 0]),
    ];

    expect(table([aces, bears, cats, dukes, eels], games)).toEqual([
      ['1', 'Dukes'],
      ['2', 'Aces'],
      ['3', 'Bears'],
      ['4', 'Cats'],
      ['5', 'Eels'],
    ]);
  });

  it('skips head-to-head when the tied teams never played each other', () => {
    // Aces and Bears are both 1–0, as Cats and Dukes are both 0–1; the difference decides.
    const games = [beat(aces, cats, [11, 9]), beat(bears, dukes, [11, 0])];

    expect(table([aces, bears, cats, dukes], games)).toEqual([
      ['1', 'Bears'],
      ['2', 'Aces'],
      ['3', 'Cats'],
      ['4', 'Dukes'],
    ]);
  });

  it('skips head-to-head when one of the tied teams played none of the others', () => {
    // Aces, Bears, Cats, and Dukes are all 1–1. Aces, Bears, and Dukes played each other, but
    // Cats only played Eels and Foxes, so head-to-head can't place Cats; the difference decides.
    const games = [
      beat(aces, bears, [11, 9]),
      beat(bears, dukes, [11, 5]),
      beat(dukes, aces, [11, 9]),
      beat(cats, eels, [11, 0]),
      beat(foxes, cats, [11, 9]),
    ];

    expect(table([aces, bears, cats, dukes, eels, foxes], games)).toEqual([
      ['1', 'Foxes'],
      ['2', 'Cats'],
      ['3', 'Bears'],
      ['4', 'Aces'],
      ['5', 'Dukes'],
      ['6', 'Eels'],
    ]);
  });

  it('lists teams below the minimum games after the ranked ones, unranked, by name', () => {
    const games = [beat(dukes, cats), beat(dukes, aces), beat(bears, cats)];

    expect(table([dukes, cats, bears, aces], games, config({ minGames: 2 }))).toEqual([
      ['1', 'Dukes'],
      ['2', 'Cats'],
      ['–', 'Aces'],
      ['–', 'Bears'],
    ]);
  });

  it('never ranks a team with no games, even with no minimum', () => {
    const rows = rankStandings([aces, bears, cats], [beat(bears, cats)], config({ minGames: 0 }));

    expect(rows.map((r) => [r.team.name, r.rank, r.tied, r.winPct])).toEqual([
      ['Bears', 1, false, 1],
      ['Cats', 2, false, 0],
      ['Aces', null, false, null],
    ]);
  });

  it('gives teams tied on every metric one shared rank, by name, and skips the ranks they fill', () => {
    // Identical lines everywhere: Aces and Bears each won 11–9, and Cats and Dukes each lost.
    const games = [beat(bears, dukes), beat(aces, cats), beat(eels, foxes, [11, 0])];

    expect(table([foxes, eels, dukes, cats, bears, aces], games)).toEqual([
      ['1', 'Eels'],
      ['T-2', 'Aces'],
      ['T-2', 'Bears'],
      ['T-4', 'Cats'],
      ['T-4', 'Dukes'],
      ['6', 'Foxes'],
    ]);
  });

  it('orders tied names ignoring case', () => {
    const lower = team('aardvarks');
    const games = [beat(bears, cats), beat(lower, dukes)];

    expect(table([bears, lower, cats, dukes], games).slice(0, 2)).toEqual([
      ['T-1', 'aardvarks'],
      ['T-1', 'Bears'],
    ]);
  });

  it('changes the ranking under a custom order', () => {
    // Aces won more games; Bears have the better win%.
    const games = [beat(aces, cats), beat(aces, cats), beat(cats, aces), beat(bears, cats)];

    expect(table([aces, bears, cats], games)).toEqual([
      ['1', 'Bears'],
      ['2', 'Aces'],
      ['3', 'Cats'],
    ]);
    expect(table([aces, bears, cats], games, config({ order: ['wins', 'win_pct'] }))).toEqual([
      ['1', 'Aces'],
      ['2', 'Bears'],
      ['3', 'Cats'],
    ]);
  });

  it('refuses a game naming a team it was not given', () => {
    expect(() => rankStandings([aces], [beat(aces, bears)], config())).toThrow(/unknown team/);
  });
});
