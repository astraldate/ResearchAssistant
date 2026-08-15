# 审计进度记录

## 会话：2026-08-13 · Rust 应用级 OCR 与长期稳定化

- **状态：** 进行中
- 用户批准用 Rust 重建应用级 OCR，并明确不依赖 Python、不覆盖原 PDF。
- 已确认核心产物改为版面 Sidecar，桌面与移动阅读器直接渲染 Token 选择层。
- 已确认图表文字隔离但可选，图注进入 Research Memory，OCR 仅处理诊断问题页。
- 已确认 OCR 运行库与模型首次使用下载并校验，便携备份必须密码加密。
- 已恢复未提交工作区并完成实施前核验：移动端类型检查和 Rust 编译通过，但 Rust 格式检查发现一处差异；现有 OCR 文件尚未接入模块树，未参与编译和测试。
- 已确认聊天取消仍缺少请求 ID 严格校验、活动 ID 冲突处理和错误退出统一持久化。
- 已完成聊天取消请求 ID 校验、提前取消、活动 ID 冲突、注册表清理、断线中断和统一错误终态；移动端取消确认失败会明确告警并刷新权威会话。
- 已新增 OCR 模块入口和 Tauri 命令，接入启动初始化、运行任务恢复、源文件失效标记与安全运行库管理；首轮 Rust、Web 与移动端编译检查通过。
- 第一轮编译确认 OCR 文件已经进入模块树；当前仅有真实推理尚未使用的预留函数产生 `dead_code` 警告。
- Rust 首轮全库测试实际运行 41 项，其中 15 项来自 OCR；40 项通过，跨栏标题测试因夹具把标题标签固定成 `text` 而失败，实现逻辑未收到标题语义。
- 已修正测试夹具，并补充取消注册表清理、恢复任务保留已完成/失败页、源文件变化标记过期测试；OCR 模块对真实推理阶段的预留接口集中声明允许未使用。
- 最终门禁通过：Rust 格式检查与编译无警告，Rust 全库测试 43/43（其中 OCR 16 项），Web 与移动端 TypeScript、移动聊天组合器 2/2、冲突标记、Prettier 和 `git diff --check` 全部通过。
- 本增量已完成：聊天中断与异常恢复闭环、OCR 基础模块接线、Tauri 管理接口、启动任务恢复和无模型测试。
- 阶段 15 后续：实现真实问题页 OCR 推理和 Research Memory 接入，再继续桌面/移动 UI、区域选字与密码加密备份。

## 会话：2026-08-10

### 阶段 5：共享协议与后端服务

- **状态：** 进行中
- 已完成：确认执行类型，恢复规划文件，核对工作树仅有既有审计文档未跟踪。
- 下一步：并行实现 Rust 公共 PDF AI、移动协议、创新分析和 Android 前端交互。

### 阶段 1：范围与基线确认

- **状态：** 完成
- 已完成：读取仓库根目录、README、根 package.json，以及持久化规划规范。
- 已创建文件：task_plan.md、findings.md、progress.md。

### 阶段 2：代码与配置审查

- **状态：** 完成
- 已完成：读取受版本控制文件清单、Rust 与移动端依赖清单，以及三条 GitHub Actions 工作流。
- 初步结论：自动化质量门覆盖类型检查与构建，但未发现测试、Lint、依赖漏洞扫描或工作流 Action SHA 固定。
- 已完成：审查移动服务路由、配对与授权、持久化、附件写入、Android 签名与网络配置、Tauri 权限和前端渲染路径。

### 阶段 3：验证与风险核验

- **状态：** 进行中
- 通过：pnpm typecheck、pnpm --dir mobile-app typecheck、pnpm check:conflicts、cargo fmt --manifest-path src-tauri/Cargo.toml -- --check。
- 未完成：pnpm audit 因 npm 镜像访问 EACCES 超时；cargo test 在 60 秒编译期内超时；pnpm build 因 dist/app-icon.png 无法删除而失败。
- 下一步：运行 CI 同等 Rust cargo check 并整理风险分级。

### 阶段 4：报告编写与复核

- **状态：** 完成
- 已完成：CI 同等的 cargo check 通过；编写审计报告，列出 3 项高风险、4 项中风险和 1 项低风险，以及可验证的整改标准。
- 已完成：核对报告章节、风险证据定位、文件改动范围和中文表述；所有本次新增文件均未跟踪，未修改业务源码或项目配置。

## 验证结果

