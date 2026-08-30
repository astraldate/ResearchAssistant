import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_PDF_VIEWER_REVISION,
  addMobilePdfViewerRevision,
  buildPageFallbackOutline,
  buildSelectionCacheKey,
  normalizeNativeOutline,
  parsePdfViewerMessage,
  serializePdfViewerCommand,
  shouldUseControlledPdfSelection,
} from "./pdfReaderCore.ts";

test("Viewer v2 消息保留目录、能力和兼容页码", () => {
  const message = parsePdfViewerMessage(
    JSON.stringify({
      type: "ready",
      protocolVersion: 2,
      pageCount: 12,
      capabilities: ["continuous-scroll", "outline"],
      outline: [{ title: "方法", page: 4, depth: 1 }],
    }),
  );
  assert.deepEqual(message, {
    type: "ready",
    protocolVersion: 2,
    pageCount: 12,
    capabilities: ["continuous-scroll", "outline"],
    outline: [{ title: "方法", page: 4, depth: 1 }],
  });
  assert.deepEqual(
    parsePdfViewerMessage(
      JSON.stringify({ type: "page-change", page: 3, pageCount: 12 }),
    ),
    { type: "page", page: 3, pageCount: 12 },
  );
});

test("空选区消息会保留页码并让宿主清除当前选中文字", () => {
  assert.deepEqual(
    parsePdfViewerMessage(
      JSON.stringify({ type: "selection", text: "", page: 6, context: "" }),
    ),
    { type: "selection", text: "", page: 6, context: "" },
  );
});

test("离线目录按层级展开并把原生零基页码转换为一基页码", () => {
  assert.deepEqual(
    normalizeNativeOutline([
      {
        title: "第一章",
        pageIdx: 0,
        children: [{ title: "实验", pageIdx: 6, children: [] }],
      },
    ]),
    [
      { title: "第一章", page: 1, depth: 0 },
      { title: "实验", page: 7, depth: 1 },
    ],
  );
  assert.deepEqual(buildPageFallbackOutline(3), [
    { title: "第 1 页", page: 1, depth: 0 },
    { title: "第 2 页", page: 2, depth: 0 },
    { title: "第 3 页", page: 3, depth: 0 },
  ]);
});

test("选区缓存键会忽略首尾空白并区分页码", () => {
  assert.equal(buildSelectionCacheKey(2, "  term  "), "2:term");
  assert.notEqual(
    buildSelectionCacheKey(2, "term"),
    buildSelectionCacheKey(3, "term"),
  );
});

test("宿主命令序列化保持受控联合类型", () => {
  assert.equal(
    serializePdfViewerCommand({ type: "setViewMode", mode: "continuous" }),
    '{"type":"setViewMode","mode":"continuous"}',
  );
});

test("只有声明严格字形能力的 v3 阅读器才启用受控选区", () => {
  assert.equal(shouldUseControlledPdfSelection(1), false);
  assert.equal(
    shouldUseControlledPdfSelection(2, ["strict-glyph-selection"]),
    false,
  );
  assert.equal(shouldUseControlledPdfSelection(3), false);
  assert.equal(
    shouldUseControlledPdfSelection(3, ["strict-glyph-selection"]),
    true,
  );
});

test("Viewer 修订号会替换旧参数并强制新会话地址", () => {
  assert.equal(MOBILE_PDF_VIEWER_REVISION, "strict-glyph-selection-v5");
  assert.equal(
    addMobilePdfViewerRevision(
      "http://192.168.1.8/api/mobile/v1/pdf-viewer?page=2&viewerRevision=old",
      "strict-v2",
    ),
    "http://192.168.1.8/api/mobile/v1/pdf-viewer?page=2&viewerRevision=strict-v2",
  );
});
