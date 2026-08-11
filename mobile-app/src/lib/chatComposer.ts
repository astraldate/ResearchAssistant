import type { MobileChatCommand, MobileChatPaperContext } from "../contracts";

export const DEFAULT_PAPER_COMMAND_PROMPTS: Partial<
  Record<MobileChatCommand, string>
> = {
  brief: "请为所选论文生成一份紧凑论文简报。",
  method: "请分析所选论文的方法设计、技术路线和关键模块。",
  exp: "请分析所选论文的实验设置、消融、结果边界和局限。",
  claim: "请提取所选论文的核心论点，并评估证据强弱。",
};

export function resolveEmptyComposerRequest(
  command: MobileChatCommand | undefined,
  paper: MobileChatPaperContext | undefined,
) {
  if (command === "ask") {
    return { error: "请输入你想向这篇论文提问的问题。" };
  }
  if (command === "innovation") {
    return {
      error: "请输入两个概念，例如“AD + GNN”，或前往创新页填写。",
    };
  }
  if (command && !paper) {
    return { error: "请先用 @ 选择一篇论文，再直接执行该指令。" };
  }
  if (command && paper) {
    const prompt = DEFAULT_PAPER_COMMAND_PROMPTS[command];
    if (prompt) return { content: prompt };
  }
  if (paper) {
    return { error: "请输入问题，或选择 /brief、/method 等指令后直接发送。" };
  }
  return { error: "请输入问题。" };
}
