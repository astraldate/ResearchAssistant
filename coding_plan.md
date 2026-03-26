# ResearchAssistant Coding Plan

更新日期：2026-03-26

## 当前路线

- 产品主线：桌面端作为知识库和同步权威节点，移动端作为 companion app 补充采集、复习和轻量浏览。
- 协议主线：桌面端与移动端继续共用 `packages/contracts`，避免双仓库协议漂移。
- 构建主线：Android release 继续留在当前 monorepo 内解决，不另开仓库。
- Windows 主线：通过 `hoisted node linker + patchedDependencies + 短 Android 子项目路径` 控制构建复杂度。

## 本轮已完成

### P0 已完成

- 桌面端新增移动 companion service，支持局域网配对、token 会话、卡片下发、复习事件回传和移动收件箱落盘。
- 桌面端新增“待处理收件箱”主视图，支持查看、标记已处理、恢复待处理和打开附件。
- 移动端 Expo Router 工程完成首版可用链路：配对、复习、卡片库、采集、设置。
- 移动端本地会话切到 `expo-secure-store`，本地缓存和离线队列切到 `expo-sqlite`。
- 修复移动端 React / Expo 原生模块版本错配导致的启动崩溃。
- 修复桌面 companion service 在 Tokio runtime 之外初始化导致的启动 panic。
- Android release 构建已经能在本仓库内稳定跑通，不再依赖临时短路径副本目录。
- 根目录新增 `pnpm.patchedDependencies`，把 Windows Android 构建补丁持久化到仓库。
- `.gitignore` 已补齐 Expo、Android 构建产物、autolink 快照和本机日志忽略规则。
- README、技术设计文档和 master plan 已改成 UTF-8 中文，并同步当前移动端与 APK 流程。

### P1 已完成

- 根 `.npmrc` 改为 `node-linker=hoisted`，减轻 `.pnpm` 深路径对 Android CMake 的影响。
- `mobile-app/android/settings.gradle` 加入较短 Android 子项目目录映射。
- `expo-modules-core` 补丁增加 `CMAKE_OBJECT_PATH_MAX` 和固定中间目录。
- `@react-native/gradle-plugin` 补丁修正 Windows 下 Hermes 命令行路径。
- `mobile-app` 当前版本更新到 `0.1.4`，`versionCode = 5`。

### Research Memory 已完成

- 桌面端新增 `Research Memory` 面板，包含 `Search / Graph / Review / Ideas` 四个子页。
- 论文索引链路改为 `SQLite` 主库 + `LanceDB` 派生向量索引，不再依赖单文件知识库。
- 抽取链路改为 `Map-Reduce`，禁止整篇论文一次性结构化抽取。
- 抽取模型职责已拆分：
  - 聊天默认模型：`qwen3.5:9b`
  - 快速候选抽取：`nuextract`
  - 关系抽取 / 失败兜底：`qwen3:8b`
- 索引前会自动检查并拉取缺失的 `nuextract`、embedding 和关系抽取模型。
- 抽取阶段已拆成：
  - `candidate_extract`
  - `relation_extract`
  - `canonicalize`
  - `index_vectors`
- 当前图谱深度已锁死为：
  - `Task -> Pipeline -> Module`
  - `Challenge -> Insight`
- 已支持右键对工作区中的文件或文件夹执行：
  - `建立索引`
  - `解除索引`
- 进度面板与 `Knowledge` 面板顶部已能显示当前聊天模型、快速抽取模型、回退模型和实际索引阶段。
- 聊天输入框新增 `@paper` 论文 scope mention 与 `/brief` 核心 Markdown 简报指令。

## 仍需继续推进

### P0

- 正式签名链路仍未完成，目前 release 在没有私有 keystore 时会回退到 debug keystore。
- 需要补一份桌面端与移动端联调验收清单，覆盖配对、采集、复习同步和异常恢复。
- 待处理收件箱还缺少“批量处理 / 转卡片 / 关联资料”的后续操作面板。

### P1

- Android 构建日志里 `react-native-gesture-handler` 仍有对象路径 warning，虽然不再阻断 release，但还可以继续压缩。
- 需要把 APK 复制到稳定命名路径的动作收成显式脚本，而不是依赖人工复制。
- 需要增加 Android release 构建的 CI 校验，至少覆盖依赖安装、TypeScript 和 `assembleRelease`。
- `Research Memory` 仍缺少真正的抽取模型设置页，目前默认值已写死到代码和本地持久化状态里。
- `Graph` 仍是轻量 lane 视图，不是 Cytoscape 的可交互 DAG。
- `compare_papers` 后端已具备，但前端完整入口仍需补齐。
- `/brief` 已能生成单论文简报，但还缺少更稳定的证据排序、字段后处理和多文献命令扩展。

### P2

- iOS 安装包和签名链路。
- 移动端推送提醒、后台同步和更完整的复习计划。
- OCR 扫描版 PDF、卡片编辑、标签管理和双向同步。

## 当前实现状态总览

- 桌面端知识库 / PDF / 卡片链路：已完成并可继续演进
- 桌面端 Research Memory / 审核流 / Idea 引擎：已完成首版可用闭环
- 移动端 companion v1：已完成
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
- `cd mobile-app/android && .\gradlew.bat clean assembleRelease --console=plain` 通过
- 手机端可完成局域网配对
- 手机端采集内容能进入桌面端“待处理收件箱”
- 手机端复习事件能回传并更新桌面端状态
- 桌面端可对选中文件 / 文件夹建立索引并进入 `Review`
- `Knowledge` 面板可查看双 DAG、Review 队列和 Rule 1/2/3 Idea 候选
- Chat 输入框可用 `/brief` 生成当前论文简报，或配合 `@paper` 指定目标论文

## 风险与约束

- Expo / React Native 升级后，`patches/` 很可能需要重新生成，不能默认沿用。
- `mobile-app/android/autolink-*.json` 包含本机绝对路径，必须忽略，不适合作为仓库输入。
- 如果 Windows 未开启系统级长路径支持，构建 warning 会更多，但当前路径压缩方案已经能稳定出包。
- 目前的 release APK 更适合本地安装测试，不等于可直接分发的正式签名包。
- Research Memory 说明已并入 `Design Specification.md`，后续不要再维护独立的 `RESEARCH_MEMORY_MANUAL.md`。

ResearchMemoryPanel 按需加载
PdfDock 按需加载
PdfReader 再延后一层，只在真正打开 PDF 时加载
CardLibrary 按需加载
Graph Canvas 内的详情查询改成点击后再取，不在打开时预热
