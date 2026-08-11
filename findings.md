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
