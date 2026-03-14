import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenShell } from "../src/components/ScreenShell";
import { bootstrapSync } from "../src/lib/sync";
import { checkDesktopService, pairDesktopService } from "../src/lib/api";
import { persistSession } from "../src/store/session";
import { palette, spacing } from "../src/theme";

export default function PairScreen() {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [deviceName, setDeviceName] = useState("My Phone");
  const [statusText, setStatusText] = useState("先在桌面端设置页查看局域网地址和 6 位配对码。");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handlePair = async () => {
    const normalizedBaseUrl = baseUrl.trim();
    if (!normalizedBaseUrl) {
      setStatusText("请输入桌面端设置页显示的局域网地址。");
      return;
    }
    if (!pairCode.trim()) {
      setStatusText("请输入 6 位配对码。");
      return;
    }

    setIsSubmitting(true);
    try {
      setStatusText("正在检查桌面端移动服务...");
      const health = await checkDesktopService(normalizedBaseUrl);
      if (!health.running) {
        throw new Error("桌面端移动配套服务尚未就绪。请先打开桌面端设置页确认状态。");
      }

      setStatusText("正在建立配对并拉取桌面端卡片...");
      const paired = await pairDesktopService(normalizedBaseUrl, {
        pairCode: pairCode.trim(),
        deviceName: deviceName.trim() || "My Phone",
        appVersion: "0.1.0",
      });
      const nextBaseUrl = paired.baseUrls[0] || normalizedBaseUrl;
      await persistSession({
        baseUrl: nextBaseUrl,
        deviceId: paired.deviceId,
        deviceToken: paired.deviceToken,
        deviceName: deviceName.trim() || "My Phone",
        pairedAt: paired.pairedAt,
      });
      await bootstrapSync();
      setStatusText("配对成功，已同步桌面端卡片。");
      router.replace("/(tabs)/review");
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ScreenShell
      title="配对桌面端"
      subtitle="手机和电脑接入同一局域网后，输入桌面端设置页显示的地址和配对码。"
    >
      <View style={styles.panel}>
        <Text style={styles.label}>桌面端地址</Text>
        <TextInput
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          placeholder="例如 http://192.168.1.20:38465"
          placeholderTextColor={palette.slate}
          style={styles.input}
        />

        <Text style={styles.label}>6 位配对码</Text>
        <TextInput value={pairCode} onChangeText={setPairCode} keyboardType="number-pad" style={styles.input} />

        <Text style={styles.label}>设备名</Text>
        <TextInput value={deviceName} onChangeText={setDeviceName} style={styles.input} />

        <Pressable style={[styles.primaryButton, isSubmitting && styles.buttonDisabled]} onPress={() => void handlePair()} disabled={isSubmitting}>
          {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>开始配对</Text>}
        </Pressable>
      </View>

      <View style={styles.statusCard}>
        <Text style={styles.statusTitle}>状态</Text>
        <Text style={styles.statusText}>{statusText}</Text>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 24,
    padding: spacing.lg,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    gap: spacing.sm,
  },
  label: {
    color: palette.slate,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  input: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.canvas,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: palette.ink,
  },
  primaryButton: {
    marginTop: spacing.sm,
    borderRadius: 999,
    backgroundColor: palette.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  statusCard: {
    borderRadius: 22,
    padding: spacing.lg,
    backgroundColor: palette.primarySoft,
    gap: spacing.xs,
  },
  statusTitle: {
    color: palette.primary,
    fontWeight: "800",
  },
  statusText: {
    color: palette.ink,
    lineHeight: 22,
  },
});
