# 版本变更记录

## 1.1.12

### 移动端与桌面端

- 增加移动 PDF AI 阅读、划词翻译、整页翻译、结构化术语解释和离线回退。
- 增加 A+B 组合创新分析、双路本地论文证据、创新点卡片和 Idea Map 支持边。
- 增加移动聊天 `/` 指令、`@` 论文范围、创新页，以及知识卡片和论文笔记的创建、编辑与删除。
- 精简移动底部导航，将采集并入聊天，将卡片、笔记与复习整合到知识页。
- 修复 PDF 多栏选区漂移、乱码 Context、ToUnicode CMap 导致划词翻译失败，以及动作型快捷命令无法直接发送的问题。
- 让术语模型解释与限时百科查询并行执行，并在移动端明确区分模型总结、外部资料和页面原文。

### CI/CD

- 将常规 CI 拆成 Repository/Web、Mobile、Rust 三路并行快速门禁。
- 增加统一版本校验、移动聊天纯函数测试、Rust 格式与库测试。
- 固定第三方 GitHub Action 到不可变提交 SHA，并为任务增加最小权限、缓存和超时。
- 修复手动 Android 重发未检出目标 tag 的问题。
- 让 Windows 与 Android 在 draft release 建立后并行构建，并随产物上传 SHA-256。
- 明确 Android 产物为比赛展示用 `-demo.apk`，不包含应用商店上架准备。
- 修复 Windows runner 因 CRLF/LF 差异触发的 Prettier 全仓误报。
- 移除比赛发布任务的 90 分钟限制，并支持指定已有 tag 手动重跑桌面与 Android 构建。
- 用 GitHub CLI 的可重入退避重试替代 Tauri/softprops 的 Release 创建与上传路径，降低 GitHub API 5xx 对长构建的影响。
