import { useInfiniteQuery } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { getAudit } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { describeEvent, participation } from '../src/auditText';
import { Button } from '../src/ui';

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
              {participation(event)}
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
