import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResponsiveLayout } from "../../src/lib/responsiveLayout";
import { palette } from "../../src/theme";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

function TabIcon({
  name,
  color,
  focused,
}: {
  name: IoniconName;
  color: string;
  focused: boolean;
}) {
  return <Ionicons name={name} size={focused ? 22 : 20} color={color} />;
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const layout = useResponsiveLayout();
  const useSideTabs = layout.isTabletLandscape;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarPosition: useSideTabs ? "left" : "bottom",
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.slate,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
        tabBarStyle: {
          backgroundColor: "#fffdf9",
          borderTopColor: useSideTabs ? "transparent" : "#ddd7cf",
          borderRightColor: useSideTabs ? "#ddd7cf" : "transparent",
          borderRightWidth: useSideTabs ? 1 : 0,
          width: useSideTabs ? (layout.size === "large" ? 96 : 88) : undefined,
          height: useSideTabs ? undefined : 54 + insets.bottom,
          paddingTop: useSideTabs ? Math.max(insets.top, 8) : 6,
          paddingBottom: useSideTabs
            ? Math.max(insets.bottom, 8)
            : insets.bottom,
        },
        tabBarItemStyle: useSideTabs ? { minHeight: 64 } : undefined,
      }}
    >
      <Tabs.Screen
        name="review"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: "知识",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "albums" : "albums-outline"}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="papers"
        options={{
          title: "论文",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "document-text" : "document-text-outline"}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "聊天",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={
                focused ? "chatbubble-ellipses" : "chatbubble-ellipses-outline"
              }
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "\u8bbe\u7f6e",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "settings" : "settings-outline"}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
    </Tabs>
  );
}
