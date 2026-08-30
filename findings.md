# 审计发现记录

## 需求

- 对仓库中的项目进行技术审计并交付中文报告。
- 审计默认保持只读，不修改业务代码或配置。
- 新增执行需求：移动端 PDF AI 完整对齐桌面端，并新增自动识别、确认后执行的 A+B 创新分析。

## 功能实施基线

- 移动端已有论文列表、PDF 下载与离线缓存、原生 PDF 阅读器，但 Android 原生组件没有可用文字层。
- 桌面 Rust 已实现划词翻译、整页翻译和术语解释；应抽成共享函数供 Tauri command 与 Axum 路由复用。
- 移动聊天已有 Bearer Token 认证、NDJSON 流式输出与断线后会话恢复，当前检索只针对整句执行一次且不保留结构化来源。
- Research Memory 的搜索命中已包含 paper_id、标题、页码、片段和分数，可用于 A/B 分侧检索与证据卡片。
- 用户确认：Android 优先；PDF 使用在线 PDF.js 与离线原生阅读混合模式；A+B 自动识别并确认；仅本地论文，缺论文时模型可继续但不得引用。

## Rust 应用级 OCR 基线

- 相邻 OCR 工程已经验证 PP-OCRv6、逐页缓存、断点续跑、旋转坐标和千页 PDF 低内存处理，但其 Python 版本只有 OCR 行框，没有可靠版面区域与阅读顺序。
- 旧方案向 PDF 写入隐藏文字对象，选区仍会受字体 advance、ToUnicode 和查看器命中测试影响；应用级 OCR 应改为结构化 Sidecar，并由阅读器直接绘制 Token 选择层。
- 本机 PaddleOCR 3.7 提供 LayoutDetection，但 ResearchAssistant 将采用 Rust + ONNX Runtime，不依赖 Python/Paddle 运行环境。
- 版面区域必须区分 body、caption、visual、furniture 和 unknown；只有 body 与 caption 进入 Research Memory。
- 当前 Research Memory 的 paper_id 由原文件路径生成，OCR 派生结果不能作为新 PDF 导入，否则会产生重复论文和分裂的 Idea 引用。
- 当前 Windows 桌面发布只支持 x86_64，并已采用 Tauri resource/sidecar 打包；OCR 第一版可针对 Windows x64 管理 PDFium、ONNX Runtime 与模型资源。
- 当前未提交的 `src-tauri/src/ocr/` 已包含类型、预检、版面排序、运行库清单、SQLite 存储和 Sidecar 读写，但没有模块入口，也未在 `lib.rs` 注册，因此此前的 `cargo check` 与 `cargo test` 实际没有编译这些文件。
- 移动聊天现有取消实现会把非法 `clientRequestId` 静默替换为服务端 UUID，重复活动 ID 也会订阅同一取消通道；两者都需要在路由注册阶段显式拒绝。
- 移动聊天任务在消息落盘后遇到检索或事件发送错误时，外层只尝试发送错误事件，没有统一持久化终态，存在会话长期停留在 `streaming` 的风险。
- 本增量完成后，移动生成使用严格校验的唯一请求 ID；提前取消、活动 ID 冲突、断线、模型错误和桌面重启均会收敛到持久化终态，线程不再遗留 `streaming`。
- OCR 基础模块现已进入 Rust 模块树和 Tauri 启动流程；运行库管理、PDF 预检、版面排序、SQLite 任务恢复、源签名失效和 Sidecar 读写均由无模型测试覆盖。
- PDFium、ONNX Runtime 和版面模型最初因缺少可信 SHA-256 保持禁用；用户随后明确要求取消该门禁，本轮没有自动下载运行库或调用模型。

## 初步发现

- 仓库为 pnpm workspace，包含 React/Vite/Tauri 桌面端、Rust 后端、Expo/React Native 移动端，以及共享协议包。
- README 声明已具备 GitHub Actions 持续集成和 Windows/Android 发布流程。
- 根 package.json 未定义单元测试、端到端测试、Lint 或依赖漏洞审计脚本；CI 仅运行 Web 与移动端 TypeScript 类型检查、Web 构建和 Rust cargo check。
- 发布工作流会在 Windows runner 下载固定版本的 Ollama sidecar，并以 draft release 形式上传桌面安装包和 Android APK。
- CI 和发布工作流中引用的第三方 GitHub Actions 均未固定至不可变提交哈希，存在供应链基线加固空间。
- 移动 companion service 绑定 `0.0.0.0`，公开健康检查与配对端点；其余接口以持久化 Bearer Token 授权。配对码仅六位，并由当前时间纳秒字段取模生成，未见过期、失败次数限制、来源速率限制或 IP 访问控制。
- 已配对设备的 Token 与配对码被以明文 JSON 写入应用数据目录；移动端本地会话采用 Expo SecureStore，形成桌面端与移动端的保护强度不一致。
- 移动端图片收件箱将 Base64 解码后直接写盘；代码未设置应用层的单文件大小、设备配额、总存储配额、速率限制或自动清理策略。
- Android release 在缺少 keystore.properties 时显式回退到公开的 debug 签名；发布工作流会创建该 debug keystore，因此 CI 发布的 APK 也会走此路径。
- Android 清单为全应用启用 cleartext 流量；移动客户端会默认将无协议地址补为 HTTP。局域网直连时 Bearer Token 与资料内容缺少传输层机密性保护。
- Tauri 配置将 CSP 设为 null，并授予 `fs:default`；当前未检出 React 端的 dangerouslySetInnerHTML，但该组合会扩大未来 WebView 注入问题的影响面。
- 核心模块集中度很高：research_memory.rs 约 303 KB、lib.rs 约 199 KB、App.tsx 约 153 KB，且 Rust 后端暴露约 80 个 Tauri command；维护和回归风险随功能增长而上升。

## 已验证的正向控制

- 受保护的移动接口在路由层统一调用 Bearer Token 授权；配对成功后令牌采用 UUID v4 生成。
- 笔记草稿路径通过 canonicalize 与目录前缀检查限制在允许目录内；移动端线程 ID 与附件文件名均有字符净化。
- Gitignore 已排除 Android 签名文件、局部配置、构建产物及 Tauri sidecar。
- 前端未检出 dangerouslySetInnerHTML；外部链接使用 noreferrer。

## 审计范围与限制

- 范围：受 Git 管理的应用代码、构建配置、GitHub Actions、桌面端能力声明、移动端网络与本地存储代码。
- 不包含：线上部署环境、GitHub 仓库/组织权限、实际签名密钥、Tailscale ACL、Ollama 模型行为与第三方依赖源代码。
- 结论以仓库当前工作区内容和本地可执行检查为依据，不替代渗透测试或第三方依赖的完整漏洞扫描。

## 审计方法

| 方法               | 目的                                             |
| ------------------ | ------------------------------------------------ |
| 结构与配置检查     | 确认模块边界、构建脚本、依赖和自动化流程         |
| 代码抽样与定向搜索 | 查找权限、认证、网络暴露、错误处理和敏感信息风险 |
| 本地只读验证       | 核验类型检查、冲突标记检查和可执行测试覆盖       |

## 问题记录

