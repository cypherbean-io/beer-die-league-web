import type { AuditEvent, Game, GamePlayer, GameRevision } from '@beer-die/core';
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ApiRequestError } from './api/client';

// Refusals that mean what was shown is out of date, as opposed to a failed request worth
// retrying.
const STALE_CODES = new Set(['WINDOW_CLOSED', 'STALE_REVISION', 'NOT_AWAITING_REVIEW']);

export const isRefusal = (error: unknown): error is ApiRequestError =>
  error instanceof ApiRequestError && STALE_CODES.has(error.code);

export function refusalFor(error: ApiRequestError): string {
  if (error.code === 'WINDOW_CLOSED') {
    return 'The window to confirm that game closed, so it won’t count.';
  }
  if (error.code === 'NOT_AWAITING_REVIEW') {
    return 'That game is no longer waiting for a review. Check the latest numbers.';
  }
  return 'That game changed after you loaded it, so nothing was saved. Check the latest numbers.';
}

// Who confirmed for a player who stayed silent, from the game's log entries: by revision, then
// by player.
export type ForcedBy = Map<string, { by: string; participant: boolean }>;

export function forcedOn(audit: AuditEvent[], revisionId: string): ForcedBy {
  const forced: ForcedBy = new Map();
  for (const event of audit) {
    if (event.action === 'game.confirmation_forced' && event.details.revisionId === revisionId) {
      forced.set(event.details.membershipId, {
        by: event.actor.displayName,
        participant: event.actorWasParticipant,
      });
    }
  }
  return forced;
}

export const kindLabel = (game: Game) =>
  game.kind === 'season' ? 'Season game' : 'Exhibition game';

// "Ana & Bo 11–9 Cy & Di", with the winning side's total in front.
export function scoreLine(revision: GameRevision): string {
  const side = (s: 'A' | 'B') => revision.players.filter((p) => p.side === s);
  const total = (s: 'A' | 'B') => side(s).reduce((sum, p) => sum + p.points, 0);
  const names = (s: 'A' | 'B') =>
    revision.teams?.[s].name ??
    side(s)
      .map((p) => p.displayName)
      .join(' & ');
  const [w, l] = revision.winner === 'A' ? (['A', 'B'] as const) : (['B', 'A'] as const);
  return `${names(w)} ${total(w)}–${total(l)} ${names(l)}`;
}

export function statusLabel(game: Game): string {
  if (game.status === 'confirmed') {
    return game.openRevision ? 'Confirmed; a correction is waiting' : 'Confirmed';
  }
  if (game.status === 'pending') {
    return game.openRevision?.status === 'rejected'
      ? 'Rejected by a commissioner'
      : game.openRevision?.overrideStatus === 'requested'
        ? 'Waiting for a commissioner’s review'
        : 'Waiting for confirmations';
  }
  return game.status === 'expired' ? 'Expired' : 'Voided';
}

// The revision that best stands for a game in a list: the one counting, else the open one.
export const headlineRevision = (game: Game) => game.confirmedRevision ?? game.openRevision;

// The current time, refreshed every `intervalMs`, for countdowns.
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// One row of a game list, linking to the game's page.
export function GameRow({ game }: { game: Game }) {
  const revision = headlineRevision(game);
  return (
    <Link
      href={{ pathname: '/games/[gid]', params: { gid: game.id } }}
      testID={`game-row-${game.id}`}
      style={styles.row}
    >
      <Text style={styles.name}>{revision ? scoreLine(revision) : kindLabel(game)}</Text>
      {'\n'}
      <Text style={styles.muted}>
        {kindLabel(game)}
        {revision ? `, played ${new Date(revision.playedAt).toLocaleString()}` : ''} ·{' '}
        {statusLabel(game)}
      </Text>
    </Link>
  );
}

type RevisionViewProps = {
  revision: GameRevision;
  myId: string;
  // Prefixes each element's testID, so a screen showing two revisions can tell them apart.
  idPrefix: string;
  forced?: ForcedBy;
};

// A revision's two sides, each player's line and confirmation, and any rules it breaks.
export function RevisionView({ revision, myId, idPrefix, forced }: RevisionViewProps) {
  return (
    <View style={styles.revision}>
      {(['A', 'B'] as const).map((side) => (
        <View key={side} style={styles.side} testID={`${idPrefix}-side-${side}`}>
          <Text style={styles.heading}>
            Side {side}
            {revision.teams ? ` · ${revision.teams[side].name}` : ''}
            {revision.winner === side ? ' (won)' : ''}
          </Text>
          {revision.players
            .filter((p) => p.side === side)
            .map((p) => (
              <PlayerRow
                key={p.membershipId}
                testID={`${idPrefix}-player-${p.membershipId}`}
                player={p}
                isMe={p.membershipId === myId}
                forced={forced?.get(p.membershipId)}
              />
            ))}
        </View>
      ))}
      {revision.ruleViolations.length > 0 && (
        <View testID={`${idPrefix}-violations`}>
          <Text style={styles.error}>
            {revision.overrideStatus === 'approved'
              ? 'This result breaks the league rules, but a commissioner approved it:'
              : revision.overrideStatus === 'rejected'
                ? 'This result breaks the league rules, and a commissioner rejected it:'
                : 'This result breaks the league rules, so it counts only if a commissioner approves it:'}
          </Text>
          {revision.ruleViolations.map((v) => (
            <Text key={v.code} style={styles.error}>
              • {v.message}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

type PlayerRowProps = {
  testID: string;
  player: GamePlayer;
  isMe: boolean;
  forced: { by: string; participant: boolean } | undefined;
};

function PlayerRow({ testID, player, isMe, forced }: PlayerRowProps) {
  const state =
    player.confirmation === 'player'
      ? '✓'
      : player.confirmation === 'forced'
        ? forced
          ? `✓ forced by ${forced.by}${forced.participant ? ', who played in this game' : ''}`
          : '✓ forced'
        : 'pending';
  return (
    <Text testID={testID}>
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
  row: { borderBottomWidth: 1, borderColor: '#ddd', paddingVertical: 8 },
  revision: { gap: 8 },
  side: { gap: 2 },
  heading: { fontSize: 16, fontWeight: '700' },
  name: { fontWeight: '600' },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
