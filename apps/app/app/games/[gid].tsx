import type {
  Game,
  GameDetailResponse,
  GameHistoryRevision,
  GameRevision,
  MyMembership,
} from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ApiRequestError,
  confirmRevision,
  decideOverride,
  forceConfirm,
  getGame,
} from '../../src/api/client';
import { currentMembership, useMe } from '../../src/api/hooks';
import { describeEvent, participation } from '../../src/auditText';
import {
  forcedOn,
  isRefusal,
  kindLabel,
  refusalFor,
  RevisionView,
  statusLabel,
  useNow,
} from '../../src/game';
import { confirmNotice, describeChange, diffRevisions, timeLeft } from '../../src/gameText';
import { Button } from '../../src/ui';

const formatTime = (iso: string) => new Date(iso).toLocaleString();

const REVISION_STATUS: Record<GameRevision['status'], string> = {
  open: 'waiting for confirmation',
  confirmed: 'confirmed',
  superseded: 'replaced by a correction',
  expired: 'expired',
  voided: 'voided',
  rejected: 'rejected by a commissioner',
};

export default function GameScreen() {
  const me = useMe();
  const membership = currentMembership(me.data);
  const { gid } = useLocalSearchParams<{ gid: string }>();

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <GameDetail membership={membership} gameId={gid} />;
}

