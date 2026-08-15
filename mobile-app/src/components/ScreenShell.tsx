import type { PropsWithChildren, ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Edge } from "react-native-safe-area-context";
import { useResponsiveLayout } from "../lib/responsiveLayout";
import { palette, spacing } from "../theme";

interface ScreenShellProps extends PropsWithChildren {
  title: string;
  subtitle?: string;
  headerRight?: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  maxContentWidth?: number;
  safeAreaEdges?: Edge[];
}

export function ScreenShell({
  children,
  title,
  subtitle,
  headerRight,
  scroll = true,
  contentStyle,
  maxContentWidth = 1200,
  safeAreaEdges,
}: ScreenShellProps) {
  const layout = useResponsiveLayout();
  const resolvedSafeAreaEdges: Edge[] =
    safeAreaEdges ??
    (layout.isTabletLandscape
      ? ["top", "right", "bottom"]
      : ["top", "left", "right"]);
  const horizontalPadding = layout.isTablet ? 28 : spacing.lg;
  const compactHeader = layout.isLandscape && layout.height < 600;
  const responsiveContentStyle = {
    width: "100%" as const,
    maxWidth: maxContentWidth,
    alignSelf: "center" as const,
    paddingHorizontal: horizontalPadding,
  };
  const content = scroll ? (
    <ScrollView
      contentContainerStyle={[
        styles.scrollContent,
        responsiveContentStyle,
        contentStyle,
      ]}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.fill, responsiveContentStyle, contentStyle]}>
      {children}
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={resolvedSafeAreaEdges}>
      <View
        style={[
          styles.header,
          responsiveContentStyle,
          compactHeader && styles.headerCompact,
        ]}
      >
        <View style={styles.headerCopy}>
          <Text
            style={[styles.title, compactHeader && styles.titleCompact]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {subtitle && !compactHeader ? (
            <Text style={styles.subtitle} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {headerRight}
      </View>
      {content}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.cloud,
  },
  fill: {
    flex: 1,
    paddingBottom: spacing.xl,
  },
  scrollContent: {
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  header: {
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  headerCompact: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  headerCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: palette.ink,
  },
  titleCompact: {
    fontSize: 24,
  },
  subtitle: {
    color: palette.slate,
    fontSize: 14,
    lineHeight: 20,
  },
});