| 问题                                | 处理方式                                               |
| ----------------------------------- | ------------------------------------------------------ |
| pnpm audit 无法访问配置的 npm 镜像  | 请求返回 EACCES 并在 60 秒超时；未将其解释为“没有漏洞” |
| cargo test 在 60 秒内仍处于编译阶段 | 记录为验证未完成，改用 CI 同等的 cargo check 核验      |
| pnpm build 无法清空 dist            | dist/app-icon.png 被系统拒绝删除；未执行删除或覆盖操作 |

## 功能实施结果

- PDF AI 已抽成桌面与移动端共用的 Rust 服务；翻译与解释分别读取桌面持久化的翻译模型和聊天模型。
- 移动端只提交 `sourceType/sourceId/page`，桌面端按卡片、论文或工作区 PDF 解析路径，并在调用模型前验证来源与页码。
- PDF.js 与 worker 作为 Tauri 本地资源打包；Token 只通过请求头进入阅读页，并由页面在内存中用于受认证 PDF 下载。
- PDF AI 结果缓存包含文件签名、页码、操作、文本、模式、模型和提示词版本；文件或模型变化会形成新缓存项。
- A+B 分析会合并同一论文的多条命中、过滤弱相关候选，并确保 B 侧不复用 A 侧论文。
- 会话消息新增字段均使用 Serde 默认值，旧会话缺少引用和创新分析字段时仍可读取。
- 旧几何矩形框选是双栏页面出现“触点上方和左栏一起高亮”的直接原因；新实现从触点对应字符开始沿视觉阅读流选择，因此不会把锚点之前的整片内容自动纳入。
- 移动 `/` 指令使用白名单并作为结构化字段传输；`@` 论文包含受控来源 ID，桌面检索 scope 可精确限制到已索引 paper_id。
- A+B 会话 Idea 使用线程与消息生成稳定 ID，重复完成不会创建重复 Idea；论文标题、路径、页码和片段快照保存在 `idea_paper_links`。
- 6 篇演示论文中未索引文件可按标题别名与真实 PDF 首页文字生成工作区回退证据；空文本页或标题不相关时不生成引用。
- 原 120 篇 PDF 已按用户授权物理清理为 6 篇，释放 670.04 MiB；Ali 的 `(2)` 重复副本已删除。

## 移动端导航与资料库整合发现

- 当前底部导航共有“复习、卡片库、论文、采集、聊天、设置”六个 Tab，确实超过手机端舒适数量。
- “采集”页面只是向桌面 `mobile_inbox` 提交图片、URL 和备注，业务上属于聊天输入的扩展动作，适合并入聊天页顶部切换。
- “复习”只消费本地已同步卡片并回传评分，业务上属于卡片库的下一步动作，适合并入卡片库顶部切换。
- 卡片库目前已经支持从桌面同步卡片及本地搜索，但没有删除入口；复习和卡片库仍是两个独立页面。
- 聊天页的输入区热修已经改为消息区独立滚动、底部 Dock 固定、命令和论文菜单绝对定位在 Dock 上方。
- 移动 bootstrap 目前只返回知识卡片和复习记录，不包含桌面 `paper_drafts/notes` 笔记库；移动端 SQLite 也只有 cards、review_records、queued_review_events 和 PDF 缓存表。
- 桌面已有受控的笔记列表、读取、更新、创建与删除 Tauri command，也已有知识卡片删除实现；移动 companion service 尚未暴露对应的笔记同步与删除路由。
- 因此“笔记库同步”和“删除”不能只做页面按钮，必须扩展共享协议、bootstrap、受认证路由与本地缓存，才能保证桌面和手机状态一致。
- 移动端不应接收或回传任意桌面文件路径。卡片删除应只接收 `cardId`，由桌面重新枚举卡片并解析真实路径；笔记删除应只接收桌面生成的受控 `noteId`，再在 `paper_drafts/notes` 目录内匹配。
- 现有桌面 Tauri 卡片删除 command 直接接收路径，不能原样暴露给移动 HTTP；新移动路由需要额外的 ID 到受控路径解析层。
- bootstrap 适合追加可选 `notes` 字段并提供默认值，以保持旧移动客户端和旧缓存兼容；移动 SQLite 需要新增 notes 表以及单项删除函数。
- 删除知识卡片时还应从桌面复习状态移除对应 `cardId`，并从手机 SQLite 删除 card、review_record 及尚未发送的该卡片复习事件，避免幽灵待复习记录。
- 桌面笔记草稿已经包含标题、创建时间、来源论文、预览与完整 Markdown；移动协议可直接映射为不含路径的 `MobileNoteRecord`。
- 旧独立 capture/review 路由可保留但在 Tabs 中以 `href: null` 隐藏，从而兼容已有深链而不继续占用底部导航。
- UI 审视确定聚合页状态采用 URL 参数：`/chat?view=chat|capture` 与 `/library?view=cards|notes|review`，这样重载、返回与旧深链跳转都能保留当前子页面。
- 同步内容必须剥离 YAML frontmatter；`source_paper` 只保留文件名，不向移动端发送绝对路径。
- 根入口当前默认跳转到独立复习 Tab，导航整合后应改为知识页的 `review` 子视图。
- PDF 解释保存卡片后原实现只失效 React Query，但卡片查询读取 SQLite，不能立即看到新卡片；保存成功后必须执行一次 bootstrap 同步再失效查询。

## 1.1.10 真机反馈发现

- `/` 与 `@` 当前只设置 `selectedCommand`、`selectedPaper` 并显示输入框外的 Context chip；`chooseCommand` 会清空斜杠草稿，`choosePaper` 会移除 `@` 草稿，因此用户在输入栏中看不到选择结果。
- 修复不能只把文字拼进输入框，否则模型正文会重复收到 `/brief` 和完整论文标题；发送前需要剥离由结构化选择产生的可见 Token，同时继续发送 `command` 与 `paperContext` 字段。
- 用户截图中的助手回答仍以普通 `Text` 展示，`###`、`**` 等 Markdown 标记原样可见；创新卡片虽存在于单条助手消息下方，但没有独立入口，历史长会话中很难发现。
- PDF 解释的 `pageContextSnippet` 来自桌面 `pdf_extract` 页面文本。截图含大量 Unicode 替换字符 `�`，集中出现在日期、DOI 与重音字符处；这属于 PDF 字体映射/编码质量问题，不是 React Native 字体缺失。
- 对低质量页面文本需要先做 Unicode 质量清洗与片段评分：删除控制字符，折叠异常空白；替换字符比例过高的行应丢弃，整体仍不可靠时不要展示页面上下文，也不要将其传给解释模型。
- 设置页副标题仍写“手机端只负责缓存、采集和离线复习”，已经不符合移动聊天、PDF AI、笔记与卡片同步、创新分析等现有能力；应改为“桌面权威存储与推理，移动端提供同步访问和离线缓存”，并补充 AI 结果边界。
- 移动工程没有 Markdown 渲染依赖。为避免新增原生兼容风险和网络安装依赖，本轮采用纯 React Native 的受控 Markdown 渲染组件，覆盖标题、段落、列表、粗体、斜体、行内/块代码、引用、分隔线和安全 HTTP(S) 链接。
- 根工程的 `react-markdown` 面向 DOM，不能直接复用到 React Native；移动渲染必须使用原生 `Text/View/Pressable` 组件。
- 聊天聚合页 `HubSwitch` 目前只有“会话 / 采集”，创新确认卡位于消息滚动区、创新结果卡位于单条长回答底部，说明“没看见创新页面”是信息架构问题，不是后端未生成。
- 创新页可以直接从当前 `MobileChatThread.messages` 中筛选 `innovationAnalysis` 恢复历史结果，不需要增加协议；同时提供 A/B 双输入，将 `/innovation` 与标准提问草稿写回会话输入栏。
- 解释结果已有 `pageContextSnippet`，但请求只提交 term。更可靠的方案是让 PDF.js 文字层在 selection 事件中附带选区周边 Context，并把它作为可选字段传到桌面；桌面优先使用该 UTF-8 Context，再回退到 lopdf 提取并执行乱码质量门禁。
- 解释缓存键需要从 `explain-v1` 升级，否则同一选区可能继续命中包含乱码的旧结果。
- PDF.js 当前自定义框选已保存线性阅读流、起止字符索引，因此可直接从同一阅读流截取选区前后字符作为可靠上下文，不需要再次执行桌面 PDF 文本提取。
- 创新页采用现有 `innovationAnalysis`、`command=innovation` 和消息持久化协议即可落地；新增的是页面可发现性与结果浏览，不引入并行的创新数据源。

