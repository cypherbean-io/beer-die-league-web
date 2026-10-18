import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getHealth, getMe, logout } from '../src/api/client';

export default function Home() {
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth });
  const me = useQuery({ queryKey: ['me'], queryFn: getMe });
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => queryClient.setQueryData(['me'], null),
  });

  if (me.data === null) return <Redirect href="/sign-in" />;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Beer Die League' }} />
      <Text testID="api-status">
        {health.isPending ? 'Checking API…' : health.isError ? 'API unreachable' : 'API ok'}
      </Text>
      {me.data && (
        <>
          <Text testID="signed-in-as">Signed in as {me.data.user.email}</Text>
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

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  link: { color: '#1d4ed8', padding: 8 },
});
