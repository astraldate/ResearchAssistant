import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

type StatusTone = "info" | "error";
type InboxFilter = "pending" | "all";
type MobileCaptureKind = "image" | "url" | "note";
type MobileInboxStatus = "received" | "processed";

interface MobileInboxPanelProps {
  isActive: boolean;
  onStatus: (message: string, tone?: StatusTone, persistent?: boolean) => void;
}

interface MobileInboxItem {
  id: string;
  captureKind: MobileCaptureKind;
  status: MobileInboxStatus;
  title?: string | null;
  note?: string | null;
  url?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  storedAssetPath?: string | null;
  deviceId: string;
  createdAt: string;
  recordPath: string;
}

const CAPTURE_KIND_LABELS: Record<MobileCaptureKind, string> = {
  image: "图片采集",
  url: "网页链接",
  note: "文字笔记",
};

const STATUS_LABELS: Record<MobileInboxStatus, string> = {
  received: "待处理",
  processed: "已处理",
};

const buildFallbackTitle = (item: MobileInboxItem) => {
  if (item.fileName?.trim()) {
    return item.fileName.trim();
  }
  return CAPTURE_KIND_LABELS[item.captureKind];
};

const buildSubtitle = (item: MobileInboxItem) => {
  const parts = [CAPTURE_KIND_LABELS[item.captureKind], item.createdAt];
  if (item.deviceId.trim()) {
    parts.push(`设备 ${item.deviceId.slice(0, 8)}`);
  }
  return parts.join(" · ");
};

