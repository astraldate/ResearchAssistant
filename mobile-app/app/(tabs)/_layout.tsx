import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
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
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.slate,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
        tabBarStyle: {
          backgroundColor: "#fffdf9",
          borderTopColor: "#ddd7cf",
          height: 62,
          paddingTop: 6,
          paddingBottom: 8,
        },
      }}
    >
      <Tabs.Screen
        name="review"
        options={{
          title: "\u590d\u4e60",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "refresh-circle" : "refresh-circle-outline"}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: "\u5361\u7247\u5e93",
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
          title: "\u91c7\u96c6",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? "scan-circle" : "scan-circle-outline"}
              color={color}
              focused={focused}
            />
          ),
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
