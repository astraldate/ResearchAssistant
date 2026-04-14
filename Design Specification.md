# Design Specification

更新日期：2026-04-14

## 1. 目标

ResearchAssistant 当前的产品目标是把桌面端资料处理能力和移动端随手采集能力连接成一条闭环：

- 桌面端负责知识库、PDF 阅读、知识卡片、待处理收件箱和复习状态的主存储。
- 移动端负责局域网配对、随手采集、离线复习和轻量卡片浏览。
- 桌面端与移动端共享协议类型，保持版本联动和接口收敛。

## 2. 系统组成

### 2.1 桌面端

- 前端：`src`
- 后端：`src-tauri`
- 关键能力：
  - 资料导入与知识库检索
  - Research Memory：论文索引、审核流、图谱与 Idea 推荐
  - Graph Canvas：Method DAG / Problem DAG / Idea Map 的 Cytoscape + overlay 可视化
  - PDF 阅读、术语解释、知识卡片保存
  - 移动端配对面板
  - 左侧 rail `Inbox` 待处理收件箱视图
  - 复习状态持久化

### 2.2 移动端

- 工程目录：`mobile-app`
- 技术栈：Expo Router + React Native
- 核心页面：
  - 配对
  - 复习
  - 卡片库
  - 采集
  - 设置

### 2.3 共享协议

- 目录：`packages/contracts`
- 用途：
  - 配对请求/响应
  - 卡片摘要与复习事件
  - 移动端收件箱投递格式
  - 设备会话与同步相关数据结构

## 3. 桌面 companion service

### 3.1 运行模型

- 桌面端在本机局域网地址上启动 companion service。
- 手机端通过 6 位配对码换取 token。
- 后续请求统一基于 token 访问，不再重复输入配对码。

### 3.2 桌面端职责

- 作为配对和同步的权威节点
- 持久化移动端会话、收件箱和复习状态
- 为移动端下发卡片摘要和复习数据
- 接收移动端离线补发的复习事件

### 3.3 数据落盘

- `mobile_inbox`：移动端采集内容
- `review_state`：复习事件和聚合状态
- 桌面端 UI 允许查看、标记已处理、恢复待处理和打开附件
- 桌面端 Inbox 入口位于左侧 rail，接收手机端 `Capture` 页提交的图片、链接和文字笔记。

## 4. 移动端本地模型

### 4.1 会话与缓存

- 配对会话：`expo-secure-store`
- 本地数据：`expo-sqlite`
- 离线队列：
  - 复习事件先写本地 SQLite
  - 联网后再补发给桌面端

### 4.2 使用路径

- “配对桌面端”：输入桌面端显示的地址和配对码
- “采集”：发送笔记、链接、图片到桌面端待处理收件箱
- “复习”：本地做题并向桌面端回传结果
- “卡片库”：展示已同步的卡片摘要

## 5. Android 构建设计

### 5.1 基本约束

Windows + monorepo + Expo / React Native 原生构建链，主要风险来自：

- `node_modules` 深路径导致的 CMake / Ninja 路径长度膨胀
- Expo / React Native 在 Windows 下的 Hermes 命令行兼容问题
- 自动链接过程产生的绝对路径和本机差异

### 5.2 当前稳定方案

- 根 `.npmrc` 使用 `node-linker=hoisted`
- 根 `package.json` 通过 `pnpm.patchedDependencies` 固化补丁
- `mobile-app/android/settings.gradle` 对几个高频 Android 子项目使用更短的 `mobile-app/node_modules/...` 路径
- Windows 下优先读取本地 `autolink-node-modules.json` 快照，避免自动链接命令在深路径环境里反复展开

### 5.3 原生补丁

#### `expo-modules-core`

- 给 CMake 增加 `CMAKE_OBJECT_PATH_MAX`
- 把 Expo Modules Core 的 CMake 中间目录固定到更短的 `.cxx-expo-modules-core`

#### `@react-native/gradle-plugin`

- 在 Windows 下对 Hermes 字节码输出和输入路径使用绝对路径
- 避免 `windowsAwareCommandLine` 在当前 React Native 版本组合下生成不可执行的 Hermes 命令

### 5.4 构建产物与图标

- 原始路径：`mobile-app/android/app/build/outputs/apk/release/app-release.apk`
- 未配置私有 `keystore.properties` 时，release APK 会回退使用 debug keystore，只适合本地安装测试。
- 移动端图标以 `dist/icon.svg` 为源，派生到：
  - `mobile-app/assets/icon.png`
  - `mobile-app/assets/adaptive-icon.png`
  - `mobile-app/assets/splash-icon.png`
  - `mobile-app/android/app/src/main/res/mipmap-*`
- 桌面端图标同样以 `dist/icon.svg` 为源，派生到 `src-tauri/icons/*` 中 Tauri 实际引用的 PNG / ICO / ICNS。