## 1.1.11 真机反馈发现

- 移动会话线程已经集中由 `read_mobile_chat_thread` / `write_mobile_chat_thread` 持久化，适合在服务端原子删除创新分析消息，避免仅在手机本地隐藏后同步复活。
- 移动路由当前只导入 `get/post/delete`，卡片与笔记编辑接口需要补入 `patch` 并复用现有安全 ID 到文件映射，手机端继续禁止提交桌面路径。
- `MobileChatRole` 与 `MobileChatMessage` 均可克隆并完整反序列化；创新分析删除可以定位 assistant `messageId`，同时仅移除紧邻且属于同次创新请求的 user 消息。
- Idea 数据在 SQLite 中由 `idea_candidates` 与 `idea_paper_links` 两张表组成，删除必须使用事务先清理支持边，再删除 Idea，并将来源会话消息的 `ideaId` 清空。
- 卡片手动创建函数已生成受控 YAML frontmatter；更新请求新增可选 `term` 后可保留旧来源字段并允许手机修改术语、标题和 Markdown 正文。
- 移动笔记列表已通过文件名生成 opaque ID，创建与编辑返回后可复用同一映射函数生成完整 `MobileNoteRecord`，无需向手机暴露路径。
- 已为移动路由确定 REST 形状：集合 `POST` 创建、单项 `PATCH` 编辑、原有 `DELETE` 删除；创新分析记录按 thread/message 删除，Idea 节点按 ideaId 删除。
- `PaperDraftDetail` 是公开结构，可由移动模块直接统一映射到笔记响应，避免创建、编辑、同步三条路径产生字段差异。

## 1.1.12 真机反馈发现

- 桌面划词翻译的直接失败点位于 `translate_pdf_selection_with_cache`：即使请求已携带可靠的 `request.text`，函数仍对整页调用 `extract_pdf_page_text_cached(...)?`；损坏的 ToUnicode CMap 因 `?` 被提升为致命错误。
- 术语解释共享服务确实调用 `summarize_term_for_beginner` 生成 `plain_summary`，移动面板也接收该字段；但移动内容没有“模型解释”标题，随后紧跟“页面上下文”，视觉上容易误认成只有 Context。
- 需要进一步核对模型失败分支：当前模型与百科同时缺失时会直接返回错误，不满足用户提出的“至少给出模型自己的理解”；应保证模型调用是主路径，并把页面提取、百科查找都限定为可选增强。
- 桌面解释弹窗明确分为“通俗解释”和“参考资料摘要”，并展示 `source+model/model_only/source_only` 状态；移动端把三个字段拼成一段 Markdown，缺少同等层级和状态标签，这正是两端观感不一致的直接原因。
- 当前解释服务先等待百科，再将百科内容放入模型提示；更稳妥且更快的方案是让“模型独立解释”和“限时百科查询”并行，模型总结不依赖百科或页面提取，百科只单独显示为可核验增强。
- UI 审视确定空正文命令只对 `/brief`、`/method`、`/exp`、`/claim` 且已选择论文时生成默认任务；`/ask` 与 `/innovation` 继续要求用户输入，避免静默猜问题或 A+B 概念。
- 移动 PDF 面板状态已经保留完整 explanation 结构体，可以直接增加专用结果组件，不需要扩展协议或再次请求桌面端。
- 原解释提示词含“不要生成页面上下文中没有的结果”，虽然本意是阻止伪造论文结论，但会让模型把 Context 误当作概念知识边界；应改为允许稳定领域知识定义，同时只禁止虚构该论文的实验、数字和结论。
- 版本残留检查中的 `1.1.11` 仅属于 `pin-project` 与 `pin-project-internal` 第三方 crate；应用 `researchassistant` 锁文件版本已经更新为 1.1.12。
- 1.1.12 桌面与 Android 正式包均已构建，但本轮环境的提升权限自动审批额度耗尽，无法覆盖受保护分发目录或安装目录；可直接使用构建目录中的已核验安装包完成手动升级。

## 1.1.12 发布与 CI/CD 发现

