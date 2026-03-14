import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ScreenShell } from "../../src/components/ScreenShell";
import { clearAllCachedData } from "../../src/lib/database";
import { bootstrapSync } from "../../src/lib/sync";
import { persistSession, useSessionStore } from "../../src/store/session";
import { palette, spacing } from "../../src/theme";

export default function SettingsScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const isSyncing = useSessionStore((state) => state.isSyncing);
  const lastSyncAt = useSessionStore((state) => state.lastSyncAt);
  const lastSyncError = useSessionStore((state) => state.lastSyncError);

  const handleLogout = async () => {
    await persistSession(null);
    await clearAllCachedData();
    router.replace("/pair");
  };

  return (
    <ScreenShell title="设置" subtitle="桌面端仍然是唯一权威节点，手机端只负责缓存、采集和离线复习。">
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>当前设备</Text>
        <Text style={styles.line}>设备 ID：{session?.deviceId || "未配对"}</Text>
        <Text style={styles.line}>桌面端：{session?.baseUrl || "未配对"}</Text>
        <Text style={styles.line}>配对时间：{session?.pairedAt || "未配对"}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>同步</Text>
        <Text style={styles.line}>最后成功同步：{lastSyncAt || "尚无记录"}</Text>
        <Text style={styles.line}>同步状态：{isSyncing ? "同步中" : "空闲"}</Text>
        {lastSyncError ? <Text style={styles.errorText}>{lastSyncError}</Text> : null}
        <Pressable style={styles.primaryButton} onPress={() => void bootstrapSync()}>
          <Text style={styles.primaryButtonText}>立即全量同步</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>危险操作</Text>
        <Pressable style={styles.ghostButton} onPress={() => void handleLogout()}>
          <Text style={styles.ghostButtonText}>清空本地缓存并重新配对</Text>
        </Pressable>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    color: palette.ink,
    fontSize: 18,
    fontWeight: "800",
  },
  line: {
    color: palette.slate,
    lineHeight: 22,
  },
  errorText: {
    color: palette.danger,
    lineHeight: 22,
  },
  primaryButton: {
    marginTop: spacing.sm,
    borderRadius: 999,
    backgroundColor: palette.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: "#fff",
    fontWeight: "800",
  },
  ghostButton: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#e7c9c3",
    backgroundColor: "#fff5f3",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
  },
  ghostButtonText: {
    color: palette.danger,
    fontWeight: "800",
  },
});