function GameDetail({ membership, gameId }: { membership: MyMembership; gameId: string }) {
  const { leagueId } = membership;
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['game', leagueId, gameId],
    queryFn: () => getGame(leagueId, gameId),
  });
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () =>
    Promise.all(
      [
        ['game', leagueId, gameId],
        ['inbox', leagueId],
        ['games', leagueId],
        ['stats', leagueId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  const done = (message: string) => {
    setNotice(message);
    void refresh();
  };
  const refused = (error: unknown) => {
    if (isRefusal(error)) done(refusalFor(error));
  };

  if (detail.isPending) return null;
  if (detail.isError) {
    const missing = detail.error instanceof ApiRequestError && detail.error.status === 404;
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Game' }} />
        <Text testID="game-unavailable" style={styles.error}>
          {missing
            ? 'This game doesn’t exist in your league.'
            : 'Couldn’t load the game. Check your connection and try again.'}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Game' }} />
      {notice !== null && (
        <Text testID="game-notice" style={styles.notice}>
          {notice}
        </Text>
      )}
      <GameBody detail={detail.data} membership={membership} onDone={done} onRefused={refused} />
    </ScrollView>
  );
}

type BodyProps = {
  detail: GameDetailResponse;
  membership: MyMembership;
  onDone: (message: string) => void;
  onRefused: (error: unknown) => void;
};

function GameBody({ detail, membership, onDone, onRefused }: BodyProps) {
  const router = useRouter();
  const now = useNow(30_000);
  const { game, revisions, audit } = detail;
  const open = game.openRevision;
  const counted = game.confirmedRevision;
  const last = revisions.at(-1);
  const playsIn = (r: GameRevision | null | undefined) =>
    r?.players.some((p) => p.membershipId === membership.id) ?? false;
  const commissioner = membership.role === 'commissioner';
  // The four players may correct a pending game, or reopen a confirmed one while its window to
  // do so lasts; the server decides the window.
  const canCorrect = playsIn(open ?? counted);

  return (
    <>
      <Text testID="game-status" style={styles.heading}>
        {kindLabel(game)} · {statusLabel(game)}
      </Text>
      <Text style={styles.muted}>{statusDetail(game)}</Text>
      {game.windowExpiresAt !== null && (
        <Text testID="game-countdown" style={styles.muted}>
          {timeLeft(game.windowExpiresAt, now)} to confirm (until {formatTime(game.windowExpiresAt)}
          )
        </Text>
      )}

      {open && (
        <View style={styles.section} testID="game-open">
          <Text style={styles.subheading}>
            {counted ? 'Proposed correction' : 'Waiting for confirmation'} (revision {open.number})
          </Text>
          <Text style={styles.muted}>Played {formatTime(open.playedAt)}</Text>
          <RevisionView
            revision={open}
            myId={membership.id}
            idPrefix="game"
            forced={forcedOn(audit, open.id)}
          />
          <OpenActions
            game={game}
            revision={open}
            membership={membership}
            commissioner={commissioner}
            onDone={onDone}
            onRefused={onRefused}
          />
        </View>
      )}
      {counted && (
        <View style={styles.section} testID="game-counted">
          <Text style={styles.subheading}>
            {open ? 'Counting meanwhile' : 'Counted result'} (revision {counted.number})
          </Text>
          <Text style={styles.muted}>Played {formatTime(counted.playedAt)}</Text>
          <RevisionView
            revision={counted}
            myId={membership.id}
            idPrefix={open ? 'game-counted' : 'game'}
            forced={forcedOn(audit, counted.id)}
          />
        </View>
      )}
      {!open && !counted && last && (
        <View style={styles.section} testID="game-last">
          <Text style={styles.subheading}>Last numbers (revision {last.number})</Text>
          <RevisionView
            revision={last}
            myId={membership.id}
            idPrefix="game"
            forced={forcedOn(audit, last.id)}
          />
        </View>
      )}
      {canCorrect && (game.status === 'pending' || game.status === 'confirmed') && (
        <Button
          testID="propose-correction"
          label={open ? 'Propose a correction' : 'Reopen with a correction'}
          variant="secondary"
          onPress={() => router.push({ pathname: '/record-game', params: { correct: game.id } })}
        />
      )}

      {revisions.length > 1 && <History revisions={revisions} />}

      {audit.length > 0 && (
        <View style={styles.section} testID="game-log">
          <Text style={styles.subheading}>Commissioner actions</Text>
          {audit.map((event) => (
            <Text key={event.id} testID="game-log-entry">
              <Text style={styles.name}>{event.actor.displayName}</Text>{' '}
              {describeEvent(event).summary}
              {participation(event)} · {formatTime(event.createdAt)}
            </Text>
          ))}
        </View>
      )}
    </>
  );
}

function statusDetail(game: Game): string {
  switch (game.status) {
    case 'pending':
      return 'It counts once all four players confirm the numbers.';
    case 'confirmed':
      return game.openRevision
        ? 'The counted result keeps counting until all four players confirm the correction.'
        : 'All four players confirmed it, so it counts in stats.';
    case 'expired':
      return 'The window closed before all four players confirmed, so it never counted.';
    case 'voided':
      return 'A player left the league before it was confirmed, so it never counts.';
  }
}

type OpenActionsProps = {
  game: Game;
  revision: GameRevision;
  membership: MyMembership;
  commissioner: boolean;
  onDone: (message: string) => void;
  onRefused: (error: unknown) => void;
};

// What can be done with the revision on screen. Each request names that revision, so a
// correction made meanwhile is refused rather than acted on unseen.
function OpenActions({
  game,
  revision,
  membership,
  commissioner,
  onDone,
  onRefused,
}: OpenActionsProps) {
  const { leagueId } = membership;
  const mine = revision.players.find((p) => p.membershipId === membership.id);
  const confirm = useMutation({
    mutationFn: () => confirmRevision(leagueId, game.id, revision.id),
    onSuccess: (g) => onDone(confirmNotice(g, revision.id)),
    onError: onRefused,
  });
  const awaitingReview = revision.status === 'open' && revision.overrideStatus === 'requested';

  return (
    <View style={styles.section}>
      {mine && mine.confirmation === null && revision.status === 'open' && (
        <Button
          testID="confirm-game"
          label={confirm.isPending ? 'Confirming…' : 'Confirm these numbers'}
          disabled={confirm.isPending}
          onPress={() => confirm.mutate()}
        />
      )}
      {confirm.isError && !isRefusal(confirm.error) && (
        <Text testID="confirm-error" style={styles.error}>
          Couldn’t confirm the game. Check your connection and try again.
        </Text>
      )}
      {commissioner && awaitingReview && (
        <Review
          leagueId={leagueId}
          game={game}
          revision={revision}
          onDone={onDone}
          onRefused={onRefused}
        />
      )}
      {commissioner && revision.status === 'open' && (
        <ForceConfirm
          game={game}
          revision={revision}
          membership={membership}
          onDone={onDone}
          onRefused={onRefused}
        />
      )}
    </View>
  );
}

type CommissionerProps = {
  game: Game;
  revision: GameRevision;
  onDone: (message: string) => void;
  onRefused: (error: unknown) => void;
};

function Review({
  leagueId,
  game,
  revision,
  onDone,
  onRefused,
}: CommissionerProps & { leagueId: string }) {
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      decideOverride(leagueId, game.id, revision.id, decision),
    onSuccess: (_g, decision) =>
      onDone(
        decision === 'approve'
          ? 'Approved. It counts once all four players have confirmed it.'
          : 'Rejected. The players can still correct it before the window closes.',
      ),
    onError: onRefused,
  });
  return (
    <View style={styles.panel} testID="override-review">
      <Text style={styles.subheading}>Commissioner review</Text>
      <Text style={styles.muted}>
        The players sent this result for review because it breaks the league rules. Your decision is
        recorded in the league log.
      </Text>
      <View style={styles.row}>
        <Button
          testID="override-approve"
          label="Approve"
          disabled={decide.isPending}
          onPress={() => decide.mutate('approve')}
        />
        <Button
          testID="override-reject"
          label="Reject"
          variant="secondary"
          disabled={decide.isPending}
          onPress={() => decide.mutate('reject')}
        />
      </View>
      {decide.isError && !isRefusal(decide.error) && (
        <Text testID="override-error" style={styles.error}>
          Couldn’t record the decision. Check your connection and try again.
        </Text>
      )}
    </View>
  );
}

