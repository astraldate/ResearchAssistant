import "react-native-gesture-handler";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppProviders } from "../src/providers/AppProviders";
import { hydrateSessionStore } from "../src/store/session";

export default function RootLayout() {
  useEffect(() => {
    void hydrateSessionStore();
  }, []);

  return (
    <AppProviders>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </AppProviders>
  );
}
