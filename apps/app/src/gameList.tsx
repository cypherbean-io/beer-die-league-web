import { useInfiniteQuery } from '@tanstack/react-query';
import { StyleSheet } from 'react-native';
import { listGames } from './api/client';
import { queryKeys } from './api/hooks';
import { GameRow } from './game';
import { Button, Text } from './ui';
import { colors } from './theme';

// A league's games, newest first, a page at a time.
export function GameList({
  leagueId,
  awaiting,
  empty,
}: {
  leagueId: string;
  awaiting?: 'override';
  empty: string;
}) {
  const games = useInfiniteQuery({
    queryKey: queryKeys.gameList(leagueId, awaiting),
    queryFn: ({ pageParam }) =>
      listGames(leagueId, {
        ...(pageParam && { before: pageParam }),
        ...(awaiting && { awaiting }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  const all = games.data?.pages.flatMap((page) => page.games) ?? [];

  return (
    <>
      {games.isError && (
        <Text style={styles.error}>
          Couldn’t load the games. Check your connection and try again.
        </Text>
      )}
      {games.isSuccess && all.length === 0 && (
        <Text testID="games-empty" style={styles.muted}>
          {empty}
        </Text>
      )}
      {all.map((game) => (
        <GameRow key={game.id} game={game} />
      ))}
      {games.hasNextPage && (
        <Button
          testID="games-more"
          label={games.isFetchingNextPage ? 'Loading…' : 'Show older games'}
          variant="secondary"
          disabled={games.isFetchingNextPage}
          onPress={() => void games.fetchNextPage()}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.muted },
  error: { color: colors.danger },
});
