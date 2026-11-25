import type { AuditEvent, Game, GamePlayer, GameRevision } from '@beer-die/core';
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ApiRequestError } from './api/client';
import { playerName, sideName, sideTotal, waitingOn } from './gameText';
import { colors, fonts, radius, space } from './theme';
import { Card, Text, textStyles } from './ui';

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
  const [w, l] = revision.winner === 'A' ? (['A', 'B'] as const) : (['B', 'A'] as const);
  return `${sideName(revision, w)} ${sideTotal(revision, w)}–${sideTotal(revision, l)} ${sideName(revision, l)}`;
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
    <Link href={{ pathname: '/games/[gid]', params: { gid: game.id } }} asChild>
      <Pressable testID={`game-row-${game.id}`} role="link" style={styles.gameRow}>
        <Text style={textStyles.kicker}>
          {kindLabel(game)} · {statusLabel(game)}
        </Text>
        {revision ? (
          <View style={styles.rowScore}>
            {(['A', 'B'] as const).map((side) => (
              <View key={side} style={styles.rowSide}>
                <Text
                  style={[styles.rowTotal, revision.winner !== side && styles.loser]}
                  aria-label={`${sideName(revision, side)}: ${sideTotal(revision, side)}`}
                >
                  {sideTotal(revision, side)}
                </Text>
                <Text style={styles.rowName} numberOfLines={2}>
                  {sideName(revision, side)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {revision && (
          <Text style={styles.small}>Played {new Date(revision.playedAt).toLocaleString()}</Text>
        )}
      </Pressable>
    </Link>
  );
}

// The final score: each side's total as a big numeral, the winner's in the accent.
export function Scoreboard({ revision }: { revision: GameRevision }) {
  return (
    <View style={styles.scoreboard}>
      {(['A', 'B'] as const).map((side, i) => {
        const won = revision.winner === side;
        return (
          <View key={side} style={[styles.scoreSide, i === 1 && styles.scoreSideB]}>
            <Text
              style={[styles.total, won ? styles.winner : styles.loser]}
              aria-label={`${sideName(revision, side)}: ${sideTotal(revision, side)}${won ? ', won' : ''}`}
            >
              {sideTotal(revision, side)}
            </Text>
            <Text style={[styles.sideName, !won && styles.dim]} numberOfLines={2}>
              {sideName(revision, side)}
            </Text>
            <Text style={[styles.sideLabel, won && styles.winner]}>
              Side {side}
              {won ? ' · Won' : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

type RevisionViewProps = {
  revision: GameRevision;
  myId: string;
  // Prefixes each element's testID, so a screen showing two revisions can tell them apart.
  idPrefix: string;
  forced?: ForcedBy;
};

// A revision's score, each player's line and confirmation, and any rules it breaks.
export function RevisionView({ revision, myId, idPrefix, forced }: RevisionViewProps) {
  const confirmed = revision.players.filter((p) => p.confirmation !== null).length;
  const waiting = waitingOn(revision);
  return (
    <View style={styles.revision}>
      <Card>
        <Scoreboard revision={revision} />
      </Card>
      <Card style={styles.box}>
        <View style={styles.boxHead}>
          <Text style={[textStyles.kicker, styles.flex]}>Box score</Text>
          <Text style={[textStyles.kicker, styles.stat]}>Pts</Text>
          <Text style={[textStyles.kicker, styles.stat]}>Sinks</Text>
        </View>
        {(['A', 'B'] as const).map((side) => (
          <View key={side} testID={`${idPrefix}-side-${side}`}>
            {revision.players
              .filter((p) => p.side === side)
              .map((p) => (
                <PlayerRow
                  key={p.membershipId}
                  testID={`${idPrefix}-player-${p.membershipId}`}
                  player={p}
                  won={revision.winner === side}
                  isMe={p.membershipId === myId}
                  forced={forced?.get(p.membershipId)}
                />
              ))}
          </View>
        ))}
      </Card>
      <View style={styles.progress}>
        <View style={styles.progressHead}>
          <Text style={styles.progressLabel}>
            {confirmed} / {revision.players.length} confirmed
          </Text>
        </View>
        <View style={styles.segments} aria-hidden>
          {revision.players.map((p, i) => (
            <View
              key={p.membershipId}
              style={[styles.segment, i < confirmed && styles.segmentOn]}
            />
          ))}
        </View>
        {waiting && <Text style={styles.small}>{waiting}</Text>}
      </View>
      {revision.ruleViolations.length > 0 && (
        <View testID={`${idPrefix}-violations`} style={styles.violations}>
          <Text style={textStyles.error}>
            {revision.overrideStatus === 'approved'
              ? 'This result breaks the league rules, but a commissioner approved it:'
              : revision.overrideStatus === 'rejected'
                ? 'This result breaks the league rules, and a commissioner rejected it:'
                : 'This result breaks the league rules, so it counts only if a commissioner approves it:'}
          </Text>
          {revision.ruleViolations.map((v) => (
            <Text key={v.code} style={textStyles.error}>
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
  won: boolean;
  isMe: boolean;
  forced: { by: string; participant: boolean } | undefined;
};

function PlayerRow({ testID, player, won, isMe, forced }: PlayerRowProps) {
  const state =
    player.confirmation === 'player'
      ? 'Confirmed'
      : player.confirmation === 'forced'
        ? forced
          ? `Confirmed by ${forced.by}${forced.participant ? ', who played in this game' : ''}`
          : 'Confirmed by a commissioner'
        : 'Waiting';
  return (
    <View testID={testID} style={styles.playerRow}>
      <View style={[styles.bar, won && styles.barWon]} />
      <View style={styles.flex}>
        <Text style={styles.playerName}>
          {playerName(player)}
          {isMe ? <Text style={styles.tag}> · You</Text> : null}
          {player.isSub ? <Text style={styles.tag}> · Sub</Text> : null}
        </Text>
        <Text style={[styles.small, player.confirmation !== null && styles.confirmed]}>
          {player.confirmation !== null ? '✓ ' : ''}
          {state}
        </Text>
      </View>
      <Text
        style={[styles.stat, styles.statValue]}
        aria-label={`${player.points} ${player.points === 1 ? 'point' : 'points'}`}
      >
        {player.points}
      </Text>
      <Text
        style={[styles.stat, styles.statValue, styles.dim]}
        aria-label={`${player.sinks} ${player.sinks === 1 ? 'sink' : 'sinks'}`}
      >
        {player.sinks}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gameRow: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowScore: { flexDirection: 'row', gap: space.lg },
  rowSide: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowTotal: {
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 36,
    lineHeight: 40,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  rowName: { flex: 1, fontWeight: '600' },
  small: { color: colors.muted, fontSize: 14 },
  scoreboard: { flexDirection: 'row', gap: space.md },
  scoreSide: { flex: 1, alignItems: 'center', gap: 2 },
  scoreSideB: { borderLeftWidth: 1, borderColor: colors.divider },
  total: {
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 88,
    lineHeight: 92,
    fontVariant: ['tabular-nums'],
  },
  winner: { color: colors.accent },
  loser: { color: colors.loser },
  dim: { color: colors.muted },
  sideName: {
    fontFamily: fonts.display,
    fontWeight: '600',
    fontSize: 18,
    letterSpacing: 0.6,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  sideLabel: {
    fontFamily: fonts.display,
    fontWeight: '600',
    fontSize: 13,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  revision: { gap: space.md },
  box: { gap: 0, paddingVertical: space.sm },
  boxHead: { flexDirection: 'row', alignItems: 'center', minHeight: 32 },
  stat: { width: 52, textAlign: 'right' },
  statValue: {
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 22,
    fontVariant: ['tabular-nums'],
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderColor: colors.divider,
  },
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2, backgroundColor: colors.border },
  barWon: { backgroundColor: colors.accent },
  playerName: { fontWeight: '600', fontSize: 17 },
  tag: { color: colors.muted, fontWeight: '500', fontSize: 14 },
  confirmed: { color: colors.notice },
  progress: { gap: space.sm, paddingHorizontal: space.xs },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between' },
  progressLabel: {
    fontFamily: fonts.display,
    fontWeight: '600',
    fontSize: 16,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  segments: { flexDirection: 'row', gap: 6 },
  segment: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.border },
  segmentOn: { backgroundColor: colors.accent },
  violations: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
  },
});
