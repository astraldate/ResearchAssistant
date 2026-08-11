import { Pressable, StyleSheet, Text, View } from "react-native";
import { palette, spacing } from "../theme";

export interface HubSwitchOption<T extends string> {
  value: T;
  label: string;
  badge?: number;
}

interface HubSwitchProps<T extends string> {
  value: T;
  options: HubSwitchOption<T>[];
  onChange: (value: T) => void;
}

export function HubSwitch<T extends string>({
  value,
  options,
  onChange,
}: HubSwitchProps<T>) {
  return (
    <View style={styles.container} accessibilityRole="tablist">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={[styles.item, active && styles.itemActive]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>
              {option.label}
            </Text>
            {typeof option.badge === "number" ? (
              <View style={[styles.badge, active && styles.badgeActive]}>
                <Text
                  style={[styles.badgeText, active && styles.badgeTextActive]}
                >
                  {option.badge > 99 ? "99+" : option.badge}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    flexShrink: 0,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.panel,
    padding: 4,
    gap: 4,
  },
  item: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  itemActive: {
    backgroundColor: palette.primary,
  },
  label: {
    color: palette.slate,
    fontWeight: "800",
  },
  labelActive: {
    color: "#fff",
  },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: palette.secondarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeActive: {
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  badgeText: {
    color: palette.secondary,
    fontSize: 11,
    fontWeight: "900",
  },
  badgeTextActive: {
    color: "#fff",
  },
});
