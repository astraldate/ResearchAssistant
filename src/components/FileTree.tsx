import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

const openFile = async (path: string) => {
  await invoke("open_file", { path });
};

export interface FileNode {
  id: string;
  name: string;
  path: string;
  type_name: "file" | "folder";
  children?: FileNode[];
}

interface FileTreeProps {
  data?: FileNode[];
  onSelect?: (file: FileNode) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
}

const FileTreeNode: React.FC<{
  node: FileNode;
  level: number;
  onSelect?: (file: FileNode) => void;
  onContextMenu: (event: React.MouseEvent, node: FileNode) => void;
}> = ({ node, level, onSelect, onContextMenu }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isActive, setIsActive] = useState(false);

  const handleToggle = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (node.type_name === "folder") {
      setIsOpen(!isOpen);
      return;
    }
    setIsActive(true);
    onSelect?.(node);
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(event, node);
  };

  return (
    <div>
      <div
        className={`tree-item ${isActive ? "active" : ""}`}
        style={{ paddingLeft: `${level * 12 + 12}px` }}
        onClick={handleToggle}
        onContextMenu={handleContextMenu}
      >
        <span style={{ display: "flex", alignItems: "center", width: "16px", marginRight: "4px" }}>
          {node.type_name === "folder" && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        </span>

        {node.type_name === "folder" ? (
          <Folder size={14} className="icon" color="#6c757d" fill="#6c757d" fillOpacity={0.2} />
        ) : (
          <File size={14} className="icon" color="#6c757d" />
        )}

        <span style={{ marginLeft: "6px" }}>{node.name}</span>
      </div>

      {node.type_name === "folder" && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.id}
              node={child}
              level={level + 1}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({ data, onSelect }) => {
  const displayData = data ?? [];
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const handleContextMenu = (event: React.MouseEvent, node: FileNode) => {
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  };

  const handleOpen = async () => {
    if (!contextMenu) return;
    try {
      await openFile(contextMenu.node.path);
    } catch (error) {
      console.error("打开文件失败:", error);
    } finally {
      setContextMenu(null);
    }
  };

  const handleReveal = async () => {
    if (!contextMenu) return;
    try {
      await invoke("reveal_in_explorer", { path: contextMenu.node.path });
    } catch (error) {
      console.error("在资源管理器中定位失败:", error);
    } finally {
      setContextMenu(null);
    }
  };

  return (
    <div className="file-tree" style={{ position: "relative" }}>
      {displayData.length === 0 && (
        <div style={{ padding: "12px 14px", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
          尚未选择文件夹。
        </div>
      )}

      {displayData.map((node) => (
        <FileTreeNode key={node.id} node={node} level={0} onSelect={onSelect} onContextMenu={handleContextMenu} />
      ))}

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
            boxShadow: "0 2px 5px rgba(0,0,0,0.2)",
            borderRadius: "4px",
            padding: "4px 0",
            zIndex: 1000,
            minWidth: "150px",
          }}
        >
          <div
            className="menu-item"
            onClick={handleOpen}
            style={{ padding: "8px 12px", cursor: "pointer", fontSize: "0.9rem", color: "var(--text-primary)" }}
            onMouseEnter={(event) => (event.currentTarget.style.backgroundColor = "var(--bg-tertiary)")}
            onMouseLeave={(event) => (event.currentTarget.style.backgroundColor = "transparent")}
          >
            打开
          </div>
          <div
            className="menu-item"
            onClick={handleReveal}
            style={{ padding: "8px 12px", cursor: "pointer", fontSize: "0.9rem", color: "var(--text-primary)" }}
            onMouseEnter={(event) => (event.currentTarget.style.backgroundColor = "var(--bg-tertiary)")}
            onMouseLeave={(event) => (event.currentTarget.style.backgroundColor = "transparent")}
          >
            在文件夹中显示
          </div>
        </div>
      )}
    </div>
  );
};