| 检查项         | 命令或方法                                                           | 结果                         | 状态   |
| -------------- | -------------------------------------------------------------------- | ---------------------------- | ------ |
| 基线识别       | 根目录与核心文档检查                                                 | 已识别多端 monorepo 技术栈   | 通过   |
| Web 类型检查   | pnpm typecheck                                                       | 通过                         | 通过   |
| 移动端类型检查 | pnpm --dir mobile-app typecheck                                      | 通过                         | 通过   |
| 冲突标记检查   | pnpm check:conflicts                                                 | 通过                         | 通过   |
| Rust 格式检查  | cargo fmt --manifest-path src-tauri/Cargo.toml -- --check            | 通过                         | 通过   |
| Web 构建       | pnpm build                                                           | dist/app-icon.png 删除被拒绝 | 未通过 |
| Rust 单元测试  | cargo test --manifest-path src-tauri/Cargo.toml --lib --no-fail-fast | 60 秒内仍在编译              | 未完成 |
| npm 漏洞审计   | pnpm audit --prod --audit-level=high                                 | npm 镜像请求 EACCES 后超时   | 未完成 |

## 错误记录

| 时间     | 错误                      | 次数 | 处理方式                     |
| -------- | ------------------------- | ---: | ---------------------------- |
| 本次会话 | pnpm audit 超时           |    1 | 不重复请求，记录环境限制     |
| 本次会话 | cargo test 编译超时       |    1 | 改用 CI 同等 cargo check     |
| 本次会话 | pnpm build 清理 dist 失败 |    1 | 保留现有构建目录，未执行删除 |

### 阶段 5：共享协议与后端服务

- **状态：** 完成
- 已完成 PDF AI 共享服务、移动 v2 协议字段、受控 PDF 来源解析、模型队列、PDF.js 本地资源路由和知识卡片保存。
- 已完成创新意图预检、双路 Research Memory 检索、论文去重与相关性判定、`sources` 流事件和引用持久化。

### 阶段 6：移动端交互

- **状态：** 完成
- 已完成 A/B 可编辑确认卡、证据卡片及 PDF 页跳转。
- 已完成在线 WebView 原位划词、离线原生阅读回退、三项 PDF AI 操作和结果底部面板。

### 阶段 7：测试、构建与复核

- **状态：** 完成
- 依赖安装及锁文件更新已完成；Web 与移动端 TypeScript 检查、Prettier、冲突标记检查全部通过。
- Rust `cargo fmt --check`、`cargo check` 和 12 项单元测试全部通过。
- Web 默认输出目录因既有 `dist/app-icon.png` 被外部进程占用而无法清理；改用独立临时输出目录完成同等 Vite 生产构建并清理临时产物。
- Android debug 与签名 release APK 均构建成功；自动链接清单确认包含 `react-native-webview`、`react-native-pdf` 和 `react-native-blob-util`。

## 本轮最终验证

| 检查项                   | 结果                       |
| ------------------------ | -------------------------- |
| Web TypeScript           | 通过                       |
| 移动端 TypeScript        | 通过                       |
| Prettier                 | 通过                       |
| 冲突标记                 | 通过                       |
| Rust 格式与检查          | 通过                       |
| Rust 单元测试            | 12/12 通过                 |
| Vite 生产构建            | 通过，使用独立临时输出目录 |
| Android debug APK        | 通过                       |
| Android 签名 release APK | 通过                       |

### 阶段 8：自然选字、创新图谱与演示交付

- **状态：** 完成
- PDF.js 阅读页改用视觉阅读流：点击“选字”后直接拖动，连续行高亮，首尾手柄可微调，跨栏时钳制并提示分次选择。
- A+B 每侧最多保留两篇不同论文；未索引的 6 篇演示 PDF 可在标题明确匹配后读取真实首页文字作为受限证据。
- 有本地证据的 A+B 回答自动写入 Idea Map；Paper 节点通过 `[A1]/[B1]` 等 `supports_idea` 边指向创新点。
- 移动会话新增 `/ask`、`/method`、`/exp`、`/claim`、`/brief`、`/innovation` 选择器，以及结构化 `@` 论文范围。
- 手机助手消息新增创新点卡片，显示 A × B、证据覆盖状态及从回答第 5 节提取的创新假设。
- 按用户明确授权，永久删除工作区 114 篇 PDF，释放 670.04 MiB；保留名单复核为 6/6，未删除卡片、会话和数据库。
- 版本升级至 1.1.8；桌面 NSIS、Android release APK 均已构建并校验版本、哈希和 APK v2 签名。

## 1.1.8 最终验证

| 检查项                | 结果              |
| --------------------- | ----------------- |
| Web TypeScript        | 通过              |
| 移动端 TypeScript     | 通过              |
| Prettier              | 通过              |
| Rust 格式与检查       | 通过              |
| Rust 单元测试         | 17/17 通过        |
| PDF.js 内嵌脚本语法   | 通过              |
| Vite 生产构建         | 通过              |
| Windows NSIS 1.1.8    | 通过              |
| Android release 1.1.8 | 通过，v2 签名有效 |

