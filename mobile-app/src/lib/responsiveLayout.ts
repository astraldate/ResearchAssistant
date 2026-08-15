import { useWindowDimensions } from "react-native";
import {
  resolveResponsiveLayout,
  type ResponsiveLayout,
} from "./responsiveLayoutCore";

export * from "./responsiveLayoutCore";

export function useResponsiveLayout(): ResponsiveLayout {
  const { width, height } = useWindowDimensions();
  return resolveResponsiveLayout(width, height);
}