- 当前 `main` 尚无 `v1.1.12` 标签，已有最高标签为 `v1.1.6`；本轮需要将此前已暂存的 1.1.7–1.1.12 累积功能作为一次明确的 1.1.12 发布提交交付。
- 现有 CI 把 Web 与移动端检查串行放在同一任务中，Rust 仅执行 `cargo check`，尚未执行 `cargo fmt --check`、Rust 单元测试、移动快捷命令测试和版本一致性校验。
- 桌面标签发布没有在构建前校验 Git 标签与根包、Tauri、移动包和 Android 版本是否一致，错误标签仍可能产出语义不一致的安装包。
- 工作流已经使用 pnpm、Rust、Gradle 和 Ollama 缓存；本轮优化应保留这些有效缓存，并通过任务拆分、超时限制、最小权限和发布前门禁提高反馈速度与可靠性。
- 手动 Android 发布接收目标 `tag`，但 `actions/checkout` 没有设置 `ref`，当前会从默认分支构建再上传到指定旧标签，存在“标签代码与 APK 内容不一致”的实际风险。
- 标签触发的 Android 任务当前依赖桌面任务。虽然这会增加总时长，但桌面 Tauri Action 负责创建 draft release；直接并行可能让两个任务竞争创建同一 Release，因此本轮保留该依赖，只优化各任务内部步骤。
- 发布产物目前只有通用名 `app-release.apk` 且没有随包上传 SHA-256；改为带标签的稳定文件名并附加校验文件，可以降低人工下载和分发时的版本混淆。
- 已通过各 Action 官方 GitHub 仓库的公开引用取得当前大版本提交，可将 `checkout`、pnpm、Node、Rust、cache、Tauri、Java 与 release 上传 Action 全部固定到不可变 SHA，并以行尾版本注释保留升级线索。
- `packages/contracts/package.json` 仍为 1.1.5，而根应用、Tauri、Cargo、Expo、移动包与 Gradle 已为 1.1.12；统一版本门禁会暴露该历史漂移，需要在发布前同步修正。
- Android Gradle 已支持 `mobile-app/android/keystore.properties`。CI/CD 可以从加密 Secrets 临时生成 keystore 与属性文件，并在 Secrets 未配置时明确标记为内部测试签名，而不是把 debug 签名误称为正式分发签名。
- 聊天页当前菜单过滤直接读取整段 input，且候选选择只替换输入末尾；修复需要引入独立 `composerSelectionRef` 与基于 caret 的触发区间解析。
- 创新历史卡目前没有操作区，引用卡对空 snippet 也没有降级提示；两者可以在现有卡片结构中直接补按钮和中文质量提示，不改变页面导航。
- `mobile.rs` 已有协议兼容与检索选择测试模块，可直接加入正常中英/希腊字符、替换字符、NUL 和 mojibake 样本，验证乱码门禁不会误伤科研符号。
- 当前 `/` 与 `@` 工具按钮调用 `appendComposerTrigger`，只能把触发符追加到字符串尾部，没有记录 `TextInput` 的 `selection`；候选匹配也只分析输入末尾，因此无法符合光标位置语义。
- 快捷项选择后应把当前触发草稿替换为 Token，并显式恢复选区到 Token 之后；发送逻辑必须从完整输入剥离结构化 Token，不依赖 Token 位于开头或结尾。
- 桌面端已具备知识卡片更新、手动笔记创建与笔记更新的文件操作，但现有移动路由只开放卡片/笔记删除，需要增加 opaque ID 到受控路径的创建与更新接口。
- 移动知识页已经有卡片、笔记详情和删除确认，可在同一页增加统一编辑抽屉，避免新增底部 Tab。
- 移动创新结果依赖助手消息的 `innovationAnalysis` 与 `ideaId`；删除时应先删除 Research Memory 的 Idea 与论文支持边，再清除消息上的结构化创新字段，聊天正文是否保留需要在确认文案中明确。
- 截图中的证据乱码来自 A/B 引用 `snippet`，与上一轮术语解释 Context 是不同链路；需要在生成 `MobileCitation` 前进行同类 Unicode 质量门禁。
- 知识卡片创建可复用 `cards::save_knowledge_card_from_explanation`，以 `source_status=manual_mobile`、空 PDF 和用户 Markdown 生成受控文件；更新必须先按 cardId 枚举卡片，再把内部路径传给现有更新函数。
- 笔记 ID 已使用 notes 目录内文件名，服务端可按该 ID 枚举并重新定位；现有创建/更新命令需要抽成共享函数，移动路由不得接收 `path`。
- 引用的两个下游消费者分别是 `MobileCitation.snippet` 和 Idea Map `EvidenceRef.snippet`，应在映射时使用同一个清洗结果，避免手机卡片隐藏乱码但 Idea Map 仍保存污染证据。
- 卡片更新函数会保留原 frontmatter，并把请求 body 重新包成 `# 标题`；移动编辑器应展示剥离 frontmatter 与首个同名 H1 后的正文，避免保存后重复标题。
- 手动卡片创建可把用户 Markdown 放入“通俗解释”区，后续编辑则使用通用 body；客户端成功后统一重新 bootstrap，不直接拼造本地记录。
- Research Memory 已有按 Idea ID 更新与读取能力，删除可在同一模块事务中先删 `idea_paper_links` 再删 `idea_candidates`，随后发出图谱更新事件。
- Tauri 的 build script 会在任何 `cargo check/test` 阶段验证 `tauri.conf.json` 中声明的 PDF.js 资源；独立 Rust CI 若不先恢复根 `node_modules`，会以“缺少 pdf.worker.min.js”失败。MVP 修复采用 pnpm `--ignore-scripts` 安装，只恢复资源树而不执行不必要的原生安装脚本。

## Windows CI 与比赛发布失败发现

- Windows runner 检出文本为 CRLF，而 Prettier 默认会按 LF 比较；因此一次性报告 75 个文件并不代表 75 处源码格式错误，核心是跨平台换行策略缺失。
- Windows 桌面构建的冷 Rust 编译已经超过 90 分钟，工作流的 `timeout-minutes: 90` 会主动取消仍在正常编译的任务；比赛发布不应设置该任务级限制。
- `softprops/action-gh-release` 在 GitHub Release API 连续返回 502/500 后耗尽内置重试，导致已经完成或接近完成的构建无法上传；发布元数据与资产上传需要独立、可重入的退避重试。
- 当前 `v1.1.12` 标签已经存在，单纯修改 tag 触发工作流无法修复该次发布；桌面发布需要新增 `workflow_dispatch`，从 `main` 使用新工作流但检出指定旧 tag 构建。
- 用户提供的 Node 20 信息明确说明 runner 已默认以 Node 24 执行；它是迁移提示而不是此次失败原因。移除 `softprops` 和 `tauri-action` 后可减少第三方 JavaScript Action 路径，但无需启用不安全的 Node 20 回退变量。

## OCR 参考项目与移动横屏发现

- `E:\Projects\OCR` 的可迁移价值主要是逐页释放内存、OCR 与版面缓存分离、独立断点、失败页重试、指定页处理和旋转坐标处理，而不是其 Python/PaddleOCR/PyMuPDF 技术栈。
- ResearchAssistant 必须继续采用 Rust + ONNX Runtime 的应用级 Sidecar 路线，原 PDF 永不覆盖；隐藏文字层会再次引入字体 advance、ToUnicode 和查看器命中测试导致的选区漂移。
- 参考项目的 `ocr/page_XXXXXX.json` 与 `layout/page_XXXXXX.json` 分层适合迁移为原始识别缓存和规范化版面 Sidecar，使识别、版面排序与索引各自可恢复。
- PP-OCRv6 检测、识别和字典原本带 SHA-256，PDFium、ONNX Runtime 与版面模型缺少校验值；用户随后明确要求删除全部 OCR SHA-256 校验，不再以此阻止下载。
- 当前 Rust OCR 已具备 PDF 预检、结构化版面、SQLite 任务、Sidecar 原子写入、启动恢复和运行库管理，但尚无页面渲染、ONNX 推理和作业执行器。
- 本轮即使无法安全完成真实模型推理，也应先落地可恢复作业管线、严格的页面引擎接口、缓存隔离和失败页重试；不得把占位实现表述为已完成 OCR 推理。
- 移动端当前被 `app.json` 和 Android Manifest 双重锁定为竖屏，必须同时解除；Manifest 已声明完整的方向与尺寸 `configChanges`，旋转不需要重建 Activity。
- 响应式判定应同时使用方向与短边：短边至少 600dp 才视为平板；典型 `915×412dp` 横屏手机仍走紧凑布局，`1024×600dp` 及更大平板进入双栏。
- 平板横屏 PDF 阅读器采用“左侧文档 + 右侧 300–340dp 工具区”，PDF 继续使用现有容器测量，不给 WebView 或原生 PDF 组件添加随方向变化的 `key`，避免旋转后重建和页码丢失。
- 平板横屏可将 Tabs 移到左侧；手机与平板竖屏保留底部栏。根栈 PDF 阅读器必须处理四边安全区，尤其是 Android 平板左右手势区。
- 论文页 expanded 布局使用两列、large 在单卡仍不小于 340dp 时使用三列；加载、离线和空状态必须占满整行。
- 横竖屏切换必须保持当前页、缓存任务、AI 结果、当前会话和流式停止能力；PDF 文字层重新排版后旧选区应清空，不能继续使用失效坐标。
- OCR 作业执行器采用同一进程内的 `OcrBackend` trait，每次只持有一页输出；原始识别缓存先落到 `cache/ocr/<assetId>`，规范化版面再原子写入 `sidecars/<assetId>`，只有 Sidecar 成功后才提交完成页。
- 单页每次执行最多尝试三次；失败次数累计持久化，但恢复任务会获得新一轮三次尝试，避免失败页永久无法继续。
- 坐标契约已经固定为“裁切区内未旋转像素 → 应用 `/Rotate` 后视觉页 → 左上原点 `[0,1]`”，并覆盖 0、90、180、270 度和越界裁切测试。
- 本轮没有开放 `start_pdf_ocr`，原因是 PDFium 解包和 ONNX 推理后端尚未实现，而不再是 SHA-256 门禁；作业接口仍由 Fake backend 完整测试。
- 用户明确取消 OCR 运行库的 SHA-256 门禁后，下载器改为允许清单内全部资产，只保留 HTTPS 来源、固定文件名、非空文件、HTTP Content-Length 和可选预期大小检查。
- OCR 源文件签名和资产 ID 也从 SHA-256 改为非加密 FNV-1a 64 位指纹；这会让旧 OCR Sidecar 在首次启动时失效并重新生成，但不会修改原 PDF。
- `usable` 现在只表示文件存在且通过基础文件检查，不代表下载内容经过密码学完整性或发布者真实性验证。
- 平板横屏阅读布局已经实装：Tabs 左置，PDF 文档区和 320dp 工具区并排，AI 结果改为右侧抽屉；旋转不会改变 PDF/WebView 的 `key`，只清除已经失效的文字层选择。