### 阶段 9：移动端导航与资料库整合

- **状态：** 进行中
- 已完成：将聊天页重排为消息独立滚动和底部输入 Dock；`/`、`@` 菜单改为 Dock 上方的高层级可滚动浮层。
- 已完成：确认底部现有六个 Tab，以及采集、卡片库、复习三个页面的职责与合并边界。
- 进行中：核对桌面笔记与卡片同步、删除接口和本地缓存一致性，再实施顶部页内切换。
- 已完成：共享协议新增可选笔记记录；bootstrap 同步笔记正文时剥离 frontmatter 和桌面绝对路径。
- 已完成：桌面新增按受控 ID 删除知识卡片与论文笔记的认证路由；删除卡片同时清理复习记录，并忽略已删除卡片的遗留评分事件。
- 已完成：移动 SQLite 新增笔记缓存和卡片/笔记单项清理；全量同步改为替换复习记录，避免孤儿数据。
- 已完成：底部导航精简为知识、论文、聊天、设置；聊天聚合采集，知识页聚合卡片、笔记与复习，旧路由保留兼容重定向。
- 下一步：格式化并修复类型/编译问题，补充测试与 1.1.9 桌面、Android 构建。
- 验证通过：本轮 TypeScript 文件 Prettier、移动端 TypeScript、Web TypeScript 与 Rust 格式检查均通过。
- Rust 首次编译检查失败：`list_paper_note_drafts_shared` 遗留 Tauri command 属性，已定点移除并记录，未重复原错误路径。
- 修正后 Rust 格式检查与 `cargo check` 通过。
- 新增路径脱敏测试后，Rust 格式门提示单行测试字符串需换行；已应用标准格式化，未涉及逻辑变更。
- 验证通过：移动与 Web TypeScript、Rust 格式检查，以及 Rust 单元测试 18/18。
- 已更新 README 与 Design Specification，记录四 Tab 信息架构、笔记同步、权威删除、路径脱敏和输入 Dock 层级。
- 版本已统一升级至 1.1.9；下一步执行 Web、Windows NSIS 与 Android release 构建。
- 构建通过：Vite 生产构建、Windows NSIS 1.1.9、Android release 1.1.9。
- Android 核验通过：`versionCode 19`、`versionName 1.1.9`、APK v2 签名有效。
- 桌面 1.1.9 已静默升级并重新启动；健康检查正常，真实 bootstrap 返回 10 张卡片、0 篇现有笔记，Markdown 路径泄漏计数为 0；不存在笔记的删除路由返回预期 404，证明路由已挂载且未删除真实资料。
- 当前没有连接 ADB 设备，因此未自动安装 APK；稳定命名 APK 已更新，可供真机安装。

## 1.1.9 最终验证

| 检查项                       | 结果                   |
| ---------------------------- | ---------------------- |
| Prettier 与冲突标记          | 通过                   |
| Web TypeScript               | 通过                   |
| 移动端 TypeScript            | 通过                   |
| Rust 格式与编译              | 通过                   |
| Rust 单元测试                | 18/18 通过             |
| Vite 生产构建                | 通过                   |
| Windows NSIS 1.1.9           | 通过并已安装启动       |
| Android release 1.1.9        | 通过，APK v2 签名有效  |
| Companion bootstrap 冒烟测试 | 通过，路径脱敏计数为 0 |

- planning-with-files 自带完成检查器只识别英文阶段格式，对本仓库强制中文计划报告 0/0；实际九个阶段均已标记完成，最终验证表已填写。

### 阶段 10：移动端输入、解释编码与创新展示修复

