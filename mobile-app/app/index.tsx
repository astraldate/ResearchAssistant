import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useSessionStore } from "../src/store/session";
import { palette, spacing } from "../src/theme";

export default function IndexScreen() {
  const hydrated = useSessionStore((state) => state.hydrated);
  const session = useSessionStore((state) => state.session);

  if (!hydrated) {
    return (
      <View style={styles.loadingShell}>
        <ActivityIndicator color={palette.primary} />
        <Text style={styles.loadingText}>正在恢复移动端会话...</Text>
      </View>
    );
  }

  return <Redirect href={session ? "/(tabs)/review" : "/pair"} />;
}

const styles = StyleSheet.create({
  loadingShell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: palette.cloud,
  },
  loadingText: {
    color: palette.slate,
  },
});
