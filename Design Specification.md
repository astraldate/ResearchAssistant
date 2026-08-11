# ResearchAssistant 设计规范

更新日期：2026-08-11

## 1. 目标

ResearchAssistant 当前的产品目标是把桌面端资料处理能力和移动端随手采集能力连接成一条闭环：

- 桌面端负责知识库、PDF 阅读、知识卡片、待处理收件箱和复习状态的主存储。
- 移动端负责局域网或 Tailscale 配对、随手采集、离线复习、轻量卡片浏览、PDF AI 阅读和移动聊天。
- 桌面端与移动端共享协议类型，保持版本联动和接口收敛。
- 跨概念分析必须区分本地论文证据、模型通用知识和待验证假设，不能把生成结果包装成已经成立的创新结论。

## 2. 系统组成

### 2.1 桌面端

- 前端：`src`
- 后端：`src-tauri`
- 关键能力：
  - 资料导入与知识库检索
  - Research Memory：论文索引、审核流、图谱与 Idea 推荐
  - Graph Canvas：Method DAG / Problem DAG / Idea Map 的 Cytoscape + overlay 可视化
  - PDF 阅读、划词翻译、整页翻译、术语解释和知识卡片保存
  - 移动端配对面板
  - 移动聊天会话的权威存储和流式生成代理
  - Tailscale TCP Serve 自动配置
  - 左侧 rail `Inbox` 待处理收件箱视图
  - 复习状态持久化

### 2.2 移动端

- 工程目录：`mobile-app`
- 技术栈：Expo Router + React Native
- 核心页面：
  - 配对
  - 知识：页内聚合知识卡片、论文笔记与今日复习
  - 聊天：页内聚合会话与采集
  - 论文与 PDF AI 阅读
  - 设置

### 2.3 共享协议

- 目录：`packages/contracts`
- 用途：
  - 配对请求/响应
  - 卡片、笔记摘要与复习事件
  - 移动端收件箱投递格式
  - 移动聊天线程、消息与流式事件
  - PDF 来源、翻译、解释与知识卡片请求
  - A+B 创新意图、确认后的分析参数与论文引用
  - 设备会话与同步相关数据结构

当前协议版本为 `2026-08-10.v2`。新增字段均为可选字段或带 Serde 默认值，旧会话 JSON 仍可读取；为兼容既有客户端，HTTP 路由继续保留 `/api/mobile/v1` 前缀，协议版本与 URL 前缀不要求同名。

## 3. 桌面 companion service

### 3.1 运行模型

- 桌面端在本机 `38465` 端口启动 companion service。
- 同一局域网下，手机可以直接访问桌面端 LAN 地址；桌面端公开所有可用 LAN 地址，移动端对候选地址做可达性和响应时间探测。
- 如果检测到 Tailscale，桌面端会尝试自动配置 `tailscale serve --tcp=38465 38465`，把 `100.x.y.z:38465` 暴露为 tailnet 内可访问地址。
- 手机端通过 6 位配对码换取 token。
- 后续请求统一基于 token 访问，不再重复输入配对码。

### 3.2 桌面端职责

- 作为配对和同步的权威节点
- 持久化移动端会话、收件箱和复习状态
- 为移动端下发卡片摘要和复习数据
- 为移动端下发已剥离 frontmatter 的论文笔记正文，并按受控 ID 删除卡片或笔记
- 接收移动端离线补发的复习事件
- 为移动端聊天执行知识库检索、模型排队、Ollama 流式调用和最终结果落盘
- 解析受控 PDF 来源并提供带认证和 Range 支持的 PDF 内容
- 复用桌面翻译、整页翻译和术语解释服务，向移动端返回 AI 结果
- 对 A+B 请求执行意图识别、双路论文检索、引用约束和结构化回答

### 3.3 数据落盘

- `mobile_inbox`：移动端采集内容
- `review_state`：复习事件和聚合状态
- `mobile_chat`：移动端独立聊天线程、消息、状态和错误信息
- 桌面端 UI 允许查看、标记已处理、恢复待处理和打开附件
- 桌面端 Inbox 入口位于左侧 rail，接收手机端 `Capture` 页提交的图片、链接和文字笔记。