- **状态：** 完成
- 已完成：恢复 1.1.9 实施状态，定位 `/`、`@` 仅生成外部 chip 的直接原因。
- 已完成：确认解释乱码来自 PDF 页面文本中的 Unicode 替换字符，当前链路未做质量过滤。
- 已完成：确认聊天正文仍使用普通 `Text`，创新结果只嵌在长消息下方，缺少独立发现入口。
- 下一步：核对设置页文案、可用 Markdown 依赖和创新数据来源，完成 UI 方案后实施。
- UI 审视完成：确定聊天顶部改为“会话 / 创新 / 采集”，创新页包含 A/B 输入与当前会话历史；Markdown 使用原生受控渲染；设置页新增“数据与 AI”声明。
- 已确定解释上下文采用“PDF.js 选区周边优先 + Rust 提取回退质量门禁”的双路方案。
- 已完成协议走查：WebView `selection` 事件和解释请求均可增加可选 `context` 字段，旧客户端省略该字段仍可兼容。
- 已确认创新历史可直接从当前会话带 `innovationAnalysis` 的助手消息恢复，无需新建服务端数据模型。
- 已确定 Markdown 首批接入点：聊天助手回答、PDF AI 抽屉、卡片与笔记详情、复习卡片背面；用户消息继续使用纯文本。
- 已完成输入修复的兼容设计：可见 Token 保留在输入值中，发送前剥离，结构化 `command` 与 `paperContext` 继续作为唯一协议语义。
- 已新增受控的纯 React Native Markdown 渲染组件，并接入 PDF AI、卡片详情、笔记详情与复习背面。
- 正在重构聊天页：增加输入引用、可见 Token 同步和“创新”页内视图。
- 已完成聊天页主体修改：“会话 / 创新 / 采集”入口已落地，创新页可输入 A/B 概念并浏览当前会话历史结果；助手回答开始使用 Markdown 渲染。
- 已扩展 PDF 解释协议和桌面服务：解释请求增加可选 Context，缓存升级为 `explain-v2`，桌面回退文本经过替换字符与控制字符质量门禁。
- 已完成 PDF.js → React Native → Rust 的 Context 透传，并补充乱码清洗与阅读页消息协议测试。
- 第一轮验证通过：移动端 TypeScript 与 Rust `cargo check` 均无错误；已修复 Markdown 组件字体常量的首次类型检查错误。
- 已完成 README 与 Design Specification 的变更点定位；文档将补充三段式聊天入口、输入栏 Token、移动 Markdown 和 PDF Context 质量门禁。
- 版本已统一升级至 1.1.10，Android `versionCode` 升至 20；README 与 Design Specification 已更新。
- 核心门禁通过：Web TypeScript、移动端 TypeScript、Rust 单元测试 20/20；新增两项 PDF Context 乱码测试均通过。
- 复核输入区后移除输入框外的重复 Context chip；`/command` 与 `@「论文标题」` 现在只在真实输入值中显示，手动删除会同步清除结构化选择。
- 已检查仓库冲突标记与版本残留；未发现冲突标记，Cargo.lock 中剩余的 `1.1.9` 均为第三方 crate 版本，不是应用版本。
- 构建前门禁通过：Prettier、Rust 格式、移动端 TypeScript 和 Vite 1.1.10 生产构建全部成功；Vite 仅报告既有的大分块与 PDF.js eval 警告。
- 下一步：构建 Windows NSIS 1.1.10 与 Android release 1.1.10，并核验版本、签名和哈希。
- Windows NSIS 与 Android release 均构建成功；桌面安装包 ProductVersion/FileVersion 均为 1.1.10。
- Android 正式 APK 核验通过：`versionCode 20`、`versionName 1.1.10`、APK v2 签名有效；稳定文件和版本化文件哈希一致。
- 桌面 1.1.10 已静默升级并重新启动；安装文件版本为 1.1.10，companion service 健康检查正常。
- 最终差异检查与冲突标记检查通过；当前没有连接 ADB 设备，因此未自动安装 APK 到真机。

## 1.1.10 最终验证

| 检查项                 | 结果                                  |
| ---------------------- | ------------------------------------- |
| Prettier 与冲突标记    | 通过                                  |
| Web TypeScript         | 通过                                  |
| 移动端 TypeScript      | 通过                                  |
| Rust 格式与编译        | 通过                                  |
| Rust 单元测试          | 20/20 通过                            |
| Vite 生产构建          | 通过                                  |
| Windows NSIS 1.1.10    | 通过并已安装启动                      |
| Android release 1.1.10 | 通过，versionCode 20，APK v2 签名有效 |
| Companion 健康检查     | 通过，协议 `2026-08-10.v2`            |

### 阶段 11：移动编辑能力与创新删除

