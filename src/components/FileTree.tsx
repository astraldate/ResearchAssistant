import React, { useEffect, useRef, useState } from "react";
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

interface FileTreeProps {
  data?: FileNode[];
  activePath?: string | null;
  onSelect?: (file: FileNode) => void;
  onLoadChildren?: (path: string) => Promise<FileNode[]>;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
}

const openFile = async (path: string) => {
  await invoke("open_file", { path });
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
      console.info(
        "[tree] sync children from props",
        node.path,
        normalizedChildren.length,
        normalizedChildren.map((child) => child.name),
      );
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
  }, [hasLoadedChildren, normalizedChildren, node.path]);

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
    console.time(`[tree] load ${node.path}`);
    try {
      const nextChildren = await onLoadChildren(node.path);
      console.info(
        "[tree] loaded",
        node.path,
        nextChildren.length,
        nextChildren.map((child) => `${child.type_name}:${child.name}`),
      );
      setChildren(nextChildren);
      setHasLoadedChildren(true);
    } catch (error) {
      console.error("Failed to load tree children:", error, node.path);
      setChildren([]);
      setHasLoadedChildren(true);
      setLoadError(String(error));
    } finally {
      console.timeEnd(`[tree] load ${node.path}`);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (node.type_name === "folder" && isOpen && !hasLoadedChildren) {
      void loadChildrenIfNeeded();
    }
  }, [hasLoadedChildren, isOpen, node.type_name]);

  useEffect(() => {
    if (node.type_name === "folder") {
      console.info("[tree] render", {
        path: node.path,
        isOpen,
        hasLoadedChildren,
        childCount: children?.length ?? null,
        loadError,
      });
    }
  }, [
    children,
    hasLoadedChildren,
    isOpen,
    loadError,
    node.path,
    node.type_name,
  ]);

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
        <span className="tree-item-label" title={node.name}>{node.name}</span>
        {node.type_name === "folder" && !hasChildren && <span className="tree-item-empty">空</span>}
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
  onSelect,
  onLoadChildren,
}) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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

  const handleOpen = async () => {
    if (!contextMenu) return;
    try {
      await openFile(contextMenu.node.path);
    } finally {
      setContextMenu(null);
    }
  };

  const handleReveal = async () => {
    if (!contextMenu) return;
    try {
      await invoke("reveal_in_explorer", { path: contextMenu.node.path });
    } finally {
      setContextMenu(null);
    }
  };

  return (
    <div className="file-tree">
      {nodes.length === 0 && (
        <div className="empty-placeholder">
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
            setContextMenu({ x: event.clientX, y: event.clientY, node: target })
          }
        />
      ))}

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className="context-menu-item"
            onClick={() => void handleOpen()}
          >
            打开
          </button>
          <button
            className="context-menu-item"
            onClick={() => void handleReveal()}
          >
            在资源管理器中显示
          </button>
        </div>
      )}
    </div>
  );
};

