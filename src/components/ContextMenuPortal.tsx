import {
  type CSSProperties,
  type MouseEventHandler,
  type PropsWithChildren,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface ContextMenuPortalProps extends PropsWithChildren {
  open: boolean;
  anchor: { x: number; y: number } | null;
  className?: string;
  style?: CSSProperties;
  onClose: () => void;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
}

const VIEWPORT_PADDING = 8;

export function ContextMenuPortal({
  open,
  anchor,
  className,
  style,
  onClose,
  onMouseDown,
  children,
}: ContextMenuPortalProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const hasAnchor = Boolean(anchor);
  const anchorX = anchor?.x ?? 0;
  const anchorY = anchor?.y ?? 0;

  useLayoutEffect(() => {
    if (!open || !hasAnchor) {
      setPosition((current) =>
        current.ready ? { left: 0, top: 0, ready: false } : current,
      );
      return;
    }

    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      window.innerWidth - rect.width - VIEWPORT_PADDING,
    );
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      window.innerHeight - rect.height - VIEWPORT_PADDING,
    );

    const nextPosition = {
      left: Math.min(Math.max(anchorX, VIEWPORT_PADDING), maxLeft),
      top: Math.min(Math.max(anchorY, VIEWPORT_PADDING), maxTop),
      ready: true,
    };

    setPosition((current) => {
      if (
        current.ready === nextPosition.ready &&
        current.left === nextPosition.left &&
        current.top === nextPosition.top
      ) {
        return current;
      }
      return nextPosition;
    });
  }, [anchorX, anchorY, hasAnchor, open]);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    const handleViewportChange = () => {
      onClose();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [onClose, open]);

  if (!open || !anchor || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      className={className}
      style={{
        left: position.left,
        top: position.top,
        maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        overflowY: "auto",
        overscrollBehavior: "contain",
        visibility: position.ready ? "visible" : "hidden",
        ...style,
      }}
      onMouseDown={onMouseDown}
    >
      {children}
    </div>,
    document.body,
  );
}
