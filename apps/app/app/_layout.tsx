import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { createQueryClient } from '../src/api/hooks';

const queryClient = createQueryClient();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack />
    </QueryClientProvider>
  );
}
