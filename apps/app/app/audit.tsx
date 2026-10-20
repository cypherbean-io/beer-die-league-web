import type { AuditEvent, LeagueSettings, Rules } from '@beer-die/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { getAudit } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

const RULE_LABELS: Record<keyof Rules, string> = {
  targetScore: 'Target score',
  winBy: 'Win by',
  sinkPoints: 'Points for a sink',
  sinkEndsGame: 'A sink ends the game',
};

const SETTING_LABELS: Record<keyof LeagueSettings, string> = {
  confirmationWindowDays: 'Days to confirm a game',
  exhibitionCorrectionWindowDays: 'Days to reopen an exhibition game',
};

const show = (value: unknown) =>
  typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);

function changeLines<T extends object>(
  details: { before: T; after: T },
  labels: Record<keyof T, string>,
): string[] {
  return (Object.keys(labels) as Array<keyof T>)
    .filter((key) => details.before[key] !== details.after[key])
    .map((key) => `${labels[key]}: ${show(details.before[key])} → ${show(details.after[key])}`);
}

function describeEvent(event: AuditEvent): { summary: string; lines: string[] } {
  switch (event.action) {
    case 'league.rules_updated':
      return { summary: 'changed the rules', lines: changeLines(event.details, RULE_LABELS) };
    case 'league.settings_updated':
      return {
        summary: 'changed the league settings',
        lines: changeLines(event.details, SETTING_LABELS),
      };
    case 'game.confirmation_forced':
      return { summary: `confirmed a game on behalf of ${event.player.displayName}`, lines: [] };
    case 'game.override_decided':
      return {
        summary:
          event.details.decision === 'approve'
            ? 'approved a game that breaks the league rules'
            : 'rejected a game that breaks the league rules',
        lines: [],
      };
  }
}

export default function AuditLog() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <EventList leagueId={membership.leagueId} />;
}

function EventList({ leagueId }: { leagueId: string }) {
  const log = useInfiniteQuery({
    queryKey: ['audit', leagueId],
    queryFn: ({ pageParam }) => getAudit(leagueId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  const events = log.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'League log' }} />
      <Text style={styles.muted}>
        Every commissioner action is recorded here, and entries can&apos;t be edited or removed.
      </Text>
      {log.isError && (
        <Text style={styles.error}>
          Could not load the log. Check your connection and try again.
        </Text>
      )}
      {log.isSuccess && events.length === 0 && <Text style={styles.muted}>Nothing yet.</Text>}
      {events.map((event) => {
        const { summary, lines } = describeEvent(event);
        return (
          <View key={event.id} style={styles.entry} testID="audit-event">
            <Text>
              <Text style={styles.name}>{event.actor.displayName}</Text> {summary}
              {event.actorWasParticipant ? ' (played in this game)' : ''}
            </Text>
            {lines.map((line) => (
              <Text key={line} style={styles.change}>
                {line}
              </Text>
            ))}
            <Text style={styles.muted}>{new Date(event.createdAt).toLocaleString()}</Text>
          </View>
        );
      })}
      {log.hasNextPage && (
        <Button
          testID="audit-more"
          label={log.isFetchingNextPage ? 'Loading…' : 'Show older entries'}
          variant="secondary"
          disabled={log.isFetchingNextPage}
          onPress={() => void log.fetchNextPage()}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, maxWidth: 560 },
  entry: { borderBottomWidth: 1, borderColor: '#ddd', paddingVertical: 8, gap: 2 },
  name: { fontWeight: '700' },
  change: { paddingLeft: 12 },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
