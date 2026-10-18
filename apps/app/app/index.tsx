import type { MyMembership } from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getHealth, getLeague, logout } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';

export default function Home() {
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth });
  const me = useMe();
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => queryClient.setQueryData(['me'], null),
  });

  if (me.data === null) return <Redirect href="/sign-in" />;
  const membership = currentMembership(me.data);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Beer Die League' }} />
      <Text testID="api-status">
        {health.isPending ? 'Checking API…' : health.isError ? 'API unreachable' : 'API ok'}
      </Text>
      {me.data && (
        <>
          <Text testID="signed-in-as">Signed in as {me.data.user.email}</Text>
          {membership === undefined ? (
            <Text testID="no-league" style={styles.message}>
              You&apos;re not in a league yet. Ask a commissioner for an invite link.
            </Text>
          ) : membership.status === 'pending' ? (
            <Text testID="awaiting-approval" style={styles.message}>
              Your request to join {membership.leagueName} is awaiting a commissioner&apos;s
              approval.
            </Text>
          ) : (
            <LeagueHome membership={membership} />
          )}
          <Pressable
            testID="sign-out"
            role="button"
            disabled={signOut.isPending}
            onPress={() => signOut.mutate()}
          >
            <Text style={styles.link}>Sign out</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function LeagueHome({ membership }: { membership: MyMembership }) {
  const league = useQuery({
    queryKey: ['league', membership.leagueId],
    queryFn: () => getLeague(membership.leagueId),
  });
  const rules = league.data?.rules;

  return (
    <>
      <Text testID="league-name" style={styles.title}>
        {membership.leagueName}
      </Text>
      {rules && (
        <Text testID="league-rules">
          First to {rules.targetScore}, win by {rules.winBy}.
          {rules.sinkPoints > 0 ? ` A sink is worth ${rules.sinkPoints}.` : ''}
          {rules.sinkEndsGame ? ' A sink ends the game.' : ''}
        </Text>
      )}
      <Link href="/members" testID="members-link" style={styles.link}>
        Members
      </Link>
      {membership.role === 'commissioner' && (
        <Link href="/invites" testID="invites-link" style={styles.link}>
          Invite players
        </Link>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 22, fontWeight: '700' },
  message: { textAlign: 'center', maxWidth: 420 },
  link: { color: '#1d4ed8', padding: 8 },
});