function ForceConfirm({
  game,
  revision,
  membership,
  onDone,
  onRefused,
}: CommissionerProps & { membership: MyMembership }) {
  // A commissioner confirms their own result as a player, never on their own behalf.
  const silent = revision.players.filter(
    (p) => p.confirmation === null && p.membershipId !== membership.id,
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const force = useMutation({
    mutationFn: () =>
      forceConfirm(membership.leagueId, game.id, revision.id, { membershipIds: chosen }),
    onSuccess: () => {
      setChosen([]);
      onDone('Confirmed on their behalf. Each confirmation is recorded in the league log.');
    },
    onError: onRefused,
  });
  if (silent.length === 0) return null;
  const toggle = (id: string) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  return (
    <View style={styles.panel} testID="force-confirm-panel">
      <Text style={styles.subheading}>Confirm for silent players</Text>
      <Text style={styles.muted}>
        Commissioners can confirm for players who haven’t responded. Each one is recorded in the
        league log, and any player can still propose a correction.
      </Text>
      <View style={styles.row}>
        {silent.map((p) => (
          <Button
            key={p.membershipId}
            testID={`force-confirm-${p.membershipId}`}
            label={chosen.includes(p.membershipId) ? `${p.displayName} ✓` : p.displayName}
            variant={chosen.includes(p.membershipId) ? 'primary' : 'secondary'}
            onPress={() => toggle(p.membershipId)}
          />
        ))}
      </View>
      <Button
        testID="force-confirm"
        label={force.isPending ? 'Confirming…' : 'Confirm for the selected players'}
        disabled={chosen.length === 0 || force.isPending}
        onPress={() => force.mutate()}
      />
      {force.isError && !isRefusal(force.error) && (
        <Text testID="force-confirm-error" style={styles.error}>
          Couldn’t confirm for them. Check your connection and try again.
        </Text>
      )}
    </View>
  );
}

function History({ revisions }: { revisions: GameHistoryRevision[] }) {
  return (
    <View style={styles.section} testID="game-history">
      <Text style={styles.subheading}>History</Text>
      {revisions.map((r, i) => {
        const author = r.players.find((p) => p.membershipId === r.createdBy)?.displayName;
        const before = revisions[i - 1];
        const changes = before ? diffRevisions(before, r) : [];
        return (
          <View key={r.id} style={styles.entry} testID={`game-revision-${r.number}`}>
            <Text>
              <Text style={styles.name}>Revision {r.number}</Text>
              {i === 0 ? ' submitted' : ' corrected'} by {author ?? 'a former player'},{' '}
              {formatTime(r.createdAt)} · {REVISION_STATUS[r.status]}
            </Text>
            {before && changes.length === 0 && <Text style={styles.change}>No changes.</Text>}
            {changes.map((change, j) => (
              <Text key={j} style={styles.change}>
                {describeChange(change, formatTime)}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 16, maxWidth: 560 },
  section: { gap: 8 },
  panel: { gap: 8, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  heading: { fontSize: 18, fontWeight: '700' },
  subheading: { fontSize: 16, fontWeight: '700' },
  entry: { gap: 2 },
  change: { paddingLeft: 12 },
  name: { fontWeight: '600' },
  notice: { color: '#14532d' },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
