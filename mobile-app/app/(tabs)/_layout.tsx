import { Tabs } from "expo-router";
import { palette } from "../../src/theme";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.slate,
        tabBarStyle: {
          backgroundColor: "#fffdf9",
          borderTopColor: "#ddd7cf",
        },
      }}
    >
      <Tabs.Screen name="review" options={{ title: "复习" }} />
      <Tabs.Screen name="library" options={{ title: "卡片库" }} />
      <Tabs.Screen name="capture" options={{ title: "采集" }} />
      <Tabs.Screen name="settings" options={{ title: "设置" }} />
    </Tabs>
  );
}
