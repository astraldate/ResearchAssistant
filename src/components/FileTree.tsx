import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

export interface FileNode {
  id: string;
  name: string;
  path: string;
  type_name: "file" | "folder";
  has_children?: boolean;
  children?: FileNode[] | null;
}

export interface TreeMutationPayload {
  refreshPaths: string[];
  removedPath?: string;
  rebasedPath?: {
    from: string;
    to: string;
  };
}

interface FileTreeProps {
  data?: FileNode[];
  activePath?: string | null;
  workspacePath?: string | null;
  onSelect?: (file: FileNode) => void;
  onLoadChildren?: (path: string) => Promise<FileNode[]>;
  onTreeChanged?: (payload: TreeMutationPayload) => Promise<void> | void;
  onStatus?: (
    message: string,
    tone?: "info" | "error",
    persistent?: boolean,
  ) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode | null;
  targetDirPath: string;
}

interface WorkspaceClipboardState {
  kind: "copy" | "cut";
  sourcePath: string;
  sourceType: FileNode["type_name"];
}

interface EditDialogState {
  mode: "create" | "rename";
  title: string;
  targetPath: string;
  initialValue: string;
  submitLabel: string;
}

interface DeleteDialogState {
  path: string;
  label: string;
}

const INVALID_PATH_CHARACTERS = /[<>:"/\\|?*]/;

const openFile = async (path: string) => {
  await invoke("open_file", { path });
};

const getParentPath = (path: string) => {
  const normalized = path.replace(/[\\/]+$/, "");
  const slashIndex = Math.max(
    normalized.lastIndexOf("\\"),
    normalized.lastIndexOf("/"),
  );
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : normalized;
};

const validateName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "名称不能为空。";
  if (trimmed === "." || trimmed === "..") return "名称不能为 . 或 ..。";
  if (INVALID_PATH_CHARACTERS.test(trimmed)) {
    return "名称包含非法路径字符。";
  }
  return null;
};

