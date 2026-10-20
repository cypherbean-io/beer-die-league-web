import {
  type Game,
  type GamePlayer,
  type GameRevision,
  INBOX_MAX,
  type MyMembership,
} from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiRequestError, confirmRevision, getInbox } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

// Refusals that mean the list is out of date, as opposed to a failed request worth retrying.
const STALE_CODES = new Set(['WINDOW_CLOSED', 'STALE_REVISION']);

const isRefusal = (error: unknown): error is ApiRequestError =>
  error instanceof ApiRequestError && STALE_CODES.has(error.code);

function refusalFor(error: ApiRequestError): string {
  return error.code === 'WINDOW_CLOSED'
    ? 'The window to confirm that game closed, so it won’t count.'
    : 'That game changed after you loaded it, so it wasn’t confirmed. Check the latest numbers.';
}

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
  const inbox = useQuery({ queryKey: ['inbox', leagueId], queryFn: () => getInbox(leagueId) });
  // Shown above the list, because the game it is about may have just left it.
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inbox', leagueId] });

  const onConfirmed = (game: Game) => {
    setNotice(
      game.status === 'confirmed'
        ? 'Confirmed. All four players have confirmed, so the game now counts.'
        : 'Confirmed. The game counts once all four players confirm it.',
    );
    void refresh();
  };
  const onRefused = (error: ApiRequestError) => {
    setNotice(refusalFor(error));
    void refresh();
  };

  const games = inbox.data ?? [];
  return (
    <ScrollView contentContainerStyle={styles.container}>
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
    </ScrollView>
  );
}

type PendingGameProps = {
  leagueId: string;
  myId: string;
  game: Game;
  revision: GameRevision;
  onConfirmed: (game: Game) => void;
  onRefused: (error: ApiRequestError) => void;
};

function PendingGame({ leagueId, myId, game, revision, onConfirmed, onRefused }: PendingGameProps) {
  const router = useRouter();
  // Sends the id of the revision rendered below, so a correction made meanwhile is refused
  // rather than confirmed unseen.
  const confirm = useMutation({
    mutationFn: () => confirmRevision(leagueId, game.id, revision.id),
    onSuccess: onConfirmed,
    onError: (error) => {
      if (isRefusal(error)) onRefused(error);
    },
  });
  const author = revision.players.find((p) => p.membershipId === revision.createdBy);
  const authorName = author?.displayName ?? 'another player';
  // A reopened game: a correction of a result that counts, and keeps counting meanwhile.
  const reopened = game.confirmedRevision !== null;

  return (
    <View style={styles.game} testID="inbox-game">
      <Text style={styles.muted}>
        {game.kind === 'season' ? 'Season game' : 'Exhibition game'}, played{' '}
        {new Date(revision.playedAt).toLocaleString()}
      </Text>
      {revision.number > 1 && (
        <Text testID="inbox-corrected" style={styles.muted}>
          {reopened
            ? `${authorName} proposed a correction to this confirmed game. The confirmed result keeps counting until all four players confirm the correction.`
            : `Corrected by ${authorName}, so earlier confirmations were reset.`}
        </Text>
      )}
      {(['A', 'B'] as const).map((side) => (
        <View key={side} style={styles.side} testID={`inbox-side-${side}`}>
          <Text style={styles.heading}>
            Side {side}
            {revision.teams ? ` · ${revision.teams[side].name}` : ''}
            {revision.winner === side ? ' (won)' : ''}
          </Text>
          {revision.players
            .filter((p) => p.side === side)
            .map((p) => (
              <PlayerRow key={p.membershipId} player={p} isMe={p.membershipId === myId} />
            ))}
        </View>
      ))}
      {revision.ruleViolations.length > 0 && (
        <View testID="inbox-violations">
          <Text style={styles.error}>
            {revision.overrideStatus === 'approved'
              ? 'This result breaks the league rules, but a commissioner approved it:'
              : 'This result breaks the league rules, so it counts only if a commissioner approves it:'}
          </Text>
          {revision.ruleViolations.map((v) => (
            <Text key={v.code} style={styles.error}>
              • {v.message}
            </Text>
          ))}
        </View>
      )}
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
    </View>
  );
}

function PlayerRow({ player, isMe }: { player: GamePlayer; isMe: boolean }) {
  const state =
    player.confirmation === 'player'
      ? '✓'
      : player.confirmation === 'forced'
        ? '✓ forced'
        : 'pending';
  return (
    <Text testID={`inbox-player-${player.membershipId}`}>
      <Text style={styles.name}>
        {player.displayName}
        {isMe ? ' (you)' : ''}
        {player.isSub ? ' (sub)' : ''}
      </Text>
      : {player.points} {player.points === 1 ? 'point' : 'points'}, {player.sinks}{' '}
      {player.sinks === 1 ? 'sink' : 'sinks'} · {state}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 16, maxWidth: 560 },
  game: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, gap: 8 },
  side: { gap: 2 },
  heading: { fontSize: 16, fontWeight: '700' },
  name: { fontWeight: '600' },
  notice: { color: '#14532d' },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
