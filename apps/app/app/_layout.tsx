import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';

// Writes go out even while the browser reports being offline, so a failed submit fails at
// once and the form offers Retry, rather than queueing a resend nobody pressed.
const queryClient = new QueryClient({ defaultOptions: { mutations: { networkMode: 'always' } } });

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack />
    </QueryClientProvider>
  );
}
