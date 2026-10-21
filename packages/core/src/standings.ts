import {
  nameKey,
  type StandingsConfig,
  type StandingsMetric,
  type StandingsRow,
} from './schemas.ts';

export type StandingsTeam = { id: string; name: string };

// One team's side of a counted game: its players' points (sink points included) and sinks.
export type TeamLine = { teamId: string; points: number; sinks: number };

export type StandingsGame = { winner: TeamLine; loser: TeamLine };

type Totals = {
  team: StandingsTeam;
  gamesPlayed: number;
  wins: number;
  pointsFor: number;
  pointsAgainst: number;
  sinks: number;
};

// Negative when `a` ranks ahead of `b`, like any sort comparator.
type Compare = (a: Totals, b: Totals) => number;

// Win% compared by cross-multiplying, so 2 of 3 ties with 4 of 6 exactly. Both teams have
// played at least once.
const byRate = (aWins: number, aGames: number, bWins: number, bGames: number) =>
  bWins * aGames - aWins * bGames;

const pointDiff = (t: Totals) => t.pointsFor - t.pointsAgainst;

const COMPARE: Record<Exclude<StandingsMetric, 'head_to_head'>, Compare> = {
  win_pct: (a, b) => byRate(a.wins, a.gamesPlayed, b.wins, b.gamesPlayed),
  wins: (a, b) => b.wins - a.wins,
  point_diff: (a, b) => pointDiff(b) - pointDiff(a),
  points_for: (a, b) => b.pointsFor - a.pointsFor,
  sinks: (a, b) => b.sinks - a.sinks,
};

const byName: Compare = (a, b) => {
  const [x, y] = [nameKey(a.team.name), nameKey(b.team.name)];
  if (x !== y) return x < y ? -1 : 1;
  return a.team.id < b.team.id ? -1 : a.team.id > b.team.id ? 1 : 0;
};

// Win% in the games the tied teams played against each other, and nothing else. It can't
// place a team that played none of the others, so unless every team has such a game it
// doesn't apply (null), and the next metric decides. That covers the case where none of them
// played each other.
function headToHead(group: Totals[], games: StandingsGame[]): Compare | null {
  const record = new Map(group.map((t) => [t.team.id, { wins: 0, games: 0 }]));
  for (const { winner, loser } of games) {
    const w = record.get(winner.teamId);
    const l = record.get(loser.teamId);
    if (!w || !l) continue;
    w.wins += 1;
    w.games += 1;
    l.games += 1;
  }
  if ([...record.values()].some((r) => r.games === 0)) return null;
  return (a, b) => {
    const x = record.get(a.team.id)!;
    const y = record.get(b.team.id)!;
    return byRate(x.wins, x.games, y.wins, y.games);
  };
}

// Splits a group of teams tied so far into runs still tied after each remaining metric, best
// first. A run that comes out of the whole order is a tie.
function separate(group: Totals[], order: StandingsMetric[], games: StandingsGame[]): Totals[][] {
  const [metric, ...rest] = order;
  if (group.length < 2 || metric === undefined) return [group];
  const compare = metric === 'head_to_head' ? headToHead(group, games) : COMPARE[metric];
  if (!compare) return separate(group, rest, games);

  const sorted = [...group].sort(compare);
  const runs: Totals[][] = [];
  for (const team of sorted) {
    const run = runs.at(-1);
    if (run && compare(run[0]!, team) === 0) run.push(team);
    else runs.push([team]);
  }
  return runs.flatMap((run) => separate(run, rest, games));
}

function toRow(t: Totals, rank: number | null, tied: boolean): StandingsRow {
  return {
    team: t.team,
    rank,
    tied,
    gamesPlayed: t.gamesPlayed,
    wins: t.wins,
    losses: t.gamesPlayed - t.wins,
    winPct: t.gamesPlayed === 0 ? null : t.wins / t.gamesPlayed,
    pointsFor: t.pointsFor,
    pointsAgainst: t.pointsAgainst,
    pointDiff: pointDiff(t),
    sinks: t.sinks,
  };
}

// A season's standings (SPEC §3.7) from its teams and the counted games between them. Teams
// are ranked by each metric of the order in turn, each one only separating teams the ones
// before it left tied. Teams still tied after the whole order share a rank, and the next
// rank skips the places they fill (1, T-2, T-2, 4). A team with no games, or fewer than
// `minGames`, is listed after the ranked teams, unranked. Ties and unranked teams go by name.
export function rankStandings(
  teams: StandingsTeam[],
  games: StandingsGame[],
  config: StandingsConfig,
): StandingsRow[] {
  const totals = new Map<string, Totals>(
    teams.map((team) => [
      team.id,
      { team, gamesPlayed: 0, wins: 0, pointsFor: 0, pointsAgainst: 0, sinks: 0 },
    ]),
  );
  const totalsOf = (teamId: string) => {
    const t = totals.get(teamId);
    if (!t) throw new Error(`a standings game names an unknown team: ${teamId}`);
    return t;
  };
  for (const { winner, loser } of games) {
    for (const [line, against, won] of [
      [winner, loser, true],
      [loser, winner, false],
    ] as const) {
      const t = totalsOf(line.teamId);
      t.gamesPlayed += 1;
      if (won) t.wins += 1;
      t.pointsFor += line.points;
      t.pointsAgainst += against.points;
      t.sinks += line.sinks;
    }
  }

  const all = [...totals.values()];
  const ranked = (t: Totals) => t.gamesPlayed > 0 && t.gamesPlayed >= config.minGames;
  const rows: StandingsRow[] = [];
  for (const run of separate(all.filter(ranked), config.order, games)) {
    const rank = rows.length + 1;
    for (const t of run.sort(byName)) rows.push(toRow(t, rank, run.length > 1));
  }
  for (const t of all.filter((t) => !ranked(t)).sort(byName)) rows.push(toRow(t, null, false));
  return rows;
}
