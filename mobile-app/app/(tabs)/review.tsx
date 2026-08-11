import { Redirect, type Href } from "expo-router";

export default function ReviewScreen() {
  return <Redirect href={"/(tabs)/library?view=review" as Href} />;
}
