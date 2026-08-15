export type ResponsiveLayoutSize = "compact" | "medium" | "expanded" | "large";

export interface ResponsiveLayout {
  width: number;
  height: number;
  shortSide: number;
  isLandscape: boolean;
  isTablet: boolean;
  isTabletLandscape: boolean;
  size: ResponsiveLayoutSize;
}

export function resolveResponsiveLayout(
  width: number,
  height: number,
): ResponsiveLayout {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  const shortSide = Math.min(safeWidth, safeHeight);
  const isLandscape = safeWidth > safeHeight;
  const isTablet = shortSide >= 600;
  const isTabletLandscape = isTablet && isLandscape;
  const size: ResponsiveLayoutSize =
    isTablet && safeWidth >= 1200
      ? "large"
      : isTablet && safeWidth >= 900
        ? "expanded"
        : safeWidth >= 600
          ? "medium"
          : "compact";

  return {
    width: safeWidth,
    height: safeHeight,
    shortSide,
    isLandscape,
    isTablet,
    isTabletLandscape,
    size,
  };
}