## 4. 移动端本地状态与交互

### 4.1 会话与缓存

- 配对会话：`expo-secure-store`
- 本地数据：`expo-sqlite`
- SQLite 同步表包括知识卡片、论文笔记、复习状态和待发送复习事件
- PDF 文件缓存：应用私有目录，并在 SQLite 中记录来源、文件名、下载时间和页码提示
- 离线队列：
  - 复习事件先写本地 SQLite
  - 联网后再补发给桌面端

### 4.2 使用路径

- “配对桌面端”：输入桌面端显示的地址和配对码
- “聊天”：顶部在“会话 / 创新 / 采集”间切换；创新页发起 A+B 分析并浏览当前会话结果，会话把问题发给桌面端，采集把笔记、链接和图片发送到待处理收件箱
- “知识”：顶部在“卡片 / 笔记 / 复习”间切换；卡片和笔记来自桌面同步，复习评分写入离线队列后回传
- “论文”：桌面在线时进入 PDF.js AI 阅读，离线时读取已缓存 PDF

底部 Tab 只保留“知识、论文、聊天、设置”。旧采集与复习路由隐藏并重定向到聚合页的对应子视图，避免旧深链失效。

卡片和笔记的创建、编辑与删除均使用桌面端权威状态：手机创建时只提交业务字段，编辑或删除时只提交 `cardId` 或 `noteId`，不能提交桌面路径；桌面按 opaque ID 重新定位并验证资源位于活动资料库后才写入。手机收到成功响应后重新 bootstrap 并刷新 SQLite，离线时禁止创建、编辑和删除。删除知识卡片时同时移除复习记录，已排队但资源已删除的评分事件由桌面接收并丢弃。

### 4.3 移动聊天

- 移动聊天线程由桌面端持久化，手机端只保留会话 token 与本地 UI 状态。
- 新会话默认使用知识库检索；进入历史会话后默认仅使用历史上下文，可手动打开“检索”。
- 手机端支持“思考”开关：打开时请求 Ollama `think`，并以折叠块展示思考内容；关闭时只展示答案正文。
- 流式通道采用 NDJSON over HTTP，事件包括：
  - `thread`
  - `queued`
  - `status`
  - `sources`
  - `delta`
  - `done`
  - `error`
- 桌面端和移动端共用同一个模型队列，避免桌面聊天、命令和移动聊天同时抢占本地 Ollama。
- 手机端长连接断开不再判定为模型失败；桌面端会继续读取 Ollama 输出并把最终结果保存到移动会话，用户刷新会话后可继续查看。
- 移动端聊天支持删除会话、新建会话和切换历史会话。
- 消息区独立滚动，输入 Dock 铺满页面底部；`/` 与 `@` 候选作为 Dock 上方的高层级可滚动浮层，不进入消息文档流，也不被工具栏或输入框遮挡。
- `/` 与 `@` 工具按钮按 `TextInput` 当前光标或选区插入触发符；候选选择只替换 caret 左侧的活动草稿，并把光标恢复到 Token 之后，不干扰 Android 中文输入法的自然选区。候选选择后保留可见 Token，用户删除 Token 时同步清除结构化状态。发送前剥离可见 Token，只以 `command` 和 `paperContext` 表达协议语义。
- 动作型命令 `/brief`、`/method`、`/exp`、`/claim` 在已绑定单篇 `paperContext` 时允许空正文直发，由移动端生成固定默认任务；`/ask` 必须携带问题，`/innovation` 必须携带 A+B 概念，动作型命令未选论文时不得默认扩展到整个资料库。
- 助手正文、创新结果、PDF AI 结果、卡片与笔记使用纯 React Native 的受控 Markdown 渲染；原始 HTML 与远程图片被禁用，HTTP(S) 外链需二次确认。

### 4.4 移动端 PDF AI

#### 阅读模式

