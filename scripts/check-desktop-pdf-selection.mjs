import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourcePath = resolve("src/components/PdfReader.tsx");
const source = await readFile(sourcePath, "utf8");

const requiredFragments = [
  "const getSelectionClientRects = (range: Range)",
  "const characterRange = document.createRange()",
  "characterRange.setStart(textNode, offset)",
  "characterRange.setEnd(textNode, offset + 1)",
];

const missingFragments = requiredFragments.filter(
  (fragment) => !source.includes(fragment),
);
if (missingFragments.length > 0) {
  throw new Error(
    `桌面 PDF 选区字符边界实现缺少：${missingFragments.join("、")}`,
  );
}

if (/previewScale|previousViewportMetricsRef/.test(source)) {
  throw new Error("桌面 PDF 选区仍存在临时 previewScale 坐标系。");
}

console.log("桌面 PDF 选区字符边界静态检查通过。");
