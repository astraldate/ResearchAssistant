import assert from "node:assert/strict";
import test from "node:test";
import type { MobileChatPaperContext } from "../contracts";
import { resolveEmptyComposerRequest } from "./chatComposer.ts";

const paper: MobileChatPaperContext = {
  sourceType: "paper",
  sourceId: "paper-1",
  title: "示例论文",
};

test("动作型命令选择论文后可以直接生成默认问题", () => {
  assert.equal(
    resolveEmptyComposerRequest("brief", paper).content,
    "请为所选论文生成一份紧凑论文简报。",
  );
  assert.match(
    resolveEmptyComposerRequest("method", paper).content ?? "",
    /方法设计/,
  );
});

test("需要参数的命令不会静默生成问题", () => {
  assert.match(resolveEmptyComposerRequest("ask", paper).error ?? "", /提问/);
  assert.match(
    resolveEmptyComposerRequest("innovation", paper).error ?? "",
    /两个概念/,
  );
  assert.match(
    resolveEmptyComposerRequest("brief", undefined).error ?? "",
    /@/,
  );
});