- 在线模式：`react-native-webview` 打开 companion service 提供的 PDF.js 页面，页面同时渲染 canvas 和 text layer。
- 划词翻译不把整页文字提取视为前置条件。请求已有选中文字时，ToUnicode CMap 或页面 Context 提取失败仅记录为降级，模型继续翻译选区；整页翻译仍要求该页存在可提取文字。
- 术语解释的模型调用与百科查询并行执行，百科查询最长等待 5 秒。模型总结不依赖百科，先使用稳定领域知识解释概念，再联系页面 Context；Context 只能支持论文特定含义，不能替代概念定义。移动 UI 分区标记模型解释、外部资料和 PDF 原文，`model_only` 与 `source_only` 都是可保存的成功降级状态。
- 离线模式：`react-native-pdf` 打开应用私有目录中的缓存 PDF。
- 在线阅读器加载失败或桌面断开时保持当前页并回退离线模式；桌面重连后允许重新进入 AI 阅读器。
- PDF.js、worker 和样式随桌面端打包，不使用 CDN。

#### 加载与缓存

- 来源统一表示为 `sourceType + sourceId + page`，其中 `sourceType` 为 `card`、`paper` 或 `workspacePdf`。
- 桌面端负责把来源标识解析为已登记文件，拒绝任意路径和越权来源。
- PDF 内容接口支持单段 HTTP Range，并返回 `Accept-Ranges`、`Content-Range` 和正确内容长度。
- PDF.js 使用 `256 KiB` range chunk，关闭自动抓取和流式整文件预取，首屏只渲染当前页。
- 移动端先查找已有缓存，不在在线阅读器首屏阶段并发下载整份 PDF；阅读器 ready 或进入离线回退后再启动后台缓存。
- Token 仅存在于请求头和 WebView 页面内存，不进入 URL、日志或 PDF 缓存。

#### 文字选择与 AI 操作

- 默认保留系统长按选词；工具栏另提供无需长按的“选字”模式。
- 进入选字模式后，pointer down 直接确定字符锚点，拖动确定焦点；页面按视觉坐标重建行、栏与字符阅读流，高亮表现为连续文字片段，并在首尾提供大触控区端点手柄。
- 选区不再由屏幕矩形决定，也不依赖 PDF text layer 的 DOM 顺序。焦点若跨越栏边界会钳制在当前阅读流，并提示跨栏内容分次选择，从而避免上方、左栏或页边文本被错误夹入。
- canvas 不接收指针事件，text layer 与页面采用同一 viewport 且无额外偏移，避免选区漂移到触点上方。
- WebView 通过 `postMessage` 发送 `ready`、`page`、`selection` 和 `error`；移动端用原生面板提供：
  - 翻译选中内容
  - 解释术语
  - 翻译当前页
  - 保存解释知识卡片
- 选区翻译最多 2400 个 Unicode 字符，术语最多 120 个 Unicode 字符；页码必须在文件实际范围内。
- PDF AI 请求进入桌面共享模型队列，排队上限为 45 秒。百科等外部术语来源失败时降级为仅使用模型解释，不中断主流程。
- `selection` 事件额外携带可选的选区周边 Context。解释优先使用 PDF.js 文字层 Context；桌面回退提取文本需清除控制字符并拒绝高密度 Unicode 替换字符，低质量 Context 不展示也不进入模型。
- 缓存键包含文件签名、页码、操作类型、选区、解释模式、模型、Context 和提示词版本；解释缓存升级为 `explain-v2`，文件、模型或 Context 变化会自然失效。

#### WebView 安全边界

- 只允许 companion service 同源地址和 `about:blank`，阻止外部导航与弹窗。
- PDF 下载继续使用 Bearer Token；不开放任意文件访问。
- AI 操作仅在桌面在线且鉴权有效时显示。

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
- 比赛演示构建使用测试 keystore，GitHub Release 产物固定带 `-demo.apk` 后缀，避免误认为应用商店正式签名包。
- 移动端图标以 `dist/icon.svg` 为源，派生到：
  - `mobile-app/assets/icon.png`
  - `mobile-app/assets/adaptive-icon.png`
  - `mobile-app/assets/splash-icon.png`
  - `mobile-app/android/app/src/main/res/mipmap-*`
