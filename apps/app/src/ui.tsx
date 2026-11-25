import { createContext, type ReactNode, useContext } from 'react';
import {
  Pressable,
  Text as RNText,
  TextInput as RNTextInput,
  ScrollView,
  type StyleProp,
  StyleSheet,
  type TextInputProps,
  type TextProps,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, type Family, font, fonts, maxWidth, radius, resolveFont, space } from './theme';

// The family of the enclosing `Text`, or null at the top level. Nested text inherits its
// parent's colour and font, so it only needs a family resolved when it changes the weight.
const Inherited = createContext<Family | null>(null);

const isFamily = (name: unknown): name is Family => name === fonts.body || name === fonts.display;

// React Native's `Text`, in the theme's colour and fonts. Every screen uses this one.
export function Text({ style, ...props }: TextProps) {
  const inherited = useContext(Inherited);
  const flat = StyleSheet.flatten(style) ?? {};
  const nested = inherited !== null;
  const family = isFamily(flat.fontFamily) ? flat.fontFamily : (inherited ?? fonts.body);
  const changesFont = flat.fontFamily !== undefined || flat.fontWeight !== undefined;
  const resolved =
    !nested || changesFont ? resolveFont(flat.fontFamily, flat.fontWeight, family) : null;
  return (
    <Inherited.Provider value={family}>
      <RNText {...props} style={[!nested && styles.text, style, resolved]} />
    </Inherited.Provider>
  );
}

// React Native's `TextInput`, dark, with an edge that shows where to type.
export function TextInput({ style, ...props }: TextInputProps) {
  const flat = StyleSheet.flatten(style) ?? {};
  return (
    <RNTextInput
      placeholderTextColor={colors.muted}
      {...props}
      style={[styles.input, style, resolveFont(flat.fontFamily, flat.fontWeight)]}
    />
  );
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  style?: StyleProp<ViewStyle>;
};

// A button whose accessible name is exactly its label.
export function Button({
  label,
  onPress,
  disabled,
  testID,
  variant = 'primary',
  style,
}: ButtonProps) {
  return (
    <Pressable
      testID={testID}
      role="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text style={[styles.label, styles[`${variant}Label`]]}>{label}</Text>
    </Pressable>
  );
}

type ScreenProps = {
  children: ReactNode;
  width?: keyof typeof maxWidth;
  testID?: string;
};

// A screen's scrolling body, with the content kept to a readable width.
export function Screen({ children, width = 'normal', testID }: ScreenProps) {
  return (
    <ScrollView
      testID={testID}
      style={styles.screen}
      contentContainerStyle={[styles.screenContent, { maxWidth: maxWidth[width] }]}
    >
      {children}
    </ScrollView>
  );
}

export function Card({
  children,
  testID,
  style,
}: {
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View testID={testID} style={[styles.card, style]}>
      {children}
    </View>
  );
}

// The title of a tab screen, which has no navigation header of its own.
export function TabHeader({ title, children }: { title: string; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.tabHeader, { paddingTop: insets.top + space.xl }]}>
      <Text role="heading" style={styles.tabTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

// A small count, such as the games waiting in the inbox.
export function Badge({
  label,
  testID,
  ariaLabel,
}: {
  label: string;
  testID?: string;
  ariaLabel?: string;
}) {
  return (
    <View style={styles.badge}>
      <Text testID={testID} aria-label={ariaLabel} style={styles.badgeText}>
        {label}
      </Text>
    </View>
  );
}

// Shared text styles, for the patterns every screen repeats.
export const textStyles = StyleSheet.create({
  display: { fontFamily: fonts.display, fontWeight: '700', fontSize: 28, letterSpacing: 0.5 },
  heading: { fontFamily: fonts.display, fontWeight: '700', fontSize: 22, letterSpacing: 0.4 },
  subheading: { fontFamily: fonts.display, fontWeight: '600', fontSize: 18, letterSpacing: 0.4 },
  // A small capitalised label above a section or a column.
  kicker: {
    fontFamily: fonts.display,
    fontWeight: '600',
    fontSize: 14,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  muted: { color: colors.muted },
  error: { color: colors.danger },
  notice: { color: colors.notice },
  link: { color: colors.accent, ...font(fonts.body, 600) },
  number: { fontFamily: fonts.display, fontWeight: '700', fontVariant: ['tabular-nums'] },
});

const styles = StyleSheet.create({
  text: { color: colors.text, fontSize: 16 },
  input: {
    color: colors.text,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.accent },
  secondary: { borderWidth: 1.5, borderColor: colors.accent },
  ghost: {},
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
  label: { fontFamily: fonts.display, fontWeight: '700', fontSize: 18, letterSpacing: 0.6 },
  primaryLabel: { color: colors.onAccent },
  secondaryLabel: { color: colors.accent },
  ghostLabel: { color: colors.text, fontFamily: fonts.body, fontWeight: '500', fontSize: 16 },
  screen: { flex: 1, backgroundColor: colors.bg },
  tabHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: colors.bg,
  },
  tabTitle: {
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 30,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  screenContent: { width: '100%', padding: space.lg, gap: space.lg, alignSelf: 'center' },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  badge: {
    minWidth: 26,
    height: 26,
    paddingHorizontal: 8,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.onAccent, fontFamily: fonts.display, fontWeight: '700', fontSize: 15 },
});
