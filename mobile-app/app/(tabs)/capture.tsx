import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenShell } from "../../src/components/ScreenShell";
import { submitInboxItem } from "../../src/lib/api";
import { useSessionStore } from "../../src/store/session";
import { palette, spacing } from "../../src/theme";

export default function CaptureScreen() {
  const session = useSessionStore((state) => state.session);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [pickedAsset, setPickedAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [statusText, setStatusText] = useState("可将图片、链接和备注发送到桌面端的 mobile_inbox。");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handlePickAsset = async (source: "camera" | "library") => {
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    if (!result.canceled) {
      setPickedAsset(result.assets[0]);
    }
  };

  const handleSubmit = async () => {
    if (!session) {
      setStatusText("请先完成桌面端配对。");
      return;
    }

    if (!pickedAsset && !url.trim() && !note.trim() && !title.trim()) {
      setStatusText("请先输入链接、备注或选择图片。");
      return;
    }

    setIsSubmitting(true);
    try {
      const assetBase64 = pickedAsset?.uri
        ? await FileSystem.readAsStringAsync(pickedAsset.uri, { encoding: FileSystem.EncodingType.Base64 })
        : null;
      const captureKind = pickedAsset ? "image" : url.trim() ? "url" : "note";
      const response = await submitInboxItem(session.baseUrl, session.deviceToken, {
        captureKind,
        title: title.trim() || null,
        note: note.trim() || null,
        url: url.trim() || null,
        fileName: pickedAsset?.fileName || null,
        mimeType: pickedAsset?.mimeType || null,
        assetBase64,
        createdAt: new Date().toISOString(),
      });
      setStatusText(`已写入桌面端收件箱：${response.id}`);
      setTitle("");
      setUrl("");
      setNote("");
      setPickedAsset(null);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ScreenShell title="采集" subtitle="先把图片、URL 和备注落到桌面端收件箱，再由桌面端统一处理。">
      <View style={styles.panel}>
        <TextInput placeholder="标题（可选）" placeholderTextColor={palette.slate} value={title} onChangeText={setTitle} style={styles.input} />
        <TextInput placeholder="URL（可选）" placeholderTextColor={palette.slate} value={url} onChangeText={setUrl} autoCapitalize="none" style={styles.input} />
        <TextInput
          placeholder="备注（可选）"
          placeholderTextColor={palette.slate}
          value={note}
          onChangeText={setNote}
          multiline
          style={[styles.input, styles.textarea]}
        />

        <View style={styles.actionRow}>
          <Pressable style={styles.secondaryButton} onPress={() => void handlePickAsset("camera")}>
            <Text style={styles.secondaryButtonText}>拍照</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => void handlePickAsset("library")}>
            <Text style={styles.secondaryButtonText}>选图</Text>
          </Pressable>
        </View>

        {pickedAsset ? <Text style={styles.assetText}>已选图片：{pickedAsset.fileName || pickedAsset.uri}</Text> : null}

        <Pressable style={[styles.primaryButton, isSubmitting && styles.disabled]} onPress={() => void handleSubmit()} disabled={isSubmitting}>
          {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>发送到桌面收件箱</Text>}
        </Pressable>
      </View>

      <View style={styles.statusPanel}>
        <Text style={styles.statusTitle}>状态</Text>
        <Text style={styles.statusText}>{statusText}</Text>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 24,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  input: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.canvas,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: palette.ink,
  },
  textarea: {
    minHeight: 120,
    textAlignVertical: "top",
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 16,
    backgroundColor: palette.secondarySoft,
    alignItems: "center",
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: palette.secondary,
    fontWeight: "800",
  },
  assetText: {
    color: palette.slate,
    fontSize: 13,
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
  disabled: {
    opacity: 0.75,
  },
  statusPanel: {
    borderRadius: 22,
    padding: spacing.lg,
    backgroundColor: palette.secondarySoft,
    gap: spacing.xs,
  },
  statusTitle: {
    color: palette.secondary,
    fontWeight: "800",
  },
  statusText: {
    color: palette.ink,
    lineHeight: 22,
  },
});
