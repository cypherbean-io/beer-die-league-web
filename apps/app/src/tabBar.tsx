import { Link } from 'expo-router';
import type { TabTriggerSlotProps } from 'expo-router/ui';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, space } from './theme';
import { Text } from './ui';

// The parts of the bar along the bottom of the tab screens (`app/(tabs)/_layout.tsx`). Its
// entries are links that mark the current one, not ARIA tabs, so they never clash with tabs
// inside a screen (the stats scopes).

export function useTabBarStyle(visible: boolean) {
  const insets = useSafeAreaInsets();
  return [styles.bar, { paddingBottom: insets.bottom + space.sm }, !visible && styles.hidden];
}

// Recording a game is its own pushed screen rather than a tab, so it gets a raised button.
export function RecordButton() {
  return (
    <Link href="/record-game" asChild>
      <Pressable testID="tab-record" role="link" aria-label="Record a game" style={styles.record}>
        <View style={styles.plusBar} />
        <View style={[styles.plusBar, styles.plusBarDown]} />
      </Pressable>
    </Link>
  );
}

type TabButtonProps = Pick<TabTriggerSlotProps, 'isFocused' | 'onPress' | 'onLongPress'> & {
  label: string;
  testID: string;
};

// `TabTrigger asChild` passes in whether the tab is current and how to switch to it.
export function TabButton({ label, testID, isFocused, onPress, onLongPress }: TabButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      role="link"
      aria-current={isFocused ? 'page' : undefined}
      style={styles.tab}
    >
      <View style={[styles.indicator, isFocused && styles.indicatorOn]} />
      <Text style={[styles.label, isFocused && styles.labelOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: space.sm,
  },
  hidden: { display: 'none' },
  tab: { flex: 1, alignItems: 'center', gap: 6, paddingBottom: space.sm, minHeight: 48 },
  indicator: { width: 28, height: 3, borderRadius: 2, backgroundColor: 'transparent' },
  indicatorOn: { backgroundColor: colors.accent },
  label: {
    fontFamily: fonts.display,
    fontWeight: '600',
    fontSize: 14,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  labelOn: { color: colors.accent },
  record: {
    width: 60,
    height: 60,
    borderRadius: 30,
    marginTop: -22,
    marginHorizontal: space.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 6,
    borderColor: colors.bg,
    boxSizing: 'content-box',
  },
  // A plus sign, drawn rather than typed so it sits dead centre.
  plusBar: {
    position: 'absolute',
    width: 24,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.onAccent,
  },
  plusBarDown: { transform: [{ rotate: '90deg' }] },
});
