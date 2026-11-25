import { Tabs, TabList, TabSlot, TabTrigger } from 'expo-router/ui';
import { currentMembership, useMe } from '../../src/api/hooks';
import { RecordButton, TabButton, useTabBarStyle } from '../../src/tabBar';

export default function TabLayout() {
  const me = useMe();
  // Only an approved member has anywhere to go; the screens redirect everyone else.
  const barStyle = useTabBarStyle(currentMembership(me.data)?.status === 'approved');
  // The triggers must be the list's own children: that's where `Tabs` reads its routes from.
  return (
    <Tabs style={{ flex: 1 }}>
      <TabSlot />
      <TabList style={barStyle}>
        <TabTrigger name="index" href="/" asChild>
          <TabButton label="Home" testID="tab-home" />
        </TabTrigger>
        <TabTrigger name="games" href="/games" asChild>
          <TabButton label="Games" testID="tab-games" />
        </TabTrigger>
        <RecordButton />
        <TabTrigger name="stats" href="/stats" asChild>
          <TabButton label="Stats" testID="tab-stats" />
        </TabTrigger>
        <TabTrigger name="league" href="/league" asChild>
          <TabButton label="League" testID="tab-league" />
        </TabTrigger>
      </TabList>
    </Tabs>
  );
}
