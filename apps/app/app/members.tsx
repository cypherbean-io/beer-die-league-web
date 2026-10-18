import type { Member, MembershipRole, MyMembership } from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ApiRequestError,
  approveMember,
  getMembers,
  rejectMember,
  setMemberRole,
} from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

type Action =
  | { kind: 'approve'; member: Member }
  | { kind: 'reject'; member: Member }
  | { kind: 'role'; member: Member; role: MembershipRole };

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'LAST_COMMISSIONER') {
      return 'A league needs at least one commissioner. Promote someone else first.';
    }
    if (error.code === 'NOT_PENDING') return 'That request was already handled.';
    if (error.code === 'FORBIDDEN') return 'Only a commissioner can do that.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

export default function Members() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <MemberList membership={membership} />;
}

function MemberList({ membership }: { membership: MyMembership }) {
  const queryClient = useQueryClient();
  const { leagueId } = membership;
  const members = useQuery({
    queryKey: ['members', leagueId],
    queryFn: () => getMembers(leagueId),
  });
  const action = useMutation({
    mutationFn: (a: Action) => {
      if (a.kind === 'approve') return approveMember(leagueId, a.member.id);
      if (a.kind === 'reject') return rejectMember(leagueId, a.member.id);
      return setMemberRole(leagueId, a.member.id, a.role);
    },
    // A role change can be the caller's own, which /me reflects.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['members', leagueId] }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
      ]),
  });

  const commissioner = membership.role === 'commissioner';
  const pending = members.data?.filter((m) => m.status === 'pending') ?? [];
  const approved = members.data?.filter((m) => m.status === 'approved') ?? [];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Members' }} />
      {members.isError && <Text style={styles.error}>{messageFor(members.error)}</Text>}
      {commissioner && pending.length > 0 && (
        <>
          <Text style={styles.heading}>Awaiting approval</Text>
          {pending.map((m) => (
            <View key={m.id} style={styles.row} testID="pending-member">
              <View style={styles.grow}>
                <Text style={styles.name}>{m.displayName}</Text>
                {m.email && <Text style={styles.muted}>{m.email}</Text>}
              </View>
              <Button
                testID="approve"
                label="Approve"
                disabled={action.isPending}
                onPress={() => action.mutate({ kind: 'approve', member: m })}
              />
              <Button
                testID="reject"
                label="Reject"
                variant="secondary"
                disabled={action.isPending}
                onPress={() => action.mutate({ kind: 'reject', member: m })}
              />
            </View>
          ))}
        </>
      )}
      <Text style={styles.heading}>Members</Text>
      {approved.map((m) => (
        <View key={m.id} style={styles.row} testID="member">
          <Text style={[styles.name, styles.grow]}>
            {m.displayName}
            {m.role === 'commissioner' ? ' · Commissioner' : ''}
          </Text>
          {commissioner && (
            <Button
              label={m.role === 'commissioner' ? 'Make member' : 'Make commissioner'}
              variant="secondary"
              disabled={action.isPending}
              onPress={() =>
                action.mutate({
                  kind: 'role',
                  member: m,
                  role: m.role === 'commissioner' ? 'member' : 'commissioner',
                })
              }
            />
          )}
        </View>
      ))}
      {action.isError && (
        <Text testID="member-action-error" style={styles.error}>
          {messageFor(action.error)}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, maxWidth: 560 },
  heading: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  name: { fontSize: 16 },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