export const MobileInboxPanel: React.FC<MobileInboxPanelProps> = ({
  isActive,
  onStatus,
}) => {
  const [items, setItems] = useState<MobileInboxItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>("pending");

  const loadItems = useCallback(async () => {
    setIsLoading(true);
    try {
      const nextItems = await invoke<MobileInboxItem[]>(
        "list_mobile_inbox_items",
      );
      setItems(nextItems);
    } catch (error) {
      onStatus(`加载移动端收件箱失败：${String(error)}`, "error", true);
    } finally {
      setIsLoading(false);
    }
  }, [onStatus]);

  useEffect(() => {
    if (!isActive) return;
    void loadItems();
  }, [isActive, loadItems]);

  const pendingCount = useMemo(
    () => items.filter((item) => item.status === "received").length,
    [items],
  );

  const visibleItems = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((item) => item.status === "received");
  }, [filter, items]);

  const handleToggleProcessed = async (
    item: MobileInboxItem,
    processed: boolean,
  ) => {
    setUpdatingItemId(item.id);
    try {
      const updated = await invoke<MobileInboxItem>(
        "set_mobile_inbox_item_status",
        {
          itemId: item.id,
          processed,
        },
      );
      setItems((current) =>
        current
          .map((entry) => (entry.id === updated.id ? updated : entry))
          .sort((left, right) => {
            const leftRank = left.status === "received" ? 0 : 1;
            const rightRank = right.status === "received" ? 0 : 1;
            if (leftRank !== rightRank) return leftRank - rightRank;
            return right.createdAt.localeCompare(left.createdAt);
          }),
      );
      onStatus(
        processed ? "收件箱条目已标记为已处理。" : "收件箱条目已恢复为待处理。",
      );
    } catch (error) {
      onStatus(`更新收件箱条目失败：${String(error)}`, "error", true);
    } finally {
      setUpdatingItemId(null);
    }
  };

  const handleOpenAsset = async (path: string) => {
    try {
      await invoke("open_file", { path });
    } catch (error) {
      onStatus(`打开附件失败：${String(error)}`, "error", true);
    }
  };

  const handleRevealPath = async (path: string) => {
    try {
      await invoke("reveal_in_explorer", { path });
    } catch (error) {
      onStatus(`显示文件位置失败：${String(error)}`, "error", true);
    }
  };

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      onStatus(`已复制链接：${url}`);
    } catch (error) {
      onStatus(`复制链接失败：${String(error)}`, "error", true);
    }
  };

  return (
    <div className="mobile-inbox-panel">
      <div className="main-view-header">
        <div>
          <div className="main-view-title">待处理收件箱</div>
          <div className="main-view-subtitle">
            接收移动端提交的图片、链接和笔记。
            {items.length > 0 ? ` · 共 ${items.length} 条` : ""}
            {pendingCount > 0 ? ` · 待处理 ${pendingCount} 条` : ""}
          </div>
        </div>
        <div className="card-library-actions">
          <button
            className="action-button"
            onClick={() => void loadItems()}
            disabled={isLoading}
          >
            <RefreshCw size={14} className={isLoading ? "spin" : undefined} />
            刷新
          </button>
        </div>
      </div>

      <div className="mobile-inbox-toolbar">
        <div className="mobile-inbox-filter-group">
          <button
            className={`tab-button ${filter === "pending" ? "active" : ""}`}
            onClick={() => setFilter("pending")}
          >
            待处理
            <span>{pendingCount}</span>
          </button>
          <button
            className={`tab-button ${filter === "all" ? "active" : ""}`}
            onClick={() => setFilter("all")}
          >
            全部
            <span>{items.length}</span>
          </button>
        </div>
      </div>

      {!isLoading && items.length === 0 && (
        <div className="empty-placeholder">
          移动端收件箱还是空的。可在手机端的 Capture 页发送图片、链接或笔记。
        </div>
      )}

      {!isLoading && items.length > 0 && visibleItems.length === 0 && (
        <div className="empty-placeholder">
          当前没有待处理条目。切到“全部”可查看已处理记录。
        </div>
      )}

      <div className="mobile-inbox-list">
        {visibleItems.map((item) => (
          <article key={item.id} className="card-item mobile-inbox-item">
            <div className="mobile-inbox-item-header">
              <div className="mobile-inbox-item-title-block">
                <div className="card-item-title">
                  {item.title?.trim() || buildFallbackTitle(item)}
                </div>
                <div className="card-item-meta">{buildSubtitle(item)}</div>
              </div>
              <div
                className={`status-chip ${item.status === "processed" ? "muted" : ""}`}
              >
                {STATUS_LABELS[item.status]}
              </div>
            </div>

            {item.note?.trim() && (
              <div className="mobile-inbox-item-note">{item.note.trim()}</div>
            )}

            {item.url?.trim() && (
              <div className="settings-path-box">{item.url.trim()}</div>
            )}

            <div className="mobile-inbox-item-meta-grid">
              <div className="mobile-inbox-item-label">文件名</div>
              <div>{item.fileName?.trim() || "无"}</div>
              <div className="mobile-inbox-item-label">MIME</div>
              <div>{item.mimeType?.trim() || "无"}</div>
              <div className="mobile-inbox-item-label">附件</div>
              <div>{item.storedAssetPath?.trim() || "无"}</div>
            </div>

            <div className="card-item-actions">
              <button
                className="action-button"
                onClick={() =>
                  void handleToggleProcessed(item, item.status !== "processed")
                }
                disabled={updatingItemId === item.id}
              >
                {item.status === "processed" ? (
                  <RotateCcw size={14} />
                ) : (
                  <Check size={14} />
                )}
                {item.status === "processed" ? "恢复待处理" : "标记已处理"}
              </button>
              {item.storedAssetPath && (
                <button
                  className="action-button"
                  onClick={() => void handleOpenAsset(item.storedAssetPath!)}
                >
                  <ExternalLink size={14} />
                  打开附件
                </button>
              )}
              {item.url && (
                <button
                  className="action-button"
                  onClick={() => void handleCopyUrl(item.url!)}
                >
                  <Copy size={14} />
                  复制链接
                </button>
              )}
              <button
                className="action-button"
                onClick={() => void handleRevealPath(item.recordPath)}
              >
                <FolderOpen size={14} />
                显示记录
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};
