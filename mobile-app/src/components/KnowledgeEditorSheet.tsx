import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { palette, spacing } from "../theme";
import { MobileMarkdown } from "./MobileMarkdown";

export type KnowledgeEditorValue = {
  term: string;
  title: string;
  markdown: string;
};

type Props = {
  visible: boolean;
  kind: "card" | "note";
  mode: "create" | "edit";
  initialValue: KnowledgeEditorValue;
  saving: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (value: KnowledgeEditorValue) => void;
};

export function KnowledgeEditorSheet({
  visible,
  kind,
  mode,
  initialValue,
  saving,
  error,
  onClose,
  onSave,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [view, setView] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    if (!visible) return;
    setValue(initialValue);
    setView("edit");
  }, [initialValue, visible]);

  const dirty = useMemo(
    () => JSON.stringify(value) !== JSON.stringify(initialValue),
    [initialValue, value],
  );
  const valid =
    value.title.trim().length > 0 &&
    value.markdown.trim().length > 0 &&
    (kind === "note" || value.term.trim().length > 0);

  const requestClose = () => {
    if (saving) return;
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert("放弃未保存修改？", "关闭后，本次编辑内容不会保留。", [
      { text: "继续编辑", style: "cancel" },
      { text: "放弃", style: "destructive", onPress: onClose },
    ]);
  };

  const entityLabel = kind === "card" ? "知识卡片" : "论文笔记";
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={requestClose}
    >
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Pressable style={styles.headerAction} onPress={requestClose}>
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
          <Text style={styles.title}>
            {mode === "create" ? "新建" : "编辑"}
            {entityLabel}
          </Text>
          <Pressable
            style={[styles.saveButton, (!valid || saving) && styles.disabled]}
            disabled={!valid || saving}
            onPress={() => onSave(value)}
          >
            <Text style={styles.saveText}>{saving ? "保存中" : "保存"}</Text>
          </Pressable>
        </View>

        <View style={styles.switcher}>
          {(["edit", "preview"] as const).map((item) => (
            <Pressable
              key={item}
              style={[styles.switchItem, view === item && styles.switchActive]}
              onPress={() => setView(item)}
            >
              <Text
                style={[
                  styles.switchText,
                  view === item && styles.switchTextActive,
                ]}
              >
                {item === "edit" ? "编辑" : "预览"}
              </Text>
            </Pressable>
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {view === "edit" ? (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.form}
            keyboardShouldPersistTaps="handled"
          >
            {kind === "card" ? (
              <View style={styles.field}>
                <Text style={styles.label}>术语 *</Text>
                <TextInput
                  value={value.term}
                  onChangeText={(term) =>
                    setValue((current) => ({ ...current, term }))
                  }
                  placeholder="例如：图神经网络"
                  placeholderTextColor={palette.slate}
                  style={styles.input}
                  maxLength={120}
                />
              </View>
            ) : null}
            <View style={styles.field}>
              <Text style={styles.label}>标题 *</Text>
              <TextInput
                value={value.title}
                onChangeText={(title) =>
                  setValue((current) => ({ ...current, title }))
                }
                placeholder={`${entityLabel}标题`}
                placeholderTextColor={palette.slate}
                style={styles.input}
                maxLength={180}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Markdown 正文 *</Text>
              <TextInput
                value={value.markdown}
                onChangeText={(markdown) =>
                  setValue((current) => ({ ...current, markdown }))
                }
                placeholder="支持标题、列表、粗体、引用和代码块"
                placeholderTextColor={palette.slate}
                multiline
                textAlignVertical="top"
                style={[styles.input, styles.markdownInput]}
                maxLength={60_000}
              />
            </View>
          </ScrollView>
        ) : (
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.preview}
          >
            <Text style={styles.previewTitle}>
              {value.title.trim() || "未命名"}
            </Text>
            <MobileMarkdown content={value.markdown} />
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.canvas },
  header: {
    minHeight: 66,
    paddingTop: Platform.OS === "android" ? spacing.sm : spacing.lg,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    backgroundColor: palette.panel,
  },
  headerAction: { minWidth: 56, minHeight: 44, justifyContent: "center" },
  cancelText: { color: palette.slate, fontSize: 16, fontWeight: "700" },
  title: {
    flex: 1,
    textAlign: "center",
    color: palette.ink,
    fontSize: 18,
    fontWeight: "900",
  },
  saveButton: {
    minWidth: 64,
    minHeight: 42,
    borderRadius: 12,
    backgroundColor: palette.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  disabled: { opacity: 0.45 },
  saveText: { color: "#fff", fontWeight: "900" },
  switcher: {
    margin: spacing.md,
    padding: 3,
    borderRadius: 14,
    backgroundColor: "#e9edf4",
    flexDirection: "row",
  },
  switchItem: {
    flex: 1,
    minHeight: 42,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  switchActive: { backgroundColor: palette.panel },
  switchText: { color: palette.slate, fontWeight: "800" },
  switchTextActive: { color: palette.primary },
  error: { color: palette.danger, paddingHorizontal: spacing.md },
  content: { flex: 1 },
  form: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
  field: { gap: spacing.xs },
  label: { color: palette.ink, fontSize: 14, fontWeight: "800" },
  input: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 14,
    backgroundColor: palette.panel,
    color: palette.ink,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  markdownInput: { minHeight: 360, lineHeight: 24 },
  preview: { padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.md },
  previewTitle: { color: palette.ink, fontSize: 22, fontWeight: "900" },
});