- 桌面端图标同样以 `dist/icon.svg` 为源，派生到 `src-tauri/icons/*` 中 Tauri 配置实际引用的 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.ico` 和 `icon.icns`。

### 5.5 比赛演示 CI/CD

当前流水线服务于 MVP 与比赛展示，目标是尽快发现会阻断演示的错误并稳定生成可安装包，不承担应用商店上架职责。

- 常规 CI 将 Repository/Web、Mobile、Rust 拆成三个并行任务；Web 构建自身完成 TypeScript 编译，避免重复 typecheck。
- 移动任务执行 TypeScript 检查和聊天输入纯函数测试；Rust 任务执行 rustfmt 与库测试，不运行耗时的全目标发布构建。
- `scripts/check-release-version.mjs` 统一校验根包、共享协议、Tauri、Cargo、Expo、Gradle `versionName` 和 Android `versionCode`；标签发布额外要求 tag 等于 `v<版本>`。
- 第三方 GitHub Action 固定到不可变提交 SHA，pnpm、Rust、Gradle 和 Ollama 继续使用缓存；所有任务设置超时，普通 CI 使用最小 `contents: read` 权限。
- 标签发布先创建 draft release，再并行构建 Windows 与 Android，缩短总等待时间。Android 产物使用测试签名并命名为 `researchassistant-mobile-v<版本>-demo.apk`。
- 手动 Android 重发必须检出输入 tag 后再构建，不能从当前默认分支生成旧标签产物。
- Windows 与 Android 产物分别上传 SHA-256 校验文件，便于比赛设备快速确认文件未混淆或损坏。

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
- 移动会话输入框支持独立的 `/` 指令选择器与 `@` 论文选择器：
  - `/ask`、`/method`、`/exp`、`/claim`、`/brief`、`/innovation` 作为结构化 `command` 发送
  - `@` 论文作为 `paperContext` 发送，包含受控的 `sourceType`、`sourceId` 和标题
  - 桌面端校验指令白名单并将检索 scope 限制到所选论文；工作区 PDF 未索引时明确按无证据处理

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
- 有本地证据的移动 A+B 回答会持久化为 `mobile_innovation` Idea；证据论文以 `Paper` 节点出现，并通过可点击的 `supports_idea` 边指向 Idea。边标签沿用 `[A1]`、`[A2]`、`[B1]`、`[B2]`，节点与边详情均可跳转到原 PDF 页。
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

## 7. A+B 组合创新分析机制

### 7.1 要解决的问题

普通单路检索擅长回答“某篇论文说了什么”，但不能稳定处理“能否把方法 B 迁移到研究对象 A”这类跨领域问题。A+B 机制把该问题拆成三个可审计环节：先确认两个概念，再分别寻找两侧证据，最后生成可被实验否证的迁移假设。

该机制的产物是“创新候选与验证方案”，不是新颖性检索报告，也不是对学术创新已经成立的证明。真正的创新判断仍需要更完整的文献调查、领域专家判断和实验结果。

### 7.2 意图识别与人工确认

1. 移动端发送消息前调用 `POST /api/mobile/v1/chat/innovation-intent`。
2. 启发式规则先识别 `A+B`、`结合 A 与 B`、`在 A 上使用 B`、`在 A 上应用 B` 等明显模式；不命中时直接进入普通聊天，减少模型调用。
3. 命中后由桌面聊天模型输出严格 JSON，包含 `detected`、A/B 概念、可能的全称、推荐角色和歧义说明；模型不可用时保留启发式结果。
4. 移动端展示可编辑确认卡。缩写及其全称必须由用户确认，不能静默采用模型猜测；用户修改概念后，旧的缩写展开不再沿用。
5. 用户确认后把 `innovationAnalysis` 随聊天请求发送；取消则按普通聊天回答。

移动端同时提供明确的“创新”页内入口。该页面包含 A/B 双输入、开始分析按钮和当前会话历史创新结果；它复用同一 `innovationAnalysis`、消息持久化和 `Idea Map` 数据链路，不建立第二套不可追溯的创新存储。

默认角色是：A 为“研究对象或问题”，B 为“方法或技术”。这只是检索和组织答案的建议，不限制用户交换或改写两个概念。

### 7.3 双路检索与证据选择

```text
用户问题
  -> 创新意图预检
  -> 用户确认 A / B
  -> A 侧 Research Memory 混合检索 --\
                                      -> 去重与相关性过滤 -> 证据上下文
  -> B 侧 Research Memory 混合检索 --/                         |
                                                               v
                                                受约束的 Ollama 流式分析
