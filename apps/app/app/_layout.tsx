import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { createQueryClient } from '../src/api/hooks';
import { fontFiles } from '../src/fonts';
import { colors, font, fonts } from '../src/theme';

const queryClient = createQueryClient();

export default function RootLayout() {
  const [loaded, error] = useFonts(fontFiles);
  // Without its fonts the app still works, in the platform's own, so a font that fails to load
  // never blanks it.
  if (!loaded && !error) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { ...font(fonts.display, 700), fontSize: 22 },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {/* The tab screens draw their own headers above the tab bar. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </QueryClientProvider>
  );
}
