import type { Member, MembershipRole, MyMembership } from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ApiRequestError,
  approveMember,
  getMembers,
  leaveLeague,
  rejectMember,
  removeMember,
  setMemberRole,
} from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

type Action =
  | { kind: 'approve'; member: Member }
  | { kind: 'reject'; member: Member }
  | { kind: 'remove'; member: Member }
  | { kind: 'role'; member: Member; role: MembershipRole };

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'LAST_COMMISSIONER') {
      return 'A league needs at least one commissioner. Promote someone else first.';
    }
    if (error.code === 'NOT_PENDING') return 'That request was already handled.';
    if (error.code === 'NOT_APPROVED') return 'That member is no longer in the league.';
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
  // The member whose removal awaits a second tap, or 'leave' for the caller leaving.
  const [confirming, setConfirming] = useState<string | null>(null);
  const members = useQuery({
    queryKey: ['members', leagueId],
    queryFn: () => getMembers(leagueId),
  });
  const action = useMutation({
    mutationFn: (a: Action) => {
      if (a.kind === 'approve') return approveMember(leagueId, a.member.id);
      if (a.kind === 'reject') return rejectMember(leagueId, a.member.id);
      if (a.kind === 'remove') return removeMember(leagueId, a.member.id);
      return setMemberRole(leagueId, a.member.id, a.role);
    },
    // A role change can be the caller's own, which /me reflects. A removal voids games and
    // changes teams, so everything is refetched.
    onSettled: (_data, _error, a) =>
      a.kind === 'remove'
        ? queryClient.invalidateQueries()
        : Promise.all([
            queryClient.invalidateQueries({ queryKey: ['members', leagueId] }),
            queryClient.invalidateQueries({ queryKey: ['me'] }),
          ]),
  });
  // Once /me no longer lists the league, this screen redirects home.
  const leave = useMutation({
    mutationFn: () => leaveLeague(leagueId),
    onSuccess: () => queryClient.invalidateQueries(),
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
        <View key={m.id} style={styles.member} testID="member">
          <View style={styles.row}>
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
            {commissioner && m.id !== membership.id && confirming !== m.id && (
              <Button
                testID="remove-member"
                label="Remove"
                variant="secondary"
                disabled={action.isPending}
                onPress={() => setConfirming(m.id)}
              />
            )}
          </View>
          {confirming === m.id && (
            <View style={styles.confirm}>
              <Text>
                Remove {m.displayName} from the league? Games of theirs still awaiting confirmation
                are voided, and they come off their teams. Their confirmed games still count, and
                their name stays on them for every member to see. This can&apos;t be undone.
              </Text>
              <View style={styles.row}>
                <Button
                  testID="confirm-remove-member"
                  label={action.isPending ? 'Removing…' : 'Remove'}
                  disabled={action.isPending}
                  onPress={() =>
                    action.mutate(
                      { kind: 'remove', member: m },
                      { onSettled: () => setConfirming(null) },
                    )
                  }
                />
                <Button label="Cancel" variant="secondary" onPress={() => setConfirming(null)} />
              </View>
            </View>
          )}
        </View>
      ))}
      {action.isError && (
        <Text testID="member-action-error" style={styles.error}>
          {messageFor(action.error)}
        </Text>
      )}

      {confirming === 'leave' ? (
        <View style={styles.confirm}>
          <Text>
            Leave {membership.leagueName}? Your games still awaiting confirmation are voided, and
            you come off your teams. Your confirmed games still count, and your name stays on them
            for every member to see. This can&apos;t be undone.
          </Text>
          <View style={styles.row}>
            <Button
              testID="confirm-leave-league"
              label={leave.isPending ? 'Leaving…' : 'Leave'}
              disabled={leave.isPending}
              onPress={() => leave.mutate(undefined, { onSettled: () => setConfirming(null) })}
            />
            <Button label="Cancel" variant="secondary" onPress={() => setConfirming(null)} />
          </View>
        </View>
      ) : (
        <Button
          testID="leave-league"
          label="Leave league"
          variant="secondary"
          onPress={() => setConfirming('leave')}
        />
      )}
      {leave.isError && (
        <Text testID="leave-error" style={styles.error}>
          {messageFor(leave.error)}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, maxWidth: 560 },
  heading: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  member: { gap: 8 },
  confirm: { gap: 8, paddingLeft: 12 },
  grow: { flex: 1 },
  name: { fontSize: 16 },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