- **状态：** 进行中
- 已恢复 1.1.10 实施状态并完成第一轮根因定位。
- 已确认光标问题来自输入选择区未持久化；移动创建/编辑能力可以复用桌面已有受控文件操作，但必须新增移动认证路由。
- 已确认创新删除需要同时处理 Research Memory Idea、支持边与移动会话结构化字段；证据乱码需要在引用映射链路单独清洗。
- 已完成卡片与笔记桌面能力复用点走查：卡片可按 ID 受控更新，笔记需抽取共享创建/更新函数。
- 已定位引用乱码映射点 `map_mobile_citation` 与 `map_mobile_idea_evidence`，两处将统一使用清洗后的 snippet。
- 已确定卡片/笔记创建编辑请求只包含 title、Markdown body 和可选 term；服务端内部重新定位 ID 与文件路径。
- 已确定创新删除语义：删除结构化创新结果和 Idea Map 节点/边，保留聊天正文作为会话记录，并在确认框中明确说明。
- 已确认会话线程具有统一读写入口，开始补充卡片/笔记写接口和两类创新删除接口。
- 已确定创新分析与 Idea Map 节点采用独立删除语义；下一步实现事务删除、会话回写和移动 API。
- 已完成卡片手动创建与卡片术语更新能力的桌面共享服务骨架，开始接入移动认证路由。
- 已加入卡片/笔记创建编辑路由，以及创新分析和 Idea Map 两类删除路由骨架。
- 已补齐卡片与笔记的服务端校验、创建、编辑和统一响应映射；正在实现创新删除处理器。
- Rust 首轮格式门禁发现 4 处仅格式差异，已执行 `cargo fmt` 自动修正；未发现业务逻辑错误。
- 已实现 Idea 数据库事务删除、来源会话 `ideaId` 清除、创新分析消息删除和引用乱码服务端降级。
- Rust `cargo check` 已通过；开始修改移动端 API、输入光标语义和创新结果操作区。
- 已扩展共享 TypeScript 协议与移动 API 客户端，卡片/笔记支持 POST/PATCH，下一步接入知识编辑器。
- 已将聊天快捷键改为按 `TextInput` 当前选区插入，并以 caret 左侧触发区间替换命令或论文 Token。
- 已接入创新历史卡的“删除分析”和“从 Idea Map 删除”独立操作，并在删除后刷新桌面权威会话状态。
- 已新增统一知识编辑抽屉，卡片与笔记均支持 Markdown 编辑/预览、必填校验和未保存退出确认。
- 已在知识页加入“新建卡片/笔记”和详情“编辑”入口，保存采用桌面成功后重新 bootstrap 的权威同步流程。
- 一次样式补丁因上下文中误判了重复 `label` 而未应用；复查实际文件后已用准确上下文补齐，无代码丢失。
- 移动 TypeScript 首轮检查发现创新操作按钮引用了不存在的 `palette.paper`，已改用现有 `palette.panel`。
- 移动 TypeScript 复检通过。
- README、Design Specification 与实施计划已补充光标语义、移动创建编辑、两类创新删除和引用乱码降级。
- 首次统一版本补丁发现根桌面版本文件已先更新为 1.1.11，导致整块上下文未命中；复查后仅更新仍为旧值的移动文件，当前桌面/移动版本已统一为 1.1.11，Android `versionCode` 为 21。
- 已定位 Rust 移动协议测试模块，准备补充引用 snippet 质量门禁回归测试。
- 已新增引用乱码回归测试，覆盖正常中英文与希腊字符、Unicode 替换字符、NUL 和典型 mojibake。
- 全量 Prettier 首轮仅发现三个项目管理 Markdown 文件格式差异，已自动格式化修正；并行检查因该失败提前收敛，后续检查改为分别执行以保留完整输出。
- 移动 TypeScript 与桌面 Web 1.1.11 生产构建通过；Vite 仅保留既有 PDF.js eval 和大分块警告。
- Rust 格式检查与完整测试通过，21/21 测试成功；新增引用乱码测试已纳入门禁。
- `git diff --check` 通过，工作区仅包含本轮及前序用户授权的实施改动。
- Windows NSIS 1.1.11 正式安装包构建成功。
- Android release 1.1.11 构建成功；Gradle 仅报告既有弃用提示。
- 已确认源 APK 与 Windows 安装包存在，准备复制分发文件并核验版本、签名和哈希。
- 首次复制 APK 到受保护的分发目录被 ACL 拒绝；按权限流程受控重试后成功更新稳定文件与 1.1.11 版本化文件。
- Android APK 核验通过：`versionCode 21`、`versionName 1.1.11`、APK v2 签名有效；稳定文件与版本化文件 SHA-256 均为 `1D8B520CDEF01CD948733C0B89F8140A1E6D125B21C33A828E3076B676CF2570`。
- Windows NSIS 安装包 SHA-256 为 `19AD0524AD33EC63D2B534A19584ECDA2C588E9D729462F130F419FE5554A941`。
- 一次 `rg` 检索因 PowerShell 正则引号被截断而失败，已改用固定字符串检索继续，不影响源码。
- 桌面端已静默升级并启动 1.1.11；安装文件 ProductVersion/FileVersion 均为 1.1.11，companion health 返回 running=true 与协议 `2026-08-10.v2`。
- 已对安装后的 `/cards` POST 与 `/ideas/{id}` DELETE 做无 Token 探测，均返回 401 而非 404，确认新路由已经由 1.1.11 companion service 加载。
- 当前没有连接 ADB 设备，因此未自动把 APK 安装到真机。

## 1.1.11 最终验证

| 检查项                    | 结果                                  |
| ------------------------- | ------------------------------------- |
| Prettier 与差异空白检查   | 通过                                  |
| Web TypeScript 与生产构建 | 通过                                  |
| 移动端 TypeScript         | 通过                                  |
| Rust 格式、编译与测试     | 21/21 通过                            |
| Windows NSIS 1.1.11       | 通过并已安装启动                      |
| Android release 1.1.11    | 通过，versionCode 21，APK v2 签名有效 |
| Companion health          | 通过，协议 `2026-08-10.v2`            |

