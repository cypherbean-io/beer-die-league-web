import {
  CreateInviteBody,
  INVITE_MAX_JOINS_DEFAULT,
  INVITE_MAX_JOINS_LIMIT,
  type MyMembership,
} from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createInvite, listInvites, revokeInvite } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

export default function Invites() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && (membership?.status !== 'approved' || membership.role !== 'commissioner')) {
    return <Redirect href="/" />;
  }
  if (!membership) return null;
  return <InviteManager membership={membership} />;
}

function InviteManager({ membership }: { membership: MyMembership }) {
  const queryClient = useQueryClient();
  const { leagueId } = membership;
  // The server returns a link's token only once, so it lives in component state only.
  const [url, setUrl] = useState<string | null>(null);
  const [maxJoinsText, setMaxJoinsText] = useState(String(INVITE_MAX_JOINS_DEFAULT));
  // Same validator as the server, for instant feedback; the server checks again.
  const parsed = CreateInviteBody.safeParse({ maxJoins: Number(maxJoinsText) });
  const maxJoins = maxJoinsText !== '' && parsed.success ? parsed.data.maxJoins : null;
  const invites = useQuery({
    queryKey: ['invites', leagueId],
    queryFn: () => listInvites(leagueId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['invites', leagueId] });
  const create = useMutation({
    mutationFn: (limit: number) => createInvite(leagueId, limit),
    onSuccess: (created) => setUrl(created.url),
    onSettled: refresh,
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) => revokeInvite(leagueId, inviteId),
    onSettled: refresh,
  });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Invite players' }} />
      <Text>
        Anyone with an invite link can ask to join, and you approve each request. A link stops
        working once the number of people you set have joined through it, or after 14 days.
      </Text>
      <Text nativeID="invite-max-joins-label">How many people can join with this link</Text>
      <TextInput
        testID="invite-max-joins-input"
        aria-labelledby="invite-max-joins-label"
        style={styles.input}
        value={maxJoinsText}
        onChangeText={(text) => setMaxJoinsText(text.replace(/[^0-9]/g, ''))}
        inputMode="numeric"
        maxLength={2}
      />
      {maxJoins === null && (
        <Text testID="invite-max-joins-hint" style={styles.muted}>
          Enter a number from 1 to {INVITE_MAX_JOINS_LIMIT}.
        </Text>
      )}
      <Button
        testID="create-invite"
        label={create.isPending ? 'Creating…' : 'Create invite link'}
        disabled={maxJoins === null || create.isPending}
        onPress={() => maxJoins !== null && create.mutate(maxJoins)}
      />
      {create.isError && <Text style={styles.error}>Could not create a link. Try again.</Text>}
      {url && (
        <View style={styles.card}>
          <Text>Share this link. It is shown only once.</Text>
          <Text selectable testID="invite-url" style={styles.url}>
            {url}
          </Text>
        </View>
      )}
      <Text style={styles.heading}>Active links</Text>
      {invites.data?.length === 0 && <Text style={styles.muted}>No active links.</Text>}
      {invites.data?.map((invite) => (
        <View key={invite.id} style={styles.row} testID="active-invite">
          <Text style={styles.grow}>
            Created {formatDate(invite.createdAt)}, expires {formatDate(invite.expiresAt)}.{' '}
            {invite.joinCount} of {invite.maxJoins} joins used.
          </Text>
          <Button
            label="Revoke"
            variant="secondary"
            disabled={revoke.isPending}
            onPress={() => revoke.mutate(invite.id)}
          />
        </View>
      ))}
      {revoke.isError && <Text style={styles.error}>Could not revoke that link. Try again.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, maxWidth: 560 },
  heading: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  card: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, gap: 8 },
  url: { fontFamily: 'monospace' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 10, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