## 1.1.14 移动 PDF 沉浸式阅读发现

- 在线阅读器由 Rust 内嵌 PDF.js 页面提供，当前使用 `replaceChildren` 严格只保留单页，并同时关闭自动预取和流式读取。
- 移动 React Native 外层再次按页面宽高比把阅读器完整塞入剩余空间；平板横屏还固定保留 320dp 工具区，形成 PDF 过小和右侧空白的直接原因。
- 桌面端已有全部页面占位、可视窗口前后邻页渲染、滚动判定当前页和 PDF Outline 解析，可迁移行为但不直接复用 React 组件。
- `react-native-pdf` 7.0.4 原生支持纵向连续滚动、单页分页和 `tableContents` 目录回调，离线阅读不需要引入新依赖。
- 现有移动划词、整页翻译和术语解释 HTTP 路由已满足本增量；划词自动模式只需在客户端对稳定选区自动调用现有接口。
- 连续页面后必须把视觉文字流、拖动手柄和选区上下文绑定具体 `.page`，不能继续使用单一全局 `visualMap`。
- PDF 阅读路由位于根级 Stack，不受平板左侧 Tabs 占宽；可直接使用专用全屏 SafeArea 壳层替代通用大标题 `ScreenShell`。
- 用户确认“连续翻译”指桌面端划词翻译模式，不是滚动停止后翻译可见页；译文在平板使用右侧栏、手机使用底栏。
- Windows NSIS 1.1.14 构建成功，安装包 ProductVersion 与 FileVersion 均为 1.1.14，文件大小为 54,210,181 字节。
- Android Release 1.1.14 构建成功，核验 `versionCode 24`、`versionName 1.1.14` 和 APK v2 签名有效，文件大小为 109,508,206 字节。
- `mobile-app/dist/android` 中的 1.1.14 版本化 APK 与稳定 APK 已同步；首次复制因 ACL 拒绝，按权限流程受控重试后成功。
- 按用户要求未计算本次发布产物的 SHA-256；未下载模型、未执行 OCR 推理，也未调用 Ollama。

## 1.1.14 移动 PDF 选区稳定性发现

- 选区端点手柄在 `pointerdown` 时被直接标记为 `moved=true`，因此用户只是轻点手柄，`pointerup` 也会按手指所在位置重新计算端点。
- 手柄可触控区域相对真实字符边界存在明显偏移，现有实现没有记录抓取偏移；首次微小移动会把手柄中心映射到相邻行字符，造成边界跳跃。
- 指针进入邻栏时，现有代码只显示“跨栏内容请分次选择”，仍继续选择原阅读流中距离很远的字符，可能一次扩展到原栏的大段内容。
- 修复应让轻点手柄保持原边界，拖动时扣除抓取偏移，并在邻栏明显更近时冻结最后有效边界。
- 用户截图显示右栏选区从首行开始后跳过数行、又在下方恢复，说明同一栏的段落被贪心阅读流算法拆成多个流，随后错误接回较远段落。
- 选择阅读流需要按稳定水平栏带合并同栏段落，并隔离跨越大部分页面宽度的标题或图表行，保证选区在同栏内逐行连续。
- 新截图中的系统“翻译/复制/分享”菜单与绿色手柄证明问题发生在 Android WebView 原生 Selection，而不是应用自定义蓝色选区。
- 每行最左侧的蓝色虚空块与 PDF.js `br` 换行节点一一对应；当前 CSS 将 `.textLayer br` 纳入通用蓝色 `::selection`，缺少 PDF.js 标准的 `br::selection { background: transparent; }`。
- 原生 Range 依据 PDF 文字层 DOM 顺序扩展，可能在段末把视觉上不连续的下一段纳入；需要复用稳定视觉流归一化原生选区，或将普通选字统一到受控视觉选区。
- 当前宿主把 Viewer 的 `selectionMode` 与“自动划词翻译”开关绑定：自动翻译关闭时退回 Android 原生 Selection，导致两套选区行为不一致。
- v2 Viewer 应始终启用受控视觉选区，“自动划词翻译”只决定收到稳定选区后是否立即请求翻译；普通选择仍使用应用内翻译、解释和复制操作栏。
- 受控选区的 `nearestVisualChar` 当前没有最大命中距离，触摸文字层空白也会吸附到全页最近字符。
- `body.selectionMode .textLayer` 当前使用 `touch-action:none`，且 `pointerdown` 立即 `preventDefault`，会让从正文或空白开始的纵向拖动无法滚页。
- 触屏应延迟到 `pointerup` 再确认轻点选词：移动超过阈值即取消候选并交还原生滚动；空白超过字符命中半径时不创建候选；已有端点手柄继续即时捕获拖动。
- 包含阶段 17 选区修复的新 Android Release APK 已重建，文件大小为 109,508,282 字节；版本化与稳定分发文件均核验为 `versionName 1.1.14`、`versionCode 24`，APK v2 签名有效。

## 阶段 18：移动端 PDF 真机选区回归

- 用户安装阶段 17 的新 APK 后确认问题仍存在且更明显：点击空白会吸附到附近文字，页面无法正常滑动，左栏选区会莫名扩展到右栏。
- 当前 `mergeColumnFlows` 以已有阅读流为聚类单元；如果上游流已经混入左右栏，该算法只能继续合并，无法把污染流拆开。
- 视觉字符映射仍包含空白字符；部分 PDF 的空白字符矩形很宽，空白处也可能得到零距离命中。
- 用户明确否决长按选字，要求保持轻点文字直接选中；触屏命中必须限制在可见字形矩形内，空白距离即使很近也不能吸附，移动超过阈值立即取消候选并交还滚动。
- 最终触屏门禁采用双重约束：事件目标必须是 PDF.js 文字 `span`，且最近字符必须为非空字符并实际覆盖触点；鼠标保留最多 8px 的小范围容错。
- 污染流合成验证表明，输入流同时含左栏、右栏和重复视觉行时，新算法能按视觉行去重并重新拆成左右两栏，跨栏宽行保持独立。
- 移动在线阅读的 Viewer HTML 与选区算法由桌面 Rust 路由 `/api/mobile/v1/pdf-viewer` 提供，不打包在 Android APK 中；只重建 APK 而不更新桌面服务，真机仍会加载旧选区实现。
- Viewer HTML 响应已设置 `cache-control: no-store`，移动 WebView 同时使用 `cacheEnabled={false}` 和 `incognito`，更新并重启桌面服务后不会继续复用旧 Viewer 页面。

