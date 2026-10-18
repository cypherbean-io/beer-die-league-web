import { Pressable, StyleSheet, Text } from 'react-native';

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  variant?: 'primary' | 'secondary';
};

export function Button({ label, onPress, disabled, testID, variant = 'primary' }: ButtonProps) {
  return (
    <Pressable
      testID={testID}
      role="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, styles[variant], disabled && styles.disabled]}
    >
      <Text style={variant === 'primary' ? styles.primaryText : styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  primary: { backgroundColor: '#1d4ed8' },
  secondary: { borderWidth: 1, borderColor: '#1d4ed8' },
  disabled: { opacity: 0.5 },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryText: { color: '#1d4ed8', fontSize: 16, fontWeight: '600' },
});
