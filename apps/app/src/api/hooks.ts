import type { MeResponse, MyMembership, StatsScope } from '@beer-die/core';
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { browserStorage, clearAllDrafts } from '../drafts';
import { getMe, logout, logoutEverywhere } from './client';

// How long a screen's data is shown from cache before the next mount or window focus fetches
// it again. Our own writes don't wait for it (see the after…Write helpers below); it only
// delays seeing what other members did.
export const STALE_TIME_MS = 30_000;

// Writes go out even while the browser reports being offline, so a failed submit fails at
// once and the form offers Retry, rather than queueing a resend nobody pressed.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: STALE_TIME_MS },
      mutations: { networkMode: 'always' },
    },
  });
}

// Every key the cache is read or invalidated by. A key that ends at the league id is also the
// prefix of the more specific keys under the same name, so invalidating it reaches them all.
export const queryKeys = {
  me: ['me'],
  health: ['health'],
  league: (leagueId: string) => ['league', leagueId],
  members: (leagueId: string) => ['members', leagueId],
  invites: (leagueId: string) => ['invites', leagueId],
  audit: (leagueId: string) => ['audit', leagueId],
  seasons: (leagueId: string) => ['seasons', leagueId],
  teams: (leagueId: string, seasonId: string | undefined) => ['teams', leagueId, seasonId],
  standings: (leagueId: string) => ['standings', leagueId],
  seasonStandings: (leagueId: string, seasonId: string | undefined) => [
    'standings',
    leagueId,
    seasonId,
  ],
  inbox: (leagueId: string) => ['inbox', leagueId],
  games: (leagueId: string) => ['games', leagueId],
  gameList: (leagueId: string, awaiting?: 'override') => ['games', leagueId, awaiting ?? 'all'],
  game: (leagueId: string, gameId: string) => ['game', leagueId, gameId],
  // The copy of a game a correction form holds. It is under its own name so that nothing
  // which refreshes the game changes the numbers under the player.
  correction: (leagueId: string, gameId: string) => ['correction', leagueId, gameId],
  stats: (leagueId: string) => ['stats', leagueId],
  playerStats: (leagueId: string, scope: StatsScope) => ['stats', leagueId, 'players', scope],
  partnershipStats: (leagueId: string, scope: StatsScope) => [
    'stats',
    leagueId,
    'partnerships',
    scope,
  ],
  playerProfile: (leagueId: string, membershipId: string, scope: StatsScope) => [
    'stats',
    leagueId,
    'player',
    membershipId,
    scope,
  ],
} as const;

function invalidate(queryClient: QueryClient, keys: ReadonlyArray<readonly unknown[]>) {
  return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

// After any write to a game (submit, correct, confirm, force-confirm, override decision),
// whether it succeeded or was refused: a refusal can mean the game just expired. Any of them
// can complete or expire the game, which changes stats and standings and can finalize its
// season, and the commissioner's ones are recorded in the league log.
export function afterGameWrite(queryClient: QueryClient, leagueId: string, gameId: string) {
  return invalidate(queryClient, [
    queryKeys.game(leagueId, gameId),
    queryKeys.inbox(leagueId),
    queryKeys.games(leagueId),
    queryKeys.stats(leagueId),
    queryKeys.standings(leagueId),
    queryKeys.seasons(leagueId),
    queryKeys.audit(leagueId),
  ]);
}

// After a season is created, started, ended, or its standings settings change. Standings
// carry their season's status and are ranked by its settings.
export function afterSeasonWrite(queryClient: QueryClient, leagueId: string) {
  return invalidate(queryClient, [
    queryKeys.seasons(leagueId),
    queryKeys.standings(leagueId),
    queryKeys.audit(leagueId),
  ]);
}

// After any write to a season's teams. Standings list the approved ones.
export function afterTeamWrite(queryClient: QueryClient, leagueId: string, seasonId: string) {
  return invalidate(queryClient, [
    queryKeys.teams(leagueId, seasonId),
    queryKeys.standings(leagueId),
    queryKeys.audit(leagueId),
  ]);
}

// After a member is approved or rejected or changes role. A role change can be the caller's
// own, which /me reflects. A removal or leaving voids games and changes teams, so those
// refetch everything instead.
export function afterMemberWrite(queryClient: QueryClient, leagueId: string) {
  return invalidate(queryClient, [
    queryKeys.members(leagueId),
    queryKeys.me,
    queryKeys.audit(leagueId),
  ]);
}

// Loads /me from the server after a write that changed it (signing in, joining a league),
// whatever is cached: a signed-out answer from a moment ago would otherwise still be fresh.
export function refreshMe(queryClient: QueryClient): Promise<MeResponse | null> {
  return queryClient.fetchQuery({ queryKey: queryKeys.me, queryFn: getMe, staleTime: 0 });
}

// Null when signed out.
export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: getMe });
}

// The v1 UI shows the caller's first league (SPEC §3.2).
export function currentMembership(me: MeResponse | null | undefined): MyMembership | undefined {
  return me?.memberships[0];
}

// Signed out, the device keeps nothing of the caller's: cached data and game drafts go too.
export function forgetSession(queryClient: QueryClient): void {
  clearAllDrafts(browserStorage());
  queryClient.clear();
  queryClient.setQueryData(queryKeys.me, null);
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: logout, onSuccess: () => forgetSession(queryClient) });
}

// Ends every session of mine, on every device, this one included.
export function useSignOutEverywhere() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logoutEverywhere,
    onSuccess: () => forgetSession(queryClient),
  });
}