## 阶段 19：移动端 Viewer 修订固化

- 用户指出选区过度吸附和跨栏拓展属于移动端问题；此前将服务端分发位置表述成问题归属不准确。
- Bug 的执行环境确实是 Android WebView；当前实现代码由桌面路由下发，但移动 APK 应携带明确的 Viewer 修订和加载门禁，确保移动包输入真实变化并可追踪。
- 新移动端将 Viewer 修订号写入 URL 和 WebView `key`；只有协议 v3 且声明 `strict-glyph-selection` 能力时才启用在线受控选区，旧 Viewer 自动降级离线阅读并提示升级。

## 阶段 20：双栏污染行与跨行连续性

- 用户真机截图显示选区高亮从左栏第一行连续覆盖到右栏同高行，两个端点分处左右栏；同时无法继续选择左栏下一行。
- 这证明污染发生在栏聚类之前：单个视觉 `run` 已横跨左右栏，72% 宽行隔离只能阻止它继续合并，却无法把这个污染行重新拆开。
- 当前文本重建使用 `runId` 判断换行；若为拆栏而细分 `run`，会错误插入换行。应让字符记录视觉 `lineId`，同一视觉行的片段用空格衔接，只有 `lineId` 改变才换行。
- 修复后即使一个输入 `run` 同时包含左右栏字符，也会按字符边缘空隙或字符中心跳变拆成独立片段；片段随后重新聚类到左右栏，同栏不同 `lineId` 仍按垂直顺序连续。

## 阶段 21：空白轻点取消选区

- 用户要求轻点 PDF 空白区域时转移焦点并让当前选区失效，但空白滑动仍必须优先用于滚页。
- 不能在 `pointerdown` 立即清除选区，否则用户从空白区域开始滚动时会误丢失选区；应建立空白轻点候选，在移动阈值内抬起时才清除。
- Viewer 已有 `clearSelection()`，消息协议也允许 `selection.text` 为空，可复用空选区消息同步移动宿主，无需增加 HTTP 路由或协议类型。
- 当前触屏 `pointerdown` 在目标不是文字 `span` 或字形距离不合格时直接返回，因此 Viewer 无法区分“空白轻点”和“从空白开始滚动”。
- 移动宿主收到 `selection` 消息时已经无条件写入 `selectedText` 与 `selectedContext`；只要 Viewer 发送空文本，现有选区操作条会自然消失，自动翻译也不会触发。
- 自定义高亮层设置了 `pointer-events:none`，不会把文字上方的轻点误识别为空白；端点手柄仍由独立分支优先处理。
- `parsePdfViewerMessage` 已保留空字符串选区，适合增加空选区解析回归；移动 Viewer 修订号需要升级为 `strict-glyph-selection-v3`，强制新 APK 建立新 WebView 会话。

## 阶段 22：第七篇论文移动同步

- 移动论文页与聊天 `@` 选择器共用 `fetchMobilePapers()`，请求同一个 `/api/mobile/v1/papers`；若两处都缺最新论文，优先检查服务端列表而不是两个 UI。
- 论文页会直接展示接口返回的全部在线论文，并只在离线或请求失败时追加本地缓存项；当前初步检索未发现页面侧固定显示 6 条的代码证据。
- 确定性根因位于 `load_mobile_papers()`：它读取应用数据目录的 `demo_library.json`，对 Research Memory 和工作区 PDF 都执行 `is_demo_visible_path()` 白名单过滤。
- README 明确记录了该白名单是早期 6 篇比赛演示集的持久化机制；桌面研究库不经过移动过滤，所以会出现“桌面 7 篇、移动 6 篇”的不一致。
- 同一白名单还限制未索引工作区 PDF 进入移动 A+B 创新检索；论文 PDF 下载本身不检查白名单，因此只修列表会留下行为不一致。
- 最小且一致的修复是停止读取和应用演示白名单：移动论文列表返回 Research Memory 与工作区中的全部当前 PDF，创新回退也使用同一全集；保留磁盘上的旧 `demo_library.json` 但不再读取，避免破坏性删除用户数据。
- 用户已明确确认比赛演示结束，允许移动端同步全部工作区，因此移除运行时白名单符合当前产品授权边界。

## 阶段 23：Tencent 2.0 模型中心

- 当前工作树含用户刚修改的模型中心、移动论文页、Markdown、桌面配置和锁文件，必须保留这些改动，不能用旧版本覆盖。
- 当前代码已经出现 `tencent/Hy-MT2-1.8B-GGUF:Q4_K_M`，并在模型中心、桌面默认翻译模型、移动服务默认翻译模型和镜像映射中多点引用；同时仍保留 HY-MT1.5 旧配置迁移分支。
- 能否发布取决于 Tencent 2.0 的真实模型标识和镜像资产是否可被现有 Ollama/GGUF 下载器识别，不能只把字符串从 `1.8B` 改成 `2.0`。
- 受控只读查询 Hugging Face 后确认 Tencent 官方公开代际名称是 `Hy-MT2`，可用仓库包括 `tencent/Hy-MT2-1.8B-GGUF`、`tencent/Hy-MT2-7B-GGUF` 和 `tencent/Hy-MT2-30B-A3B-GGUF`；没有发现名为 `tencent/...2.0...` 的官方仓库。
- 因此当前代码的 `Hy-MT2-1.8B-GGUF` 已经是 Tencent 第二代（HY-MT2）模型，不应猜测改成不存在的 `2.0` 字符串；下一步应确认用户想要的是当前 1.8B 量化版，还是官方 7B/30B-A3B 2 代权重。
- ModelScope 查询接口返回 404，现有模型中心的 Tencent 入口依赖 Hugging Face 与 `hf-mirror.com`，需要继续核对 GGUF 文件树和镜像 URL 是否可直接下载。
- 官方模型卡明确把 Hy-MT2 定义为包含 1.8B、7B 和 30B-A3B 三种规模的第二代多语种翻译模型，官方没有把它命名成 `2.0` 后缀；当前 1.8B GGUF 是合法的 HY-MT2 轻量版。
- 现有模型中心已可发现 Hugging Face translation/gguf 仓库、选取 GGUF 文件、通过 `hf-mirror.com`/ModelScope 候选下载，并在下载后按 Ollama 实际名称回填；从能力上可以承载 HY-MT2。
- 模型中心镜像分支原先在下载成功后直接 `return`，会跳过清空输入框、刷新已安装列表和回填当前模型；已改为成功后跳出候选循环，继续执行统一收尾逻辑。
- 移动服务读取已有 `mobile_chat_settings.json` 时原先只应用 serde 默认值，不会替换旧 HY-MT1.5 字符串；已增加归一化函数并覆盖旧配置迁移测试。
- 本次发布采用官方第二代 HY-MT2 1.8B Q4_K_M 作为默认值；7B 与 30B-A3B 虽然同属第二代，但资源需求明显更高，未擅自替换当前默认模型。

