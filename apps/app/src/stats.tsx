import { type Season, scopeSeasonId, seasonScope, type StatsScope } from '@beer-die/core';
import { useQuery } from '@tanstack/react-query';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getSeasons } from './api/client';

const SCOPES: Array<{ scope: StatsScope; label: string }> = [
  { scope: 'combined', label: 'Combined' },
  { scope: 'exhibition', label: 'Exhibition' },
  { scope: 'alltime', label: 'All-time' },
];

// The seasons with stats to show: every one that has started, newest first.
export function useStatsSeasons(leagueId: string): Season[] {
  const seasons = useQuery({
    queryKey: ['seasons', leagueId],
    queryFn: () => getSeasons(leagueId),
  });
  return (seasons.data ?? []).filter((s) => s.status !== 'draft');
}

export function scopeNote(scope: StatsScope, seasons: Season[]): string {
  const seasonId = scopeSeasonId(scope);
  if (seasonId !== null) {
    const name = seasons.find((s) => s.id === seasonId)?.name ?? 'this season';
    return `Games in ${name}, subs included.`;
  }
  if (scope === 'exhibition') return 'Exhibition games only.';
  if (scope === 'alltime') return 'Season games from every season.';
  return 'Every counted game.';
}

// The API leaves a rate null until the player has a game in the scope.
export const percent = (rate: number | null) =>
  rate === null ? '–' : `${(rate * 100).toFixed(1)}%`;

export const perGame = (rate: number | null, digits: number) =>
  rate === null ? '–' : rate.toFixed(digits);

type ScopeTabsProps = {
  value: StatsScope;
  seasons: Season[];
  onChange: (scope: StatsScope) => void;
};

// A tab per started season, newest first, then the scopes that span seasons.
export function ScopeTabs({ value, seasons, onChange }: ScopeTabsProps) {
  const tabs = [
    ...seasons.map((s) => ({
      scope: seasonScope(s.id),
      label: s.name,
      testID: `scope-season-${s.id}`,
    })),
    ...SCOPES.map((s) => ({ ...s, testID: `scope-${s.scope}` })),
  ];
  return (
    <View role="tablist" style={styles.tabs}>
      {tabs.map(({ scope, label, testID }) => {
        const selected = scope === value;
        return (
          <Pressable
            key={scope}
            testID={testID}
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