### 阶段 11：移动编辑能力与创新删除

- **状态：** 完成

### 阶段 12：快捷命令与 PDF AI 降级一致性修复

- **状态：** 进行中
- 已记录真机问题：`/brief + @论文` 在正文为空时被通用校验阻止；桌面划词翻译因 ToUnicode CMap 解析失败直接终止；移动术语解释看起来只展示页面 Context，缺少清晰的模型总结层。
- 已启动移动 UI 只读审视，后端优先核对共享 PDF AI 服务和提取失败边界。
- 已定位桌面 ToUnicode 错误的致命传播点：划词翻译错误地强依赖整页文本提取。
- 已确认移动解释协议收到 `plainSummary`，当前主要存在内容层级不清和模型失败降级语义不足两个问题。
- 已确认桌面 UI 的标准呈现为三层：来源状态、模型通俗解释、参考资料摘要；移动端将按同一层级重排。
- 已实现动作型快捷命令的受控默认问题和具体缺失项提示，并增加“可直接发送”引导文案。
- 已修改共享术语解释服务：模型独立解释与 5 秒限时百科查询并行；解释缓存升级为 v3。
- 已修改划词翻译：整页 Context 提取失败时记录降级并继续翻译已选文字，不再传播 ToUnicode 错误。
- Rust 首轮检查发现新百科超时分支缺少 `Duration` 导入；已改用完整 `std::time::Duration` 路径，避免扩大模块级导入。
- 已新增移动专用结构化术语解释组件，并加入模型/百科状态、页面原文引用、生成信息与错误重试。
- 已修正解释提示词边界：模型先用稳定领域知识解释概念，再联系页面 Context；仅禁止虚构论文特定实验、数字和结论。
- 已增加 ToUnicode 提取失败降级单元测试，确保划词原文存在时 Context 错误不会阻断翻译。
- 已抽取移动快捷命令默认语义为纯函数并新增 Node 原生测试，2/2 通过；仅出现 package 未声明 ESM 的性能提示，不影响结果。
- 一次版本残留 `rg` 因 PowerShell 双引号转义导致正则被截断；已停止复用该写法，后续改用多个固定字符串模式。
- README 与 Design Specification 已记录快捷命令默认语义、ToUnicode 降级、模型/百科并行与解释内容分层；版本开始升级到 1.1.12，Android `versionCode` 为 22。
- 固定字符串版本检索因“无 versionCode 21 命中”返回退出码 1；复查输出确认仅剩第三方 crate 版本，不是应用版本残留。
- 1.1.12 全量门禁首轮发现两项配置/格式问题：Node 原生 TypeScript 测试使用 `.ts` 扩展但移动 tsconfig 未允许，Rust 新测试不符合 rustfmt 自动换行；已启用仅在 `noEmit` 下生效的 `allowImportingTsExtensions`，并执行标准 Rust 格式化。
- 修正后移动 TypeScript、快捷命令测试 2/2、Rust 格式与 `cargo check` 全部通过；Node 仅保留无功能影响的 ESM 重解析性能提示。
- Web 1.1.12 生产构建通过；Vite 仅保留既有 PDF.js eval 与大分块提示。
- 版本与差异空白检查通过，桌面和移动版本已统一为 1.1.12，Android `versionCode` 为 22。
- Windows NSIS 1.1.12 正式安装包构建成功。
- Android release 1.1.12 构建成功；Gradle 仅报告既有弃用提示。
- 覆盖受保护 APK 分发目录时，环境自动授权额度耗尽，系统拒绝操作；遵循安全要求未尝试绕过。已安装桌面端同样无法在本轮自动静默升级，需要手动运行 1.1.12 安装包。
- 构建目录 APK 核验通过：`versionCode 22`、`versionName 1.1.12`、APK v2 签名有效，SHA-256 为 `0D35DE7F70C4CBA45C991F031E4F2376133152CD78B0CC9FB86E4484E13AECB3`。
- Windows NSIS 1.1.12 SHA-256 为 `F1C3993ECD4F3D5B7EBD1AC96708AB06EE3D0FBB1A86BEBF430BE543508CDC91`。

### 阶段 13：发布文档、CI/CD 与 Git 标签交付