## 阶段 23 下载失败回归

- 用户实际拉取时收到 `modelscope.cn/models/tencent/Hy-MT2-1.8B-GGUF` 的 404，证明该候选地址不能作为 Tencent HY-MT2 来源。
- 国内网络不能依赖 Hugging Face 官方直连；模型中心已删除无效 ModelScope 候选，只使用 `hf-mirror.com` 国内镜像，并附加 `download=true` 避免镜像重定向握手失败。
- 下载器现在会收集全部候选地址的失败原因，不再只显示最后一个失败 URL，便于区分镜像不可达和仓库不存在。
- 用户进一步反馈 `416 Range Not Satisfiable`；原因是临时缓存文件已完整或长度超过远端，服务端拒绝继续使用 Range。下载器现会对 416 自动发起无 Range 的完整下载并覆盖缓存。

## 阶段 25：Ollama GGUF 导入闭环

- Ollama 0.17.7 对旧请求 `{ name, modelfile, stream }` 返回 `neither 'from' or 'files' was specified`，证明 `/api/create` 已不再接受 Modelfile 文本字段。
- 新 API 的 `from` 只接受已有模型名，直接传本地 GGUF 路径会返回 `invalid model name`；若自行使用 `files`，还需要执行 Ollama blob 上传协议。
- `ollama create MODEL -f Modelfile` 可以直接导入本地 GGUF，并由 Ollama 自行完成内容寻址和 manifest 写入，兼容当前 0.17.7。
- 实际导入后模型列表出现 `tencent/Hy-MT2-1.8B-GGUF:Q4_K_M`，格式为 GGUF、family 为 `hunyuan-dense`、参数量 1.8B、量化 Q4_K_M。
- 本地短翻译返回“实验确认该模型已准备就绪。”，加载约 1.86 秒，证明下载、导入、列表识别和推理链路已经真实贯通。

## 阶段 26：模型实时热榜与部署预算筛选

- 用户的感受准确：当前 `RECOMMENDED_MODELS` 是内置静态清单，“检查更新”虽请求远端模型 API，但没有关键词、GGUF 文件大小或部署预算筛选，界面也没有清晰区分静态推荐与实时结果。
- 当前后端元数据查询仍使用 `huggingface.co/api/models`，这与已确认的国内网络条件不符；模型文件下载虽然走 `hf-mirror.com`，模型发现本身仍可能失败。
- 本增量采用简单可解释的保守估算：`GGUF 文件 GiB × 1.2 + 0.8 GiB`，用于快速过滤而不是承诺精确显存占用；实际占用仍受 Context、KV Cache 和 CPU/GPU 分层影响。
- 对 `hf-mirror.com/api/models` 的只读核验表明，热榜响应顶层是模型数组而不是 `{ models: [...] }`；条目直接包含 `id`、`sha`、`downloads`、`likes`、`createdAt` 和 `siblings`。现有包装对象解析是实时推荐不出结果的确定性缺陷。
- 列表响应的 `siblings` 通常没有文件大小，但国内文件树接口 `/api/models/{repo}/tree/{revision}?recursive=true&expand=false` 会返回每个文件的 `path`、`type` 和 `size`，无需访问 Hugging Face 官方站即可完成预算筛选。
- 实时检索按当前任务分类单独执行，默认只抓取当前分类的候选并并发读取文件树，避免一次切换模型中心就请求三个分类的全部仓库。
- 真实 Qwen 热榜中常见文件名为 `Qwen3-4B.Q4_K_M.gguf`，量化标识前使用点号；优先级识别必须同时支持连字符、下划线和点号，否则会错误退化为按文件大小选择 Q2。

## 阶段 27：短段落翻译回归修复

- 当前 `cargo check` 通过，但 `cargo test --lib` 在 `model_discovery_tests::discovered` 测试夹具处失败，原因是新增的 `DiscoveredModel.updated_at` 字段未初始化。
- HY-MT2 生成路径已经在第一次输出失败后使用简化 Prompt 重试；需要补充不依赖 Ollama 的纯逻辑测试，覆盖空输出、外层 JSON 提取和重试结果清洗，避免只依赖一次真实推理记录。
- 本阶段只修复确定性测试缺陷并增强回归覆盖，不改变已确认可用的 HY-MT2 模型标识、镜像下载和默认配置。
- 已补齐 `DiscoveredModel.updated_at` 测试夹具；新增的 4 个翻译输出测试与既有测试合计 62/62 通过。
- Windows NSIS 已在 2026-08-21 重新生成并核验版本为 1.1.15，安装包大小为 54,374,776 字节；构建未下载模型，也未改变用户现有 Ollama 数据。

## 阶段 28：HY-MT2 非忠实译文反馈

- 用户提供的样例不是空返回，而是模型生成了与原文无关的 `Method / Results / Conclusion` 论文摘要结构，说明当前主要风险是非忠实生成而非仅为空。
- `is_translation_generate_model` 分支目前直接调用 `/api/generate`，短段落 Prompt 没有 `<SOURCE>` 边界，也没有明确禁止新增方法、结果、结论或患者信息。
- `looks_like_untranslated_output` 只在译文完全没有 CJK 时拒绝；若输出包含一个中文字符，其余大段英文仍可能被放行。长度检查对约 400 字符以上的选区允许最多 12 倍长度，无法拦截该样例。
- `PdfTranslatePopover` 只展示后端返回的 `translated_text`，没有拼接 `Method / Results / Conclusion`，因此该污染来自模型输出或模型返回内容清洗，不是前端生成。
- 新增校验采用保守规则：长英文原文若译文中文字符极少或译文新增多个摘要结构标记，则判定为可重试失败；正常中文译文和必要英文缩写仍可通过。
- 最终实现将 MT1.5 原始 Prompt 作为所有翻译模型的统一应用层 Prompt；HY-MT2 仅在 `run_translation_model` 中使用 `/api/generate` 适配，不再拥有独立直出 Prompt。
- 选区翻译保留当前页上下文，但明确标记为“仅用于消歧”；输出要求只返回译文正文，禁止扩写、总结、补充患者信息或新增 `Method / Results / Conclusion` 内容。
- 非忠实检测现在覆盖英文主导输出和相对原文新增多个摘要结构标记；检测失败会进入同一 Prompt 的重试路径，避免把 HY-MT2 幻觉结果直接展示给用户。
- 用户反馈样例已加入回归测试；最终 Rust 单元测试 64/64 通过，Windows NSIS 1.1.15 已重新生成。

## 阶段 29：Cloudflare Tunnel 自动启用与 Mobile 地址展示

