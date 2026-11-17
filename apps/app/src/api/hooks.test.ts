import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  afterGameWrite,
  afterMemberWrite,
  afterSeasonWrite,
  afterTeamWrite,
  createQueryClient,
  queryKeys,
  refreshMe,
  STALE_TIME_MS,
} from './hooks';

const LEAGUE = '0199f3a2-5c1e-7a00-8000-0000000000a1';
const OTHER_LEAGUE = '0199f3a2-5c1e-7a00-8000-0000000000a2';
const GAME = '0199f3a2-5c1e-7a00-8000-0000000000b1';
const OTHER_GAME = '0199f3a2-5c1e-7a00-8000-0000000000b2';
const SEASON = '0199f3a2-5c1e-7a00-8000-0000000000c1';
const OTHER_SEASON = '0199f3a2-5c1e-7a00-8000-0000000000c2';
const PLAYER = '0199f3a2-5c1e-7a00-8000-0000000000d1';
const USER = '0199f3a2-5c1e-7a00-8000-0000000000e1';
const OPENED = new Date('2026-11-15T12:00:00.000Z');

// Everything a signed-in member's screens can have cached for one league.
function leagueKeys(leagueId: string): QueryKey[] {
  return [
    queryKeys.league(leagueId),
    queryKeys.members(leagueId),
    queryKeys.invites(leagueId),
    queryKeys.audit(leagueId),
    queryKeys.seasons(leagueId),
    queryKeys.teams(leagueId, SEASON),
    queryKeys.teams(leagueId, OTHER_SEASON),
    queryKeys.seasonStandings(leagueId, SEASON),
    queryKeys.inbox(leagueId),
    queryKeys.gameList(leagueId),
    queryKeys.gameList(leagueId, 'override'),
    queryKeys.game(leagueId, GAME),
    queryKeys.game(leagueId, OTHER_GAME),
    queryKeys.correction(leagueId, GAME),
    queryKeys.playerStats(leagueId, 'combined'),
    queryKeys.partnershipStats(leagueId, 'combined'),
    queryKeys.playerProfile(leagueId, PLAYER, 'combined'),
  ];
}

const sorted = (keys: QueryKey[]) => keys.map((key) => JSON.stringify(key)).sort();

// The cached entries a write marked stale.
function staleKeys(client: QueryClient): string[] {
  return sorted(
    client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.isInvalidated)
      .map((query) => query.queryKey),
  );
}

let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(OPENED);
  client = createQueryClient();
  for (const key of [
    queryKeys.me,
    queryKeys.health,
    ...leagueKeys(LEAGUE),
    ...leagueKeys(OTHER_LEAGUE),
  ]) {
    client.setQueryData(key, 'cached');
  }
});

afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a game write', () => {
  it('marks the game, inbox, game lists, stats, standings, seasons, and league log stale', async () => {
    await afterGameWrite(client, LEAGUE, GAME);

    expect(staleKeys(client)).toEqual(
      sorted([
        queryKeys.game(LEAGUE, GAME),
        queryKeys.inbox(LEAGUE),
        queryKeys.gameList(LEAGUE),
        queryKeys.gameList(LEAGUE, 'override'),
        queryKeys.playerStats(LEAGUE, 'combined'),
        queryKeys.partnershipStats(LEAGUE, 'combined'),
        queryKeys.playerProfile(LEAGUE, PLAYER, 'combined'),
        queryKeys.seasonStandings(LEAGUE, SEASON),
        queryKeys.seasons(LEAGUE),
        queryKeys.audit(LEAGUE),
      ]),
    );
  });

  it('leaves the numbers a correction form holds as they were loaded', async () => {
    await afterGameWrite(client, LEAGUE, GAME);

    expect(client.getQueryState(queryKeys.correction(LEAGUE, GAME))?.isInvalidated).toBe(false);
  });

  it('leaves another league’s cache alone', async () => {
    await afterGameWrite(client, LEAGUE, GAME);

    const others = sorted(leagueKeys(OTHER_LEAGUE));
    expect(staleKeys(client).filter((key) => others.includes(key))).toEqual([]);
  });
});

describe('a season write', () => {
  it('marks the seasons, standings, and league log stale', async () => {
    await afterSeasonWrite(client, LEAGUE);

    expect(staleKeys(client)).toEqual(
      sorted([
        queryKeys.seasons(LEAGUE),
        queryKeys.seasonStandings(LEAGUE, SEASON),
        queryKeys.audit(LEAGUE),
      ]),
    );
  });
});

describe('a team write', () => {
  it('marks that season’s teams, the standings, and the league log stale', async () => {
    await afterTeamWrite(client, LEAGUE, SEASON);

    expect(staleKeys(client)).toEqual(
      sorted([
        queryKeys.teams(LEAGUE, SEASON),
        queryKeys.seasonStandings(LEAGUE, SEASON),
        queryKeys.audit(LEAGUE),
      ]),
    );
  });
});

describe('a member write', () => {
  it('marks the members, the caller’s own memberships, and the league log stale', async () => {
    await afterMemberWrite(client, LEAGUE);

    expect(staleKeys(client)).toEqual(
      sorted([queryKeys.members(LEAGUE), queryKeys.me, queryKeys.audit(LEAGUE)]),
    );
  });
});

describe('the app’s query client', () => {
  // Stands in for the network: counts the requests a screen's query would send.
  function countingFetch() {
    let requests = 0;
    return {
      queryFn: () => Promise.resolve(++requests),
      get requests() {
        return requests;
      },
    };
  }

  it('serves a screen from cache while its data is fresh', async () => {
    const network = countingFetch();
    const query = { queryKey: queryKeys.seasons(LEAGUE), queryFn: network.queryFn };
    client.removeQueries({ queryKey: query.queryKey });

    await client.fetchQuery(query);
    vi.setSystemTime(OPENED.getTime() + STALE_TIME_MS - 1);
    await client.fetchQuery(query);

    expect(network.requests).toBe(1);
  });

  it('fetches again once the data has gone stale', async () => {
    const network = countingFetch();
    const query = { queryKey: queryKeys.seasons(LEAGUE), queryFn: network.queryFn };
    client.removeQueries({ queryKey: query.queryKey });

    await client.fetchQuery(query);
    vi.setSystemTime(OPENED.getTime() + STALE_TIME_MS);
    await client.fetchQuery(query);

    expect(network.requests).toBe(2);
  });

  it('fetches fresh data again right after a write that changed it', async () => {
    const network = countingFetch();
    const query = { queryKey: queryKeys.inbox(LEAGUE), queryFn: network.queryFn };
    client.removeQueries({ queryKey: query.queryKey });

    await client.fetchQuery(query);
    await afterGameWrite(client, LEAGUE, GAME);
    await client.fetchQuery(query);

    expect(network.requests).toBe(2);
  });
});

describe('refreshing /me after signing in', () => {
  it('asks the server even when a fresh signed-out answer is cached', async () => {
    client.setQueryData(queryKeys.me, null);
    const me = { user: { id: USER, email: 'ana@example.test' }, memberships: [] };
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(me)));

    expect(await refreshMe(client)).toEqual(me);
  });
});
