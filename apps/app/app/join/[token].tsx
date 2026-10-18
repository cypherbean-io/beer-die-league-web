import { DisplayName } from '@beer-die/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiRequestError, getMe, joinLeague } from '../../src/api/client';
import { useMe } from '../../src/api/hooks';
import { Button } from '../../src/ui';

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'NAME_TAKEN') return 'That name is taken in this league. Try another.';
    if (error.code === 'INVITE_INVALID') {
      return 'This invite link is invalid or has expired. Ask a commissioner for a new one.';
    }
    if (error.code === 'ALREADY_MEMBER') return 'You already belong to this league.';
    if (error.code === 'VALIDATION') return 'Check your display name and try again.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

export default function Join() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const [displayName, setDisplayName] = useState('');

  const join = useMutation({
    mutationFn: () => joinLeague(token, displayName),
    onSuccess: async () => {
      // Home reads the new pending membership from /me, so load it before going there.
      await queryClient.fetchQuery({ queryKey: ['me'], queryFn: getMe });
      router.replace('/');
    },
  });

  if (me.data === null) {
    return <Redirect href={{ pathname: '/sign-in', params: { invite: token } }} />;
  }

  // Same validator as the server, for instant feedback; the server checks again.
  const parsed = DisplayName.safeParse(displayName);
  const hint =
    displayName.length > 0 && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const alreadyMember =
    join.error instanceof ApiRequestError && join.error.code === 'ALREADY_MEMBER';

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Join league' }} />
      <Text style={styles.label} nativeID="display-name-label">
        Choose the name other players will see
      </Text>
      <TextInput
        testID="display-name-input"
        aria-labelledby="display-name-label"
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        autoComplete="nickname"
        onSubmitEditing={() => parsed.success && join.mutate()}
      />
      {hint && (
        <Text testID="display-name-hint" style={styles.hint}>
          {hint}
        </Text>
      )}
      <Button
        testID="join"
        label={join.isPending ? 'Joining…' : 'Ask to join'}
        disabled={!parsed.success || join.isPending || !me.data}
        onPress={() => join.mutate()}
      />
      <Text style={styles.hint}>A commissioner approves every request to join.</Text>
      {join.isError && (
        <Text testID="join-error" style={styles.error}>
          {messageFor(join.error)}
        </Text>
      )}
      {alreadyMember && (
        <Link href="/" style={styles.link}>
          Go to your league
        </Link>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, maxWidth: 420 },
  label: { fontSize: 16 },
  input: { borderWidth: 1, borderColor: '#888', borderRadius: 8, padding: 12, fontSize: 18 },
  hint: { color: '#555' },
  error: { color: '#b91c1c' },
  link: { color: '#1d4ed8', textAlign: 'center', padding: 8 },
});