- **状态：** 进行中
- 已恢复项目计划并确认当前分支为 `main`、远端为 `origin`，现有最高版本标签为 `v1.1.6`。
- 已确认此前 1.1.12 功能、文档和版本改动均已暂存，未发现未暂存文件；提交前仍将按差异范围复核，避免误纳入无关内容。
- 已定位 CI/CD 的主要补强点：版本一致性门禁、Rust 格式与测试、移动快捷命令测试、Web/移动并行检查、任务超时和最小权限。
- 已完成三条工作流的逐项审查；确认手动 Android 发布必须改为检出输入标签，标签发布需在构建前校验仓库内全部版本字段。
- 已决定保留 Android 对桌面发布任务的依赖，以确保 draft release 先由桌面任务创建；常规 CI 将拆成三路并发任务缩短反馈时间。
- 通过浏览工具读取 GitHub Action tag 引用时被 URL 安全策略拒绝；已停止该路径，后续使用 Git 官方引用查询获取不可变提交哈希。
- 沙箱内首次执行 `git ls-remote` 因网络隔离失败；按权限流程执行只读远端查询后成功取得 9 个 Action 的官方引用提交，未使用记忆值或第三方来源。
- 版本字段复核发现共享协议包仍停留在 1.1.5；将随统一版本脚本一起修正为 1.1.12。
- 已确认 Android Gradle 可读取受忽略的 `keystore.properties`，发布工作流将支持 GitHub Secrets 正式签名并清楚区分测试签名降级。
- 用户明确要求保持 MVP 节奏；已移除 CI 中重复的 Web typecheck 和 Rust 全目标测试，Web 构建自身负责 TypeScript 编译，Rust 仅执行格式门禁与库测试。
- 标签发布改为轻量任务先创建 draft release，随后 Windows 与 Android 两个构建任务并行上传，不再让 Android 等待完整桌面构建。
- 一次跨文件补丁因任务计划 Markdown 表格空格上下文未命中；已拆分为小补丁后完成，没有产生部分修改。
- 用户确认项目用于比赛展示，不需要上架准备；已移除 CI/CD 中的正式 keystore Secrets 分支，Android 固定生成测试签名 `-demo.apk`。
- README、Design Specification 与 CHANGELOG 已补充 1.1.12 功能、MVP 快速门禁、并行 draft 发布、标签一致性和演示包边界。
- 快速门禁通过：统一版本与 `v1.1.12` 标签校验、冲突标记、Web TypeScript、移动 TypeScript、移动快捷命令测试 2/2。
- 复核 Git 历史确认此前完整产品改动已经由 `fc096d5 chore: release v1.1.12` 提交；当前工作区只剩本轮 CI/CD、文档、版本脚本和计划记录，适合单独提交。
- 已创建 `7efe639 ci: 优化比赛演示发布流程`，并成功推送 `main` 与新标签 `v1.1.12`；推送前 Git hooks 的冲突检查、Prettier、双端 TypeScript 和本地缓存 Rust 检查均通过。
- GitHub Rust 任务暴露 Tauri PDF.js 资源前置条件：纯 Cargo 环境没有根 `node_modules` 时 build script 会失败。已定点增加 pnpm `--ignore-scripts` 资源恢复步骤，不重复原生安装或发布构建。
- CI 热修的跨文件补丁在计划表格处未命中，但前段工作流与说明文档已经成功写入；复核后只补齐缺少的错误与进度记录，没有重复修改已生效部分。
- CI 热修快速校验通过，阶段 13 的实现、文档、标签与首次推送均已完成；最后只需提交并推送该定点修复到 `main`。
- GitHub Repository Guard 发现版本脚本错误读取普通分支的 `GITHUB_REF_NAME=main`；已限制环境变量标签校验只在 `GITHUB_REF_TYPE=tag` 时启用，发布工作流继续显式传入 `--tag`。
- 推送 `351f7be` 时本地 pre-push hooks 超过工具 120 秒上限，结果未知；修复版本脚本后将先查询远端 HEAD，避免重复或错误报告推送状态。
- 已确认远端 `origin/main` 实际到达 `351f7be`，因此未重复推送该提交。
- 版本脚本三路回归通过：普通 `main` 分支不做标签校验、`v1.1.12` 标签通过、错误标签 `v0.0.0` 被按预期拒绝；相关 Prettier 检查通过。
- `8fcbe8f fix(ci): 区分分支与发布标签` 已推送到 `origin/main`，工作区随后确认干净。
- 尝试读取 GitHub Actions 实时状态时发现本机没有 `gh`；遵循 MVP 约束未安装额外工具，推送成功和远端提交更新已经由 Git 返回值确认。

### 阶段 14：Windows CI 与比赛发布稳定性修复

