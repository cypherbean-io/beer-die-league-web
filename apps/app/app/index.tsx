import { useQuery } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { getHealth } from '../src/api/client';

export default function Home() {
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth });

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Beer Die League' }} />
      <Text testID="api-status">
        {health.isPending ? 'Checking API…' : health.isError ? 'API unreachable' : 'API ok'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
