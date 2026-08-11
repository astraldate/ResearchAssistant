import { Redirect, type Href } from "expo-router";

export default function CaptureScreen() {
  return <Redirect href={"/(tabs)/chat?view=capture" as Href} />;
}