- **状态：** 进行中
- 已根据用户提供日志定位三类独立问题：Windows CRLF 引发 Prettier 全仓误报、桌面冷编译超过 90 分钟被取消、GitHub Release API 5xx 使 `softprops` 重试耗尽。
- 已确定发布重构方案：工作流直接执行 Tauri 构建，GitHub CLI 负责确保 draft 与上传产物，并使用最多 6 次指数退避；桌面与 Android 发布任务移除显式超时。
- 已完成 Release 工作流重构：移除 `tauri-action`、`softprops` 和全部发布任务 `timeout-minutes`；桌面使用 `pnpm tauri build`，draft 与两端资产使用 GitHub CLI 可重入上传。
- 已增加桌面发布 `workflow_dispatch`，可从 `main` 输入 `v1.1.12`，检出原标签代码并使用最新工作流重试，无需移动标签。
- `.gitattributes` 与 Prettier `endOfLine=auto` 已消除 Windows 换行误报；首次完整检查从 75 个警告收敛为 5 个真实格式差异，机械格式化后完整检查通过。
- 快速门禁通过：冲突检查、版本一致性、完整 Prettier、Web TypeScript、移动 TypeScript 和 `git diff --check`。
- 按用户要求未在本地重复执行 NSIS 或 Android 构建；新工作流可从 Actions 手动输入 `v1.1.12` 重跑，并允许冷编译超过 90 分钟。

### 阶段 15：OCR 作业管线与移动横屏适配

- **状态：** 进行中
- 已恢复并保留聊天中断闭环与 Rust OCR 基础模块的全部未提交改动，没有回退用户工作树。
- 已只读分析 `E:\Projects\OCR`，确定迁移逐页执行、缓存隔离、独立断点、失败页重试和旋转坐标机制，不迁移 Python 依赖或隐藏 PDF 文字层。
- 已完成移动端横屏 UI 审视，确认 Expo 与 Android Manifest 双重方向锁定，并制定平板短边断点、左侧 Tabs、PDF 左右分栏和论文网格规范。
- 已更新阶段 15 任务边界：先实现真实可恢复作业骨架和移动横屏阅读，再接入 PP-OCRv6/PP-DocLayout 推理后端。
- 下一步：完成中文实施方案，修改 Rust OCR 作业状态机与测试，再实现移动端响应式 Hook、方向解锁、导航和 PDF/论文布局。
- 已新增逐页 OCR 作业执行器、原始缓存与版面 Sidecar 分层、三次失败重试、页边界暂停和实际 PP-DocLayout 标签映射。
- 已解除 Expo 与 Android Manifest 竖屏锁定，并完成响应式 Hook、平板左侧 Tabs、论文多列、PDF 左文档右工具区和横屏 AI 右侧抽屉。
- Rust `cargo check` 与移动 TypeScript 首轮通过；Rust 全库测试因冷编译超过 120 秒工具上限，响应式 Node 测试因受限环境 `spawn EPERM`，均将按对应方式继续验证。
- 响应式纯函数已从 React Native Hook 中抽离，Node 测试 3/3 通过；Rust 全库首轮实际运行 49 项，新增四项作业测试因夹具未先写入外键资产失败，已修正夹具后复检。
- 已补齐视觉页坐标转换，覆盖 0、90、180、270 度、裁切区限制和非法角度；Rust 全库测试最终增至 52 项并全部通过。
- 已完成前端阅读适配：横屏手机保持紧凑布局，平板横屏使用左侧 Tabs、PDF 左右分栏、AI 右侧抽屉和论文多列网格；竖屏交互保持原样。
- 本轮质量门禁已通过 Rust 格式/编译/52 项单元测试、Web 与移动 TypeScript、聊天组合器 2/2、响应式布局 3/3、全仓 Prettier、冲突标记与差异空白检查。
- 阶段 15 本轮完成项已收束；真实 PP-OCRv6/PP-DocLayout 推理、移动 Sidecar 选字、Research Memory 写入和聊天/知识库深度平板主从布局继续保持未完成。
- 用户后续明确要求取消 OCR 安全门禁且不再使用 SHA-256；已从运行库清单、下载校验和源文件指纹中移除 SHA-256，并保留 HTTPS 清单、非空文件、Content-Length 与可选大小检查。
- 该变更不会自动触发下载；旧 SHA-256 OCR 源签名会自然失效，后续执行时重新生成 Sidecar。
- 用户要求尽快发布且避免过度复杂化；版本开始统一升级为 1.1.13，Android `versionCode` 升至 23，发布范围收敛为聊天稳定性、OCR 基础和移动横屏阅读。
- Windows NSIS 1.1.13 构建成功，安装包 ProductVersion 与 FileVersion 均为 1.1.13。
- Android release 1.1.13 构建成功，核验 `versionCode 23`、`versionName 1.1.13` 和 APK v2 签名有效。
- 已更新 `mobile-app/dist/android` 中的 1.1.13 版本化 APK 与稳定 APK；旧版版本化文件继续保留，可用于恢复。
- 按用户要求未计算本次 OCR 运行库或发布产物的 SHA-256，也未自动下载 OCR 模型。