## 6. Research Memory 设计

### 6.1 存储分层

- `SQLite` 是唯一事实来源，保存：
  - `papers / pages / sections / chunks / extraction_candidates / review_queue`
  - `graph_nodes / graph_edges / evidence_refs`
  - `node_stats / orphan_nodes / method_paths / problem_paths / challenge_method_links / idea_candidates`
- `LanceDB` 只保存派生向量索引：
  - `chunk_vectors`
  - `page_vectors`
  - `concept_vectors`

### 6.2 抽取模型职责

- 默认隐私路径仍使用本地 Ollama。
- 聊天默认模型：`qwen3.5:9b`
- 候选节点抽取：`qwen3:8b`
- Pipeline Summary / Pipeline 命名：`qwen3.5:9b`
- Edge 抽取 / Edge 校验：`qwen3.5:9b`
- embedding 与聊天、抽取模型分离管理。
- Research Memory 抽取链支持测试期 `OpenAI-compatible` provider，例如 DeepSeek。该 provider 只影响 `candidate_extract / pipeline_summarize / pipeline_name_extract / edge_extract / edge_validate / canonicalize_candidates_small` 等抽取与评测链，不影响普通聊天、翻译和 `/brief`。
- DeepSeek 兼容分支不强制使用 OpenAI `json_schema` response format，而是使用 prompt-only JSON + 本地 JSON 解析与 normalize，避免接口兼容差异被误判为“无候选”。

### 6.3 抽取流水线

当前论文索引固定为：

```text
prepare_ingest
-> prepare_models
-> scan
-> detect_sections
-> parse_pages
-> build_map_units
-> candidate_extract
-> pipeline_summarize
-> pipeline_name_extract
-> edge_extract
-> edge_validate
-> rust_reduce
-> llm_canonicalize_small
-> review_queue
-> persist_graph
-> materialize_stats
-> index_vectors
```

设计约束：

- 不允许整篇论文单次大 JSON 抽取
- `candidate_extract` 只抽 `Task / Module / Challenge / Insight`
- `candidate_extract` 会注入排他性定义、负面示例和 `kindRationale`
- `Pipeline` 必须先做 `pipeline_summarize`，再做 `pipeline_name_extract`
- `edge_extract` 只在稳定节点与已抽出的 `Pipeline` 之间连边
- `edge_validate` 只负责删除、保留与重排，不得创建新边
- `Perspective / Review / Survey` 类论文不强制抽 Pipeline 主干；Pipeline 为空时仍允许继续抽 `challenge -> insight`、`task -> module` 等更宽松关系，避免关系层整体归零。
- 低信息片段直接过滤，减少无效模型调用
- `map unit` 优先按章节切分，没有可靠章节时退化为页窗口
- `Introduction / Method / Approach / Framework / Overview` 章节会使用更大的 relation map unit 和 overlap
- 当前实现优先稳定吞吐、证据可审计和进度可见性，不追求整篇一次性全量结构化

### 6.4 图谱约束与可视化

主干图谱固定为两棵 DAG：

```text
Task -> Pipeline -> Module
Challenge -> Insight
```

不会创建：

- `sub-module`
- 无限嵌套子树
- 跨层主干边

图谱 UI 分三种视图：

- `Method DAG`：展示 `Task / Pipeline / Module`
- `Problem DAG`：展示 `Challenge / Insight`
- `Idea Map`：展示系统或用户产生的二阶想法，不混入论文客观证据图

Graph Canvas 采用 Cytoscape + SVG/React overlay：

- Cytoscape 负责布局、hitbox、拖动、选中和邻域关系。
- React overlay 负责星体节点、Idea 脉冲星、标签和动画。
- SVG overlay 负责低亮度航线、流动光点和透明 hit path。
- Idea 节点使用暖金/洋红视觉，边使用 `inspired_by` / `resolves` 的金色虚线语义。

### 6.5 UI 入口

- 工作区文件树支持右键：
  - `建立索引`
  - `解除索引`
- `Knowledge` 面板包含：
  - `Search`
  - `Graph`
  - `Review`
  - `Ideas`
- 左侧 rail 包含：
  - `Workspace`
  - `Notes`
  - `Inbox`
  - `Knowledge Search`
  - `Knowledge Cards`
- 面板顶部会显示：
  - 当前聊天模型
  - 当前候选抽取模型
  - 当前候选回退模型
  - 当前 Pipeline Summary / Pipeline 命名模型
  - 当前 Edge 抽取 / Edge 校验模型
  - 当前索引阶段
- `Paper Status` 会显示每篇论文的最小抽取诊断：
  - relation units
  - candidate 冲突
  - pipeline 空 summary / 空命名
  - edge 候选 / 保留
  - edge 校验回退
