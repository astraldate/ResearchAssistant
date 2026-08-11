import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ScreenShell } from "../../src/components/ScreenShell";
import { clearAllCachedData } from "../../src/lib/database";
import {
  clearCachedPdfs,
  deleteCachedPdf,
  formatCacheSize,
  listCachedPdfs,
  type CachedPdfItem,
} from "../../src/lib/pdfCache";
import { bootstrapSync } from "../../src/lib/sync";
import { formatLocalDateTime } from "../../src/lib/time";
import { persistSession, useSessionStore } from "../../src/store/session";
import { palette, spacing } from "../../src/theme";

export default function SettingsScreen() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const isSyncing = useSessionStore((state) => state.isSyncing);
  const lastSyncAt = useSessionStore((state) => state.lastSyncAt);
  const lastSyncError = useSessionStore((state) => state.lastSyncError);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [isManagingCache, setIsManagingCache] = useState(false);
  const pdfCacheQuery = useQuery({
    queryKey: ["pdf-cache"],
    queryFn: listCachedPdfs,
  });
  const cachedPdfs = pdfCacheQuery.data ?? [];
  const totalCacheBytes = cachedPdfs.reduce(
    (total, item) => total + item.sizeBytes,
    0,
  );

  const handleLogout = async () => {
    await clearCachedPdfs();
    await persistSession(null);
    await clearAllCachedData();
    router.replace("/pair");
  };

  const handleFullSync = async () => {
    await bootstrapSync();
    await queryClient.invalidateQueries({ queryKey: ["cards"] });
    await queryClient.invalidateQueries({ queryKey: ["notes"] });
    await queryClient.invalidateQueries({ queryKey: ["due-review-cards"] });
  };

  const handleDeletePdfCache = async (item: CachedPdfItem) => {
    setIsManagingCache(true);
    setCacheMessage(null);
    try {
      await deleteCachedPdf(item);
      await pdfCacheQuery.refetch();
      setCacheMessage("已删除该 PDF 缓存。");
    } catch (error) {
      setCacheMessage(
        `删除失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsManagingCache(false);
    }
  };

  const handleClearPdfCache = async () => {
    setIsManagingCache(true);
    setCacheMessage(null);
    try {
      await clearCachedPdfs();
      await pdfCacheQuery.refetch();
      setCacheMessage("已清空 PDF 离线缓存。");
    } catch (error) {
      setCacheMessage(
        `清空失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsManagingCache(false);
    }
  };

  return (
    <ScreenShell title="设置" subtitle="管理桌面连接、资料同步与离线缓存。">
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>当前设备</Text>
        <Text style={styles.line}>
          设备 ID：{session?.deviceId || "未配对"}
        </Text>
        <Text style={styles.line}>桌面端：{session?.baseUrl || "未配对"}</Text>
        <Text style={styles.line}>
          配对时间：{formatLocalDateTime(session?.pairedAt) || "未配对"}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>同步</Text>
        <Text style={styles.line}>
          最后成功同步：{formatLocalDateTime(lastSyncAt) || "尚无记录"}
        </Text>
        <Text style={styles.line}>
          同步状态：{isSyncing ? "同步中" : "空闲"}
        </Text>
        {lastSyncError ? (
          <Text style={styles.errorText}>{lastSyncError}</Text>
        ) : null}
        <Pressable
          style={[
            styles.primaryButton,
            isSyncing ? styles.primaryButtonDisabled : null,
          ]}
          onPress={() => void handleFullSync()}
          disabled={isSyncing}
        >
          <Text style={styles.primaryButtonText}>
            {isSyncing ? "同步中" : "立即全量同步"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>PDF 离线缓存</Text>
        <Text style={styles.line}>
          已缓存 {cachedPdfs.length} 个文件，占用{" "}
          {formatCacheSize(totalCacheBytes)}
        </Text>
        {cacheMessage ? (
          <Text
            style={[
              styles.line,
              cacheMessage.includes("失败")
                ? styles.errorText
                : styles.successText,
            ]}
          >
            {cacheMessage}
          </Text>
        ) : null}
        {pdfCacheQuery.isLoading ? (
          <Text style={styles.line}>正在读取缓存...</Text>
        ) : cachedPdfs.length ? (
          cachedPdfs.map((item) => (
            <View
              key={`${item.sourceType}:${item.sourceId}`}
              style={styles.cacheRow}
            >
              <View style={styles.cacheText}>
                <Text style={styles.cacheTitle} numberOfLines={1}>
                  {item.fileName}
                </Text>
                <Text style={styles.cacheMeta}>
                  {sourceTypeLabel(item.sourceType)} ·{" "}
                  {formatCacheSize(item.sizeBytes)}
                  {!item.exists ? " · 文件缺失" : ""}
                </Text>
                <Text style={styles.cacheMeta}>
                  {formatLocalDateTime(item.downloadedAt)}
                </Text>
              </View>
              <Pressable
                style={[
                  styles.smallDangerButton,
                  isManagingCache ? styles.primaryButtonDisabled : null,
                ]}
                onPress={() => void handleDeletePdfCache(item)}
                disabled={isManagingCache}
              >
                <Text style={styles.smallDangerButtonText}>删除</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={styles.line}>暂无 PDF 离线缓存。</Text>
        )}
        <Pressable
          style={[
            styles.ghostButton,
            cachedPdfs.length === 0 || isManagingCache
              ? styles.primaryButtonDisabled
              : null,
          ]}
          onPress={() => void handleClearPdfCache()}
          disabled={cachedPdfs.length === 0 || isManagingCache}
        >
          <Text style={styles.ghostButtonText}>
            {isManagingCache ? "处理中..." : "清空 PDF 缓存"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>数据与 AI</Text>
        <Text style={styles.line}>
          桌面端负责模型推理与主数据存储；手机端用于同步浏览、采集、对话、PDF
          AI、创新分析与离线复习。
        </Text>
        <Text style={styles.noticeText}>
          本应用提供科研辅助，不构成医疗、诊断或治疗建议。AI
          翻译、解释、引用与创新假设可能存在遗漏或错误，请以论文原文、完整检索、专业判断和实验验证为准。
        </Text>
        <Text style={styles.line}>
          数据是否离开设备，取决于桌面端启用的模型与外部资料服务。
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>危险操作</Text>
        <Pressable
          style={styles.ghostButton}
          onPress={() => void handleLogout()}
        >
          <Text style={styles.ghostButtonText}>清空本地缓存并重新配对</Text>
        </Pressable>
      </View>
    </ScreenShell>
  );
}

function sourceTypeLabel(value: string) {
  if (value === "card") return "卡片 PDF";
  if (value === "workspacePdf") return "工作区 PDF";
  return "论文 PDF";
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
  successText: {
    color: palette.success,
  },
  noticeText: {
    color: "#795500",
    lineHeight: 22,
    borderRadius: 14,
    backgroundColor: palette.secondarySoft,
    padding: spacing.md,
  },
  primaryButton: {
    marginTop: spacing.sm,
    borderRadius: 999,
    backgroundColor: palette.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
  },
  primaryButtonDisabled: {
    opacity: 0.65,
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
  cacheRow: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#fffefb",
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  cacheText: {
    flex: 1,
    gap: spacing.xs,
  },
  cacheTitle: {
    color: palette.ink,
    fontWeight: "800",
  },
  cacheMeta: {
    color: palette.slate,
    fontSize: 12,
  },
  smallDangerButton: {
    borderRadius: 999,
    backgroundColor: "#fff5f3",
    borderWidth: 1,
    borderColor: "#e7c9c3",
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  smallDangerButtonText: {
    color: palette.danger,
    fontWeight: "800",
  },
});