const TreeNode: React.FC<{
  node: FileNode;
  level: number;
  activePath?: string | null;
  onSelect?: (file: FileNode) => void;
  onLoadChildren?: (path: string) => Promise<FileNode[]>;
  onContextMenu: (event: React.MouseEvent, node: FileNode) => void;
}> = ({ node, level, activePath, onSelect, onLoadChildren, onContextMenu }) => {
  const [isOpen, setIsOpen] = useState(level === 0);
  const normalizedChildren = node.children ?? undefined;
  const [children, setChildren] = useState<FileNode[] | undefined>(
    normalizedChildren,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoadedChildren, setHasLoadedChildren] = useState(
    normalizedChildren !== undefined,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const isActive = activePath === node.path;

  useEffect(() => {
    if (node.type_name === "folder" && activePath?.startsWith(node.path)) {
      setIsOpen(true);
    }
  }, [activePath, node.path, node.type_name]);

  useEffect(() => {
    if (normalizedChildren !== undefined) {
      setChildren(normalizedChildren);
      setHasLoadedChildren(true);
      setLoadError(null);
      return;
    }

    if (!hasLoadedChildren) {
      setChildren(undefined);
      setHasLoadedChildren(false);
      setLoadError(null);
    }
  }, [hasLoadedChildren, normalizedChildren]);

  const loadChildrenIfNeeded = async () => {
    if (
      node.type_name !== "folder" ||
      hasLoadedChildren ||
      isLoading ||
      !onLoadChildren
    ) {
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const nextChildren = await onLoadChildren(node.path);
      setChildren(nextChildren);
      setHasLoadedChildren(true);
    } catch (error) {
      console.error("Failed to load tree children:", error, node.path);
      setChildren([]);
      setHasLoadedChildren(true);
      setLoadError(String(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (node.type_name === "folder" && isOpen && !hasLoadedChildren) {
      void loadChildrenIfNeeded();
    }
  }, [hasLoadedChildren, isOpen, node.type_name]);

  const handleClick = () => {
    if (node.type_name === "folder") {
      const nextOpen = !isOpen;
      setIsOpen(nextOpen);
      if (nextOpen) {
        void loadChildrenIfNeeded();
      }
      return;
    }
    onSelect?.(node);
  };

  const hasVisibleChildren = !!children && children.length > 0;
  const shouldShowEmpty =
    node.type_name === "folder" &&
    !isLoading &&
    hasLoadedChildren &&
    !loadError &&
    (!children || children.length === 0);

  return (
    <div>
      <div
        className={`tree-item ${isActive ? "active" : ""}`}
        style={{ paddingLeft: `${12 + level * 14}px` }}
        onClick={handleClick}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(event, node);
        }}
      >
        <span className="tree-item-caret">
          {node.type_name === "folder" ? (
            isOpen ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : null}
        </span>
        {node.type_name === "folder" ? (
          <Folder size={14} color="#68707f" />
        ) : (
          <File size={14} color="#68707f" />
        )}
        <span className="tree-item-label" title={node.name}>
          {node.name}
        </span>
        {shouldShowEmpty && <span className="tree-item-empty">空</span>}
      </div>

      {node.type_name === "folder" && isOpen && hasVisibleChildren && (
        <div>
          {children?.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              level={level + 1}
              activePath={activePath}
              onSelect={onSelect}
              onLoadChildren={onLoadChildren}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({
  data,
  activePath,
  workspacePath,
  onSelect,
  onLoadChildren,
  onTreeChanged,
  onStatus,
}) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [clipboardState, setClipboardState] =
    useState<WorkspaceClipboardState | null>(null);
  const [editDialog, setEditDialog] = useState<EditDialogState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );
  const [inputValue, setInputValue] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [isSubmittingDialog, setIsSubmittingDialog] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nodes = data ?? [];

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };

    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  useEffect(() => {
    if (!editDialog) return;
    setInputValue(editDialog.initialValue);
    setDialogError(null);
    setIsSubmittingDialog(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [editDialog]);

  const closeMenus = () => {
    setContextMenu(null);
  };

  const handleOpen = async () => {
    if (!contextMenu?.node) return;
    try {
      await openFile(contextMenu.node.path);
    } finally {
      closeMenus();
    }
  };

  const handleReveal = async () => {
    if (!contextMenu?.node) return;
    try {
      await invoke("reveal_in_explorer", { path: contextMenu.node.path });
      onStatus?.("已在资源管理器中定位。");
    } finally {
      closeMenus();
    }
  };

  const handleCopyRelativePath = async () => {
    if (!contextMenu?.node) return;
    try {
      const relativePath = await invoke<string>("get_workspace_relative_path", {
        path: contextMenu.node.path,
      });
      await navigator.clipboard.writeText(relativePath);
      onStatus?.(`已复制路径：${relativePath}`);
    } catch (error) {
      onStatus?.(`复制路径失败：${String(error)}`, "error", true);
    } finally {
      closeMenus();
    }
  };

  const openCreateDialog = () => {
    if (!contextMenu) return;
    closeMenus();
    setEditDialog({
      mode: "create",
      title: "新建文件夹",
      targetPath: contextMenu.targetDirPath,
      initialValue: "",
      submitLabel: "创建",
    });
  };

  const openRenameDialog = () => {
    if (!contextMenu?.node) return;
    closeMenus();
    setEditDialog({
      mode: "rename",
      title: "重命名",
      targetPath: contextMenu.node.path,
      initialValue: contextMenu.node.name,
      submitLabel: "保存",
    });
  };

  const handleCopy = (kind: WorkspaceClipboardState["kind"]) => {
    if (!contextMenu?.node) return;
    setClipboardState({
      kind,
      sourcePath: contextMenu.node.path,
      sourceType: contextMenu.node.type_name,
    });
    onStatus?.(
      kind === "cut" ? "已剪切到应用内剪贴板。" : "已复制到应用内剪贴板。",
    );
    closeMenus();
  };

  const handlePaste = async () => {
    if (!contextMenu || !clipboardState) return;
    const targetDirPath = contextMenu.targetDirPath;
    try {
      if (clipboardState.kind === "copy") {
        await invoke<FileNode>("copy_workspace_entry", {
          sourcePath: clipboardState.sourcePath,
          targetDirPath,
        });
        await onTreeChanged?.({ refreshPaths: [targetDirPath] });
        onStatus?.("已完成复制。");
      } else {
        const moved = await invoke<FileNode>("move_workspace_entry", {
          sourcePath: clipboardState.sourcePath,
          targetDirPath,
        });
        await onTreeChanged?.({
          refreshPaths:
            getParentPath(clipboardState.sourcePath) === targetDirPath
              ? [targetDirPath]
              : [targetDirPath, getParentPath(clipboardState.sourcePath)],
          removedPath: clipboardState.sourcePath,
          rebasedPath: {
            from: clipboardState.sourcePath,
            to: moved.path,
          },
        });
        setClipboardState(null);
        onStatus?.("已完成移动。");
      }
    } catch (error) {
      onStatus?.(`粘贴失败：${String(error)}`, "error", true);
    } finally {
      closeMenus();
    }
  };

  const openDeleteDialog = () => {
    if (!contextMenu?.node) return;
    setDeleteDialog({
      path: contextMenu.node.path,
      label: contextMenu.node.name,
    });
    closeMenus();
  };

  const submitEditDialog = async () => {
    if (!editDialog) return;
    const validationError = validateName(inputValue);
    if (validationError) {
      setDialogError(validationError);
      return;
    }

    setIsSubmittingDialog(true);
    setDialogError(null);
    try {
      if (editDialog.mode === "create") {
        await invoke<FileNode>("create_workspace_folder", {
          parentPath: editDialog.targetPath,
          name: inputValue.trim(),
        });
        await onTreeChanged?.({ refreshPaths: [editDialog.targetPath] });
        onStatus?.("文件夹已创建。");
      } else {
        const renamed = await invoke<FileNode>("rename_workspace_entry", {
          path: editDialog.targetPath,
          newName: inputValue.trim(),
        });
        await onTreeChanged?.({
          refreshPaths: [getParentPath(editDialog.targetPath)],
          rebasedPath: {
            from: editDialog.targetPath,
            to: renamed.path,
          },
        });
        onStatus?.("已完成重命名。");
      }
      setEditDialog(null);
    } catch (error) {
      setDialogError(String(error));
    } finally {
      setIsSubmittingDialog(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteDialog) return;
    try {
      await invoke("trash_workspace_entry", { path: deleteDialog.path });
      await onTreeChanged?.({
        refreshPaths: [getParentPath(deleteDialog.path)],
        removedPath: deleteDialog.path,
      });
      setDeleteDialog(null);
      onStatus?.("已移到回收站。");
    } catch (error) {
      setDialogError(String(error));
      onStatus?.(`删除失败：${String(error)}`, "error", true);
    }
  };

  const menuActions = useMemo(() => {
    if (!contextMenu || !workspacePath) return [];
    const targetNode = contextMenu.node;
    const isRootNode = targetNode?.path === workspacePath;
    const canPaste = Boolean(clipboardState);
    const targetIsFolder = !targetNode || targetNode.type_name === "folder";

    const actions: Array<{
      key: string;
      label: string;
      disabled?: boolean;
      onClick: () => void | Promise<void>;
    }> = [];

    if (targetNode) {
      actions.push({ key: "open", label: "打开", onClick: handleOpen });
      actions.push({
        key: "reveal",
        label: "在资源管理器中显示",
        onClick: handleReveal,
      });
      actions.push({
        key: "copy-relative",
        label: "复制工作空间路径",
        onClick: handleCopyRelativePath,
      });
    }

    if (targetIsFolder) {
      actions.push({
        key: "create-folder",
        label: "新建文件夹",
        onClick: openCreateDialog,
      });
    }

    if (targetNode && !isRootNode) {
      actions.push({
        key: "copy",
        label: "复制",
        onClick: () => handleCopy("copy"),
      });
      actions.push({
        key: "cut",
        label: "剪切",
        onClick: () => handleCopy("cut"),
      });
      actions.push({
        key: "rename",
        label: "重命名",
        onClick: openRenameDialog,
      });
      actions.push({
        key: "delete",
        label: "删除到回收站",
        onClick: openDeleteDialog,
      });
    }

    if (targetIsFolder) {
      actions.push({
        key: "paste",
        label: clipboardState
          ? clipboardState.kind === "cut"
            ? "粘贴已剪切项"
            : "粘贴已复制项"
          : "粘贴",
        disabled: !canPaste,
        onClick: () => void handlePaste(),
      });
    }

    return actions;
  }, [clipboardState, contextMenu, workspacePath]);

  return (
    <div
      className="file-tree"
      onContextMenu={(event) => {
        if (!workspacePath || event.target !== event.currentTarget) return;
        event.preventDefault();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          node: null,
          targetDirPath: workspacePath,
        });
      }}
    >
      {nodes.length === 0 && (
        <div
          className="empty-placeholder"
          onContextMenu={(event) => {
            if (!workspacePath) return;
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              node: null,
              targetDirPath: workspacePath,
            });
          }}
        >
          工作空间为空，请先导入文件或文件夹。
        </div>
      )}

      {nodes.map((node) => (
        <TreeNode
          key={node.id}
          node={node}
          level={0}
          activePath={activePath}
          onSelect={onSelect}
          onLoadChildren={onLoadChildren}
          onContextMenu={(event, target) =>
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              node: target,
              targetDirPath:
                target.type_name === "folder"
                  ? target.path
                  : getParentPath(target.path),
            })
          }
        />
      ))}

      {contextMenu && menuActions.length > 0 && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {menuActions.map((action) => (
            <button
              key={action.key}
              className="context-menu-item"
              disabled={action.disabled}
              onClick={() => void action.onClick()}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {editDialog && (
        <div
          className="file-tree-dialog-backdrop"
          onClick={() => setEditDialog(null)}
        >
          <div
            className="file-tree-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="file-tree-dialog-title">{editDialog.title}</div>
            <input
              ref={inputRef}
              className="file-tree-dialog-input"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submitEditDialog();
                }
                if (event.key === "Escape") {
                  setEditDialog(null);
                }
              }}
              placeholder="请输入名称"
            />
            {dialogError && (
              <div className="file-tree-dialog-error">{dialogError}</div>
            )}
            <div className="file-tree-dialog-actions">
              <button
                className="ghost-button"
                onClick={() => setEditDialog(null)}
              >
                取消
              </button>
              <button
                className="action-button"
                onClick={() => void submitEditDialog()}
                disabled={isSubmittingDialog}
              >
                {isSubmittingDialog ? "处理中..." : editDialog.submitLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteDialog && (
        <div
          className="file-tree-dialog-backdrop"
          onClick={() => {
            setDeleteDialog(null);
            setDialogError(null);
          }}
        >
          <div
            className="file-tree-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="file-tree-dialog-title">删除到回收站</div>
            <div className="file-tree-dialog-copy">
              确认将 “{deleteDialog.label}” 移到回收站？
            </div>
            {dialogError && (
              <div className="file-tree-dialog-error">{dialogError}</div>
            )}
            <div className="file-tree-dialog-actions">
              <button
                className="ghost-button"
                onClick={() => {
                  setDeleteDialog(null);
                  setDialogError(null);
                }}
              >
                取消
              </button>
              <button
                className="action-button danger"
                onClick={() => void confirmDelete()}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