- Chat 输入框当前支持：
  - `@paper` 指定论文 scope
  - `/brief` 生成单论文核心 Markdown 简报
  - `/ask`、`/method`、`/exp`、`/claim` 单论文只读命令
  - `/note`、`/review` 生成草稿并在聊天流中回显可点击状态卡片

### 6.6 Review、Graph 与 Ideas

- 导入后的候选默认不会直接进入正式图谱，必须先在 `Review` 页审核。
- 候选分为：
  - `node`
  - `edge`
- 审核通过后会触发：
  - 图谱重建
  - 统计物化
  - 向量索引重建
  - Idea 候选刷新
- `Graph` 页当前提供：
  - `Method DAG`
  - `Problem DAG`
  - `Idea Map`
- `Idea Map` 支持编辑 Idea 的 `title` 和 `summary`；`ruleType / confidence / evidence / linked node ids` 保持只读。
- `Ideas` 当前已有 3 类规则：
  - 热点 `Challenge` 缺少成熟 `Insight`
  - 某个 `Task` 下已有多条 `Pipeline`，但模块覆盖仍不完整
  - 基于 `Challenge` 与 `Module` 的跨文献语义近邻缺口推荐

### 6.7 检索与证据使用

- `Search` 页当前使用混合召回：
  - `SQLite FTS5`
  - `LanceDB`
  - 分数合并后去重
- 问答、论文比较和 `/brief` 都应优先消费证据块，而不是整篇论文正文。
- 关键结果尽量能追溯到 `evidence_refs`，包括：
  - 图节点
  - 图边
  - Search 结果
  - Idea candidates
  - 论文比较结果
  - `/brief` 简报引用的 scoped 检索证据

### 6.8 运维与故障处理

- 如果 `LanceDB` 与 `SQLite` 漂移，当前策略仍以 `SQLite` 为准重建派生索引。
- 如果索引时缺少候选、Pipeline 或 Edge 相关模型，前端会在 `prepare_models` 阶段尝试自动拉取并收敛到当前实际配置。
- 抽取进度 UI 采用全流程累计进度，并显示各子阶段状态；被跳过的阶段会给出原因，避免把未运行阶段误显示为失败。
- 索引支持断点续建图。开发阶段需要从零验证时，应使用重建/覆盖入口；恢复入口只应消费已有进度，不应伪造空完成。
- 仓库内提供小样本回归工具：
  - `pnpm research-eval:scaffold`：从当前 `research_memory.sqlite3` 生成 `research_memory_eval_samples.json`
  - `pnpm research-eval:run`：读取 gold 样本并生成 `research_memory_eval_report.json`
- scaffold 优先绑定 `approved` 候选作为 gold；如果当前只有 paper 记录或只有 pending 候选，会在样本里明确标记需要重新 ingest 或人工修订。
- 如果 `Review` 批准后图谱没有刷新，优先检查：
  - 审核动作是否成功返回
  - embedding 模型是否可用
  - 批准后是否触发向量重建
- 当前仓库约定：
  - `PROTOC` 指向 `src-tauri/tools/protoc.exe`
  - `PROTOC_INCLUDE` 指向 `src-tauri/tools/include`

## 7. 验收基线

- `pnpm install --force`
- `pnpm exec tsc --noEmit`
- `pnpm --dir mobile-app exec tsc --noEmit`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `pnpm build`
- `cd mobile-app/android && .\gradlew.bat assembleRelease --console=plain --no-daemon`
- `pnpm tauri build --bundles nsis --ci`
- 真机或模拟器可完成配对、采集、收件箱显示和复习状态同步
- 桌面端可完成论文导入、候选抽取、审核入图与向量检索

## 8. 已知限制

- 若系统级 Windows 长路径策略未开启，构建日志仍可能出现 CMake 路径 warning，但当前已不阻断 release 构建。
- `mobile-app/android/autolink-*.json` 含有本机绝对路径，因此只作为本地缓存，不入库。
- 没有 `keystore.properties` 时，release 仍使用 debug keystore，本质上是“可安装 release 包”，不是可对外分发的正式签名包。
- Expo / React Native 升级后，需要同步更新 `patches/` 与 Android 构建脚本。
- Graph Canvas 已是 Cytoscape + React/SVG overlay 交互图，但节点拖动、边命中区、星图入场动画和大图性能仍需继续打磨。
- `analyze_pdf_page_visual` 当前仍是页文本回退，不是真正的视觉模型解析。
- `compare_papers` 已有后端实现，但前端完整工作流仍待补齐。
- 第一批 slash command 当前仍聚焦单论文阅读，不支持多文献比较，也没有独立字段后处理层。
- `Research Memory` 说明已经并入本文件，不再维护单独的 `RESEARCH_MEMORY_MANUAL.md`。
