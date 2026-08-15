import assert from "node:assert/strict";
import test from "node:test";
import { resolveResponsiveLayout } from "./responsiveLayoutCore.ts";

test("横屏手机不会误判为平板双栏", () => {
  const layout = resolveResponsiveLayout(915, 412);
  assert.equal(layout.isLandscape, true);
  assert.equal(layout.isTabletLandscape, false);
  assert.equal(layout.size, "medium");
});

test("小平板与标准平板横屏会进入阅读双栏", () => {
  assert.equal(resolveResponsiveLayout(1024, 600).isTabletLandscape, true);
  assert.equal(resolveResponsiveLayout(1024, 600).size, "expanded");
  assert.equal(resolveResponsiveLayout(1280, 800).size, "large");
});

test("平板竖屏保留底部导航语义", () => {
  const layout = resolveResponsiveLayout(800, 1280);
  assert.equal(layout.isTablet, true);
  assert.equal(layout.isTabletLandscape, false);
  assert.equal(layout.size, "medium");
});