- 旧代码已经在移动 companion service 初始化后调用 `cloudflared tunnel --url`，但将 `stderr` 设置为 `null`；Cloudflare Quick Tunnel 的公网地址通常打印在 `stderr`，因此 `tunnelUrl` 长期为空。
- 新实现同时消费 `ChildStdout` 和 `ChildStderr`，用带超时的通道读取 URL，避免单独读取某一管道阻塞或漏掉地址；新增 `--no-autoupdate` 防止桌面启动时被 cloudflared 自行更新打断。
- Windows 侧除了 PATH，还探测 `C:\Cloudflared\bin\cloudflared.exe`、Program Files、LOCALAPPDATA 和用户 `.cloudflared` 目录；找不到时保留局域网/Tailscale 地址，不伪造公网地址。
- 桌面 Mobile 区新增明确的“手机配对地址（直接填入）”，优先使用 Cloudflare Tunnel，其次使用非回环局域网/Tailscale 地址；设置页在 Tunnel 异步建立期间自动刷新最多 30 秒。
- Mobile health/status 与共享 contracts 均补充 `tunnelAvailable`、`tunnelUrl` 字段，移动端可继续使用配对响应中的 `baseUrls` 和 `tunnelUrl`。

## 阶段 30：模型选择同步与翻译输出清洗

- 根因不是移动翻译路由忽略设置：路由已经读取 `get_mobile_translation_model`；真正问题是桌面端和移动端各自的配置归一化逻辑把另一个模型强制替换掉。
- 正确策略是保留用户当前选择，只在模型名为空时使用默认模型；因此桌面端选择 HY‑MT1.5 时，`set_mobile_translation_model` 会把同一个完整模型名写入移动设置文件。
- JSON 返回中的 `translation` 字段不能直接返回，否则 `[]` 等标记会绕过统一校验；现在提取字段后与普通文本走同一个 `sanitize_translation_output`。
- 清洗只处理明确的空标记和翻译包装标记的首尾位置，避免误删正文中的正常引用 `[1]`。
- 这轮不改变统一 MT1.5 Prompt 的应用层规则，也不移除 HY‑MT2 推荐项；推荐机制仍可供用户选择，但不会覆盖用户已经选定的模型。

## 阶段 31：翻译标记重复输出修复

- 用户样例中的标记是 `[[TRANSLATION]]`，而旧清洗逻辑只查找 `[[[TRANSLATION]]]`，所以不会进入哨兵后的正文截断分支。
- 模型先输出一次译文、再回显 `[[TRANSLATION]]`、再输出一次译文时，必须以最后一个标记后的内容为准；这不会影响正文中的正常 `[1]` 引用。
- 旧缓存可能绕过新清洗逻辑，因此选区和整页翻译缓存键同步升级，避免历史错误译文继续显示。

## 阶段 32：移动端段尾选区与空译文重试修复

- 当前移动 Viewer 的自定义选区已包含最后一个字符，但触控首次命中要求距离字形矩形不超过 1px，手指落在段尾字形边缘时容易被判定为空白。
- 将触控容差收敛到 3–6px，并继续保留文字 `span`、非空字符和空白滚动门禁，避免恢复此前的空白吸附问题。
- 截图中的“模型返回了空翻译”不是选区文本为空，而是模型第一次响应为空且第二次仍复用带页面上下文的 Prompt；第二次重试现改为短 Prompt 和明确 `<SOURCE>` 边界。

## 阶段 33：桌面端 PDF 选区视觉偏移

- 桌面端选区弹窗文本来自稳定 Range.toString()，视觉黄色高亮却来自 Range.getClientRects()；PDF.js 文字层中的绝对定位和 transform 会让部分选中的 span 返回整段矩形，因此可能出现高亮包含末尾字形而弹窗少一个字符。
- clampSelectionRangesToBlankLine 会在拖动结束和预览过程中重写 Range 终点，进一步放大视觉区域和实际文本不一致的风险。
- 桌面页面还有 previewScale 临时 transform；虽然 canvas 与文字层通常一起缩放，但它会让选区、注释比例和页面布局在重绘窗口期间依赖额外坐标系。
- 本阶段应让高亮矩形按实际选中的文本字符计算，并移除不必要的临时页面缩放；翻译、复制、解释和注释均继续复用同一份稳定 Range 文本。

## 阶段 34：桌面端 PDF 选区回退

- 上一版字符级矩形实现的 `compareBoundaryPoints` 过滤不适合桌面 WebView 中可能正在重绘的 PDF.js Range。
- 选区视觉层必须具备原始 `Range.getClientRects()` 回退；即使字符级几何不可用，也必须保留复制、翻译和解释所依赖的稳定 Range。

## 阶段 35：移动端段首段尾选区连续性修复

- 用户最新反馈为移动端 PDF 段落首末选择异常，表现为选区高亮在视觉段之间断裂，首尾手柄与文字边界不一致。
- 当前 `mergeColumnFlows` 对宽度达到页面 72% 的每个 run 直接创建独立 flow；单栏正文的长行通常满足该条件，导致同一段落被拆散。
- 当前 `updateLinearSelectionFromPointer` 在触摸跨 `runId` 时把终点钳回锚点 run 的首尾，导致跨行拖选不能落在真实目标字符。
- 修复必须允许同一阅读流跨行、跨 run 连续选择，同时继续把真正不同栏的目标冻结并提示分次选择。

- 已将宽行独立 flow 的条件收紧为“页面存在两组有足够行数且水平分离的窄栏”；单栏正文宽行会加入同一阅读流。
- 已移除同一 flow 内触摸跨 run 的锚点 run 钳回；跨栏仍由 `crossFlow` 检测冻结并提示分次选择。
- 首尾手柄现在记录自身实际锚点坐标，拖动偏移不再使用字符中心；单词扩展按视觉行和字符间距连续判断。
- Rust 静态 Viewer 回归断言、Rust 70/70、移动 PDF 7/7、两端 TypeScript、格式、版本、冲突和差异检查均通过。
- 因内嵌 Viewer 行为发生变化，移动端内部修订号已从 v3 升为 v4；应用版本仍保持 `1.1.18`。

## 阶段 36：移动端段落边界与跨样式选区修复

- 用户截图显示长选区会跳过行首的小标题、粗体和斜体片段，只高亮其后的正文；从这些样式片段起选时也无法自然向后拖动。
- 当前触屏入口在视觉字形命中计算前仍要求事件目标属于 `.textLayer span`；段首段尾触点落在 span 边缘或文字层空隙时会被提前标记为空白，即使最近字形仍在允许容差内。
- 同一视觉行被拆成多个 run 后，样式片段与后续正文可能进入不同 flow；选区因此只保留正文 flow，产生截图中的高亮缺口。
- 修复需要以视觉行连续性连接单栏跨样式 run，同时继续依靠足够的重复左右栏证据隔离真正双栏。
- 单栏页面统一为一个视觉阅读流后，小标题、粗体、斜体和正文不再因 PDF.js 的样式 run 拆分而形成高亮缺口；字符仍按 `top/left` 视觉顺序排列。
- 双栏识别只统计页面宽度 18%–62% 的中等宽度 run，每个候选栏至少需要四行支持，左右栏还需满足水平间距及共享视觉行或垂直重叠证据。
- 触屏入口现在先构建视觉字形图，再以 3–6px 最近字形门禁区分文字与空白；因此段首段尾的 span 边缘可以命中，同时空白轻点清除和空白滑动滚页仍保持原行为。
- 曾尝试的跨 flow `selectionSequence` 会把末端 flow 的字符索引错误应用到首 flow，现已完整移除；单栏统一 flow 从数据结构上消除了这类端点索引错位。
- 最终 APK 的 React Native Bundle 已直接确认包含 `strict-glyph-selection-v5`，排除了 Gradle 或 Metro 复用旧 Viewer 缓存的可能。
