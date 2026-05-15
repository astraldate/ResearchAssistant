# ResearchAssistant Coding Plan

更新日期：2026-05-14

## 当前路线

- 产品主线：桌面端作为知识库、模型和同步权威节点，移动端作为 companion app 补充采集、复习、卡片浏览和移动聊天。
- 协议主线：桌面端与移动端继续共用 `packages/contracts`，避免双仓库协议漂移。
- 构建主线：Android release 继续留在当前 monorepo 内解决，不另开仓库。
- Windows 主线：通过 `hoisted node linker + patchedDependencies + 短 Android 子项目路径` 控制构建复杂度。

## 本轮已完成

### P0 已完成

- 桌面端新增移动 companion service，支持局域网或 Tailscale 配对、token 会话、卡片下发、复习事件回传、移动收件箱落盘和移动聊天会话持久化。
- 桌面端新增“待处理收件箱”主视图，支持查看、标记已处理、恢复待处理和打开附件。
- 桌面端左侧 rail 已补 `Inbox` 入口，避免收件箱组件存在但 UI 不可达。
- 移动端 Expo Router 工程完成首版可用链路：配对、复习、卡片库、采集、聊天、设置。
- 移动端本地会话切到 `expo-secure-store`，本地缓存和离线队列切到 `expo-sqlite`。
- 修复移动端 React / Expo 原生模块版本错配导致的启动崩溃。
- 修复桌面 companion service 在 Tokio runtime 之外初始化导致的启动 panic。
- Android release 构建已经能在本仓库内稳定跑通，不再依赖临时短路径副本目录。
- GitHub tag release workflow 已扩展 Android APK job，`v*` tag 会生成 Windows 桌面 draft release 并附加 Android APK。
- 桌面端与移动端图标已统一使用 `dist/icon.svg` 作为源图，派生到 Tauri icons、Expo assets 和 Android 原生 launcher 资源。
- 根目录新增 `pnpm.patchedDependencies`，把 Windows Android 构建补丁持久化到仓库。
- `.gitignore` 已补齐 Expo、Android 构建产物、autolink 快照和本机日志忽略规则。
- README、技术设计文档和 master plan 已改成 UTF-8 中文，并同步当前移动端与 APK 流程。
- 桌面端移动设置页已支持检测并展示 Tailscale `100.x.y.z` 地址，并在移动服务启动后尝试自动配置 Tailscale TCP Serve。
- 移动聊天已支持桌面端模型流式输出、队列状态、知识库检索状态、思考开关、思考过程折叠展示、会话切换和删除会话。
- 移动聊天流断开时，桌面端不再把手机连接关闭当成模型失败，而是继续生成并保存最终结果。
- 移动端卡片库同步按钮已接入真实刷新链路。

### P1 已完成

- 根 `.npmrc` 改为 `node-linker=hoisted`，减轻 `.pnpm` 深路径对 Android CMake 的影响。
- `mobile-app/android/settings.gradle` 加入较短 Android 子项目目录映射。
- `expo-modules-core` 补丁增加 `CMAKE_OBJECT_PATH_MAX` 和固定中间目录。
- `@react-native/gradle-plugin` 补丁修正 Windows 下 Hermes 命令行路径。
- `mobile-app` 当前版本更新到 `1.1.2`，`versionCode = 13`。

### Research Memory 已完成

- 桌面端新增 `Research Memory` 面板，包含 `Search / Graph / Review / Ideas` 四个子页。
- 论文索引链路改为 `SQLite` 主库 + `LanceDB` 派生向量索引，不再依赖单文件知识库。
- 抽取链路改为 `Map-Reduce`，禁止整篇论文一次性结构化抽取。
- 抽取模型职责已拆分：
  - 聊天默认模型：`qwen3.5:9b`
  - 候选节点抽取：`qwen3:8b`
  - Pipeline Summary / Pipeline 命名：`qwen3.5:9b`
  - Edge 抽取 / Edge 校验：`qwen3.5:9b`
- 索引前会自动检查并拉取缺失的候选、Pipeline、Edge 和 embedding 模型。
- 抽取阶段已拆成：
  - `candidate_extract`
  - `pipeline_summarize`
  - `pipeline_name_extract`
  - `edge_extract`
  - `edge_validate`
  - `canonicalize`
  - `index_vectors`
- Candidate prompt 已加入排他性定义、负面示例和 `kindRationale`，减少节点级联失真。
- Relation 类抽取已对 `Introduction / Method / Approach / Framework / Overview` 使用更大窗口和重叠切片。
- `Pipeline` 已改成“先总结骨架，再提取标准名称”的两步式 CoT 降维。
- `Paper Status` 现在可直接查看每篇论文的抽取诊断：
  - relation units
  - candidate 冲突
  - pipeline 空 summary / 空命名
  - edge 候选 / 保留
  - edge 校验回退
- 当前图谱深度已锁死为：
  - `Task -> Pipeline -> Module`
  - `Challenge -> Insight`
- 已支持右键对工作区中的文件或文件夹执行：
  - `建立索引`
  - `解除索引`