```

- A、B 两侧并行调用现有 Research Memory 混合检索，每侧最多获取 8 个候选命中。
- 检索词由概念和用户确认的全称组成。
- 同一论文的多个命中先合并页码范围、最高分和片段，再依据标题、片段中的概念词和常见缩写别名判断相关性；不再仅凭高相似度分数判定概念命中。
- 每侧最多选择两篇不同论文。B 侧排除已经作为 A 侧证据的全部论文，避免同一论文同时冒充两侧独立证据。
- A 侧引用为 `[A1]`、`[A2]`，B 侧引用为 `[B1]`、`[B2]`；引用包含 `paperId`、标题、起止页码、片段和来源类型。
- 演示 PDF 尚未进入 Research Memory 时，可在标题明确命中概念别名后读取真实首页文字作为 `workspace_pdf_fallback` 证据；空文本页不得生成引用。
- 检索失败或某侧无相关论文时按“无本地论文证据”继续，不把网络错误伪装成空白引用。

### 7.4 生成约束与回答结构

证据在正文生成前通过 NDJSON `sources` 事件发送，并写入助手消息的 `citations` 和 `innovationAnalysis` 字段。断线后重新获取会话时，证据卡片仍可恢复；点击卡片打开对应论文和命中页。

移动端在完整 Markdown 正文之前渲染“创新点”摘要卡，展示 A/B 概念、`evidenceStatus` 和从第 5 节提取的 2–3 条创新假设；流式阶段尚未生成该节时显示生成中状态。“创新”页从相同的持久化消息恢复完整结果，不增加不可追溯的独立摘要字段。

创新删除区分两个对象：删除分析记录会移除本次 assistant 创新消息及其相邻 user 请求，但保留已进入 Idea Map 的节点；删除 Idea 会在事务中清理 `idea_paper_links` 与 `idea_candidates`，清除来源消息的 `ideaId`，但保留聊天正文、来源论文和引用。流式生成期间禁止删除。引用 snippet 在桌面映射和手机展示两层执行乱码质量门禁，低质量片段不参与卡片展示，但标签、标题、页码和 PDF 跳转保持可用。

模型上下文只允许使用 `sources` 事件实际提供的 A/B 标签，回答固定包含：

1. 概念与问题定义
2. A 侧论文证据
3. B 侧论文证据
4. 可迁移机制与兼容性
5. 2–3 个创新假设
6. 最小可行实验方案
7. 潜在失败原因与反证
8. 证据边界

某一侧缺少证据时，模型可以使用通用知识继续推断，但必须明确标记为推断，且不得为该侧添加引用。两侧都没有证据时，回答开头必须写“本次分析未使用本地论文证据”，消息不显示引用卡片。

### 7.5 创新机制的风险与边界

- 缩写歧义：`AD` 等缩写可能对应多个领域。人工确认只能降低误解概率，不能替代领域定义。
- 本地语料偏差：结果只反映已经进入 Research Memory 的论文；“没有命中”不代表学界没有相关工作。
- 片段代表性：每侧一篇论文和有限片段不足以覆盖完整方法条件、负面结果和最新进展。
- 相关性误判：标题或片段包含概念不等于论文真正以该概念为核心；高检索分数也只是候选信号。
- 迁移可行性：A 与 B 在数据结构、监督信号、样本量、评价指标、计算成本和伦理约束上可能不兼容。
- 新颖性误判：把两个概念组合起来不自动构成创新，模型生成的假设还需要在线或系统性文献检索验证先例。本版本明确不做在线论文搜索。
- 引用边界：`[A1]`、`[B1]` 只支持相邻论断，不能为模型通用知识或跨越证据范围的结论背书。
- 证伪优先：最小可行实验必须包含 baseline、关键消融、失败判据和替代解释，避免只提出无法检验的概念拼接。

后续评估应分别记录意图识别准确率、A/B 检索命中率、引用一致性、假设可检验性和专家新颖性评分，不能用“回答看起来合理”作为唯一验收指标。

## 8. 验收基线

- `pnpm install --force`
- `pnpm check:conflicts`
- `pnpm check:release-version`
- `pnpm exec tsc --noEmit`
- `pnpm --dir mobile-app exec tsc --noEmit`
- `pnpm --dir mobile-app test:chat-composer`
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `pnpm build`
- `cd mobile-app/android && .\gradlew.bat assembleRelease --console=plain --no-daemon`
- `pnpm tauri build --bundles nsis --ci`
- 真机或模拟器可完成配对、移动聊天、页内采集、收件箱显示、卡片与笔记同步、删除确认和复习状态同步
- Android 真机可在 PDF.js 中直接拖动选字并调整首尾手柄，完成划词翻译、术语解释、整页翻译和解释卡片保存
- PDF.js 首屏按 Range 加载当前页；桌面断开后已缓存 PDF 可保持页码并切换离线阅读
- 输入“能否在 AD 上使用 GNN 分析”后可确认概念、获得双路分析，并只显示真实存在的 `[A1]`、`[B1]` 证据卡片
- A/B 单侧或双侧无本地证据时不得生成对应论文引用
- 桌面端可完成论文导入、候选抽取、审核入图与向量检索

## 9. 已知限制

- 若系统级 Windows 长路径策略未开启，构建日志仍可能出现 CMake 路径 warning，但当前已不阻断 release 构建。
- `mobile-app/android/autolink-*.json` 含有本机绝对路径，因此只作为本地缓存，不入库。
- Android 发布产物是比赛演示用测试签名 APK；当前不生成 AAB，不配置应用商店正式签名、渠道分发、商店元数据或自动上架。
- Tailscale 访问依赖本机 Tailscale 客户端和 tailnet 策略；自动 TCP Serve 失败时仍可退回局域网地址。
- 移动端流式体验受本地 Ollama 队列影响；如果桌面端已有长生成任务，手机端会显示排队状态。
- 在线 PDF AI 阅读依赖桌面端连接；离线模式只负责阅读已缓存文件，不提供翻译和解释。
- PDF.js 文字选择依赖 PDF 自带文字层；扫描版或文字映射异常的 PDF 仍需要 OCR，本版本不包含 OCR。
- 移动 WebView 的系统长按选区在部分 Android WebView 版本中仍可能不稳定，因此额外提供“选字”模式；跨栏必须分次选择，旋转文字和异常字形映射仍可能影响选区精度。
- A+B 第一版只分析两个概念、每侧最多展示两篇本地论文证据，不执行在线论文检索、自动下载全文或正式的新颖性查重。
- Expo / React Native 升级后，需要同步更新 `patches/` 与 Android 构建脚本。
- Graph Canvas 已是 Cytoscape + React/SVG overlay 交互图，但节点拖动、边命中区、星图入场动画和大图性能仍需继续打磨。
- `analyze_pdf_page_visual` 当前仍是页文本回退，不是真正的视觉模型解析。
- `compare_papers` 已有后端实现，但前端完整工作流仍待补齐。
- 第一批 slash command 当前仍聚焦单论文阅读；跨概念分析由独立的 A+B 流程承担，尚未扩展为通用多文献比较命令。
- `Research Memory` 说明已经并入本文件，不再维护单独的 `RESEARCH_MEMORY_MANUAL.md`。
