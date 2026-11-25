import { type Game, type GameRevision, INBOX_MAX, type MyMembership } from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { type ApiRequestError, confirmRevision, getInbox } from '../src/api/client';
import { afterGameWrite, currentMembership, queryKeys, useMe } from '../src/api/hooks';
import { isRefusal, kindLabel, refusalFor, RevisionView } from '../src/game';
import { confirmNotice } from '../src/gameText';
import { Button, Screen, Text, textStyles } from '../src/ui';
import { colors, font, fonts, space } from '../src/theme';

export default function Inbox() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <InboxList membership={membership} />;
}

function InboxList({ membership }: { membership: MyMembership }) {
  const { leagueId } = membership;
  const queryClient = useQueryClient();
  const inbox = useQuery({
    queryKey: queryKeys.inbox(leagueId),
    queryFn: () => getInbox(leagueId),
  });
  // Shown above the list, because the game it is about may have just left it.
  const [notice, setNotice] = useState<string | null>(null);

  const onConfirmed = (game: Game, revisionId: string) => {
    setNotice(confirmNotice(game, revisionId));
    void afterGameWrite(queryClient, leagueId, game.id);
  };
  const onRefused = (game: Game, error: ApiRequestError) => {
    setNotice(refusalFor(error));
    void afterGameWrite(queryClient, leagueId, game.id);
  };

  const games = inbox.data ?? [];
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Inbox' }} />
      <Text style={styles.muted}>
        Games you played in that are waiting for you to confirm the numbers.
      </Text>
      {notice !== null && (
        <Text testID="inbox-notice" style={styles.notice}>
          {notice}
        </Text>
      )}
      {inbox.isError && (
        <Text style={styles.error}>
          Couldn’t load your inbox. Check your connection and try again.
        </Text>
      )}
      {inbox.isSuccess && games.length === 0 && (
        <Text testID="inbox-empty" style={styles.muted}>
          Nothing to confirm.
        </Text>
      )}
      {games.length >= INBOX_MAX && (
        <Text style={styles.muted}>
          Showing the {INBOX_MAX} games whose windows close soonest. Confirm these to see more.
        </Text>
      )}
      {games.flatMap((game) =>
        game.openRevision
          ? [
              <PendingGame
                key={game.id}
                leagueId={leagueId}
                myId={membership.id}
                game={game}
                revision={game.openRevision}
                onConfirmed={onConfirmed}
                onRefused={onRefused}
              />,
            ]
          : [],
      )}
    </Screen>
  );
}

type PendingGameProps = {
  leagueId: string;
  myId: string;
  game: Game;
  revision: GameRevision;
  onConfirmed: (game: Game, revisionId: string) => void;
  onRefused: (game: Game, error: ApiRequestError) => void;
};

function PendingGame({ leagueId, myId, game, revision, onConfirmed, onRefused }: PendingGameProps) {
  const router = useRouter();
  // Sends the id of the revision rendered below, so a correction made meanwhile is refused
  // rather than confirmed unseen.
  const confirm = useMutation({
    mutationFn: () => confirmRevision(leagueId, game.id, revision.id),
    onSuccess: (confirmed) => onConfirmed(confirmed, revision.id),
    onError: (error) => {
      if (isRefusal(error)) onRefused(game, error);
    },
  });
  const author = revision.players.find((p) => p.membershipId === revision.createdBy);
  const authorName = author?.displayName ?? 'another player';
  // A reopened game: a correction of a result that counts, and keeps counting meanwhile.
  const reopened = game.confirmedRevision !== null;

  return (
    <View style={styles.game} testID="inbox-game">
      <View style={styles.gameHead}>
        <Text style={textStyles.kicker}>{kindLabel(game)}</Text>
        <Text style={styles.muted}>{new Date(revision.playedAt).toLocaleString()}</Text>
      </View>
      {revision.number > 1 && (
        <Text testID="inbox-corrected" style={styles.muted}>
          {reopened
            ? `${authorName} proposed a correction to this confirmed game. The confirmed result keeps counting until all four players confirm the correction.`
            : `Corrected by ${authorName}, so earlier confirmations were reset.`}
        </Text>
      )}
      <RevisionView revision={revision} myId={myId} idPrefix="inbox" />
      {game.windowExpiresAt !== null && (
        <Text style={styles.muted}>
          Confirm by {new Date(game.windowExpiresAt).toLocaleString()}, or{' '}
          {reopened ? 'the correction lapses and the confirmed result stands.' : 'it won’t count.'}
        </Text>
      )}
      <Button
        testID="confirm-game"
        label={confirm.isPending ? 'Confirming…' : 'Confirm these numbers'}
        disabled={confirm.isPending}
        onPress={() => confirm.mutate()}
      />
      <Button
        testID="propose-correction"
        label="Propose a correction"
        variant="secondary"
        disabled={confirm.isPending}
        onPress={() => router.push({ pathname: '/record-game', params: { correct: game.id } })}
      />
      {confirm.isError && !isRefusal(confirm.error) && (
        <Text testID="confirm-error" style={styles.error}>
          Couldn’t confirm the game. Check your connection and try again.
        </Text>
      )}
      <Link
        href={{ pathname: '/games/[gid]', params: { gid: game.id } }}
        testID="inbox-game-link"
        style={styles.link}
      >
        Open the game
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  game: {
    gap: space.md,
    paddingBottom: space.xl,
    borderBottomWidth: 1,
    borderColor: colors.divider,
  },
  gameHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  notice: { color: colors.notice },
  link: { color: colors.accent, ...font(fonts.body, 600), paddingVertical: 8, textAlign: 'center' },
  muted: { color: colors.muted },
  error: { color: colors.danger },
});
