import type { StatsScope } from '@beer-die/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Season tabs arrive with seasons.
export const SCOPES: Array<{ scope: StatsScope; label: string }> = [
  { scope: 'combined', label: 'Combined' },
  { scope: 'exhibition', label: 'Exhibition' },
  { scope: 'alltime', label: 'All-time' },
];

export const SCOPE_NOTES: Record<StatsScope, string> = {
  combined: 'Every counted game.',
  exhibition: 'Exhibition games only.',
  alltime: 'Season games from every season.',
};

// The API leaves a rate null until the player has a game in the scope.
export const percent = (rate: number | null) =>
  rate === null ? '–' : `${(rate * 100).toFixed(1)}%`;

export const perGame = (rate: number | null, digits: number) =>
  rate === null ? '–' : rate.toFixed(digits);

type ScopeTabsProps = { value: StatsScope; onChange: (scope: StatsScope) => void };

export function ScopeTabs({ value, onChange }: ScopeTabsProps) {
  return (
    <View role="tablist" style={styles.tabs}>
      {SCOPES.map(({ scope, label }) => {
        const selected = scope === value;
        return (
          <Pressable
            key={scope}
            testID={`scope-${scope}`}
            role="tab"
            aria-selected={selected}
            onPress={() => onChange(scope)}
            style={[styles.tab, selected && styles.selected]}
          >
            <Text style={selected ? styles.selectedText : styles.tabText}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tab: {
    borderWidth: 1,
    borderColor: '#1d4ed8',
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  selected: { backgroundColor: '#1d4ed8' },
  tabText: { color: '#1d4ed8', fontWeight: '600' },
  selectedText: { color: '#fff', fontWeight: '600' },
});