- 进度面板与 `Knowledge` 面板顶部已能显示当前聊天模型、快速抽取模型、回退模型和实际索引阶段。
- 聊天输入框新增 `@paper` 论文 scope mention 与 `/brief` 核心 Markdown 简报指令。
- 聊天输入框新增第一批科研命令：`/ask`、`/method`、`/exp`、`/claim`、`/note`、`/review`；副作用命令会在聊天流里回显草稿卡片。
- Research Memory 抽取链新增实验 provider：默认本地 Ollama，测试期可切到 OpenAI-compatible / DeepSeek 做同链 A/B。
- Review / Perspective / Survey 论文不再强制抽 Pipeline 主干；Pipeline 为空时仍允许继续抽 `challenge -> insight`、`task -> module` 等关系，避免整层归零。
- Graph Canvas 已从轻量 lane 视图升级为 Cytoscape + React/SVG overlay 的星空图：支持 Method DAG、Problem DAG 和 Idea Map。
- Idea Map 已独立于论文客观证据图，Idea 节点使用暖色脉冲星视觉，并支持编辑 `title` / `summary`。

## 仍需继续推进

### P0

- 正式签名链路仍未完成，目前 release 在没有私有 keystore 时会回退到 debug keystore。
- 需要补一份桌面端与移动端联调验收清单，覆盖 Tailscale/LAN 配对、移动聊天、采集、卡片同步、复习同步和异常恢复。
- 待处理收件箱还缺少“批量处理 / 转卡片 / 关联资料”的后续操作面板。

### P1

- Android 构建日志里 `react-native-gesture-handler` 仍有对象路径 warning，虽然不再阻断 release，但还可以继续压缩。
- 需要增加 Android release 构建的 CI 校验，至少覆盖依赖安装、TypeScript 和 `assembleRelease`。
- `Research Memory` 抽取模型设置已扩到候选、Pipeline Summary、Pipeline 命名、Edge 抽取、Edge 校验和实验 provider，但还缺更系统的策略页和样本集管理。
- Graph Canvas 已可交互，但仍需继续打磨节点拖动流畅度、边选择命中区、星图入场动画和大图性能。
- `compare_papers` 后端已具备，但前端完整入口仍需补齐。
- `/brief` 与第一批单论文命令已能跑通，但还缺少更稳定的证据排序、字段后处理和多文献命令扩展。

### P2

- iOS 安装包和签名链路。
- 移动端推送提醒、后台同步、更完整的复习计划和断线后自动重连/续看体验。
- OCR 扫描版 PDF、卡片编辑、标签管理和双向同步。

## 当前实现状态总览

- 桌面端知识库 / PDF / 卡片链路：已完成并可继续演进
- 桌面端 Research Memory / 审核流 / Idea 引擎：已完成首版可用闭环
- 桌面端 Graph Canvas / Idea Map：已完成首版可用闭环
- 移动端 companion v1：已完成
- 移动端聊天：已完成首版可用闭环
- 桌面端待处理收件箱：已完成
- Android release APK（仓库内构建）：已完成
- 依赖补丁持久化：已完成
- release 正式签名：未完成

## 验收基线

- `pnpm install --force` 通过
- `pnpm exec tsc --noEmit` 通过
- `pnpm --dir mobile-app exec tsc --noEmit` 通过
- `cargo check --manifest-path src-tauri/Cargo.toml` 通过
- `pnpm build` 通过
- `pnpm --dir mobile-app android:apk:release` 或 `cd mobile-app/android && .\gradlew.bat assembleRelease --console=plain --no-daemon` 通过
- 手机端可完成局域网或 Tailscale 配对
- 手机端可新建、切换、删除移动聊天会话，并看到桌面模型流式回答和思考折叠块
- 手机端采集内容能进入桌面端“待处理收件箱”
- 手机端卡片库能手动刷新同步桌面端卡片摘要
- 手机端复习事件能回传并更新桌面端状态
- 桌面端可对选中文件 / 文件夹建立索引并进入 `Review`
- `Knowledge` 面板可查看 Method DAG、Problem DAG、Idea Map、Review 队列和 Rule 1/2/3 Idea 候选
- Chat 输入框可用 `/brief`、`/ask`、`/method`、`/exp`、`/claim`、`/note`、`/review`，并可配合 `@paper` 指定目标论文

## 风险与约束

- Expo / React Native 升级后，`patches/` 很可能需要重新生成，不能默认沿用。
- `mobile-app/android/autolink-*.json` 包含本机绝对路径，必须忽略，不适合作为仓库输入。
- 如果 Windows 未开启系统级长路径支持，构建 warning 会更多，但当前路径压缩方案已经能稳定出包。
- 目前的 release APK 更适合本地安装测试，不等于可直接分发的正式签名包。
- Tailscale 访问依赖本机 Tailscale 客户端和 tailnet 策略；自动 TCP Serve 失败时仍需回退局域网地址。
- 移动端聊天首段响应受本地 Ollama 队列影响；桌面端长生成任务会让手机端进入排队状态。
- Research Memory 说明已并入 `Design Specification.md`，后续不要再维护独立的 `RESEARCH_MEMORY_MANUAL.md`。

## 性能优化记录

- `ResearchMemoryPanel` 按需加载。
- `PdfDock` 按需加载。
- `PdfReader` 再延后一层，只在真正打开 PDF 时加载。
- `CardLibrary` 按需加载。
- Graph Canvas 内的详情查询改成点击后再取，不在打开时预热。
