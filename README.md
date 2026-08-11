# ResearchAssistant

ResearchAssistant 是一个本地优先的科研助理工作台，当前同时包含桌面端和配套移动端：

- 桌面端：Tauri + React + TypeScript
- 移动端：Expo Router + React Native
- 共享协议：`packages/contracts`

当前主线已经覆盖资料导入、知识库检索、Research Memory、PDF 阅读与术语卡片、Notes 草稿、移动端收件箱、移动端独立聊天、移动端 PDF AI、A+B 组合创新分析、桌面笔记与知识卡片同步、局域网或 Tailscale 配对、复习事件同步，以及桌面端和 Android release 构建。

当前发布版本为 `1.1.12`。移动协议版本为 `2026-08-10.v2`；HTTP 路径为兼容旧客户端继续保留 `/api/mobile/v1` 前缀。

## 仓库结构

- `src`：桌面端前端
- `src-tauri`：桌面端 Rust 后端与移动 companion service
- `mobile-app`：移动端 Expo Router 工程
- `packages/contracts`：桌面端与移动端共享协议类型
- `patches`：`pnpm.patchedDependencies` 使用的原生构建补丁
- `src-tauri/tauri.conf.json`：把根依赖中的 PDF.js 与 worker 映射为桌面端打包资源，不依赖 CDN

## 环境要求

- Node.js 20+
- `pnpm` 10
- Rust stable
- Android SDK + JDK 21（仅 Android APK 构建需要）
- 手机与桌面端处于同一局域网，或两端均连接同一个 Tailscale tailnet

## 安装依赖

```bash
pnpm install --force
```

根目录 `.npmrc` 使用 `node-linker=hoisted`，并且根 `package.json` 会自动应用 Android 原生构建补丁，所以依赖安装必须从仓库根目录执行。

## 桌面端开发

```bash
pnpm run tauri dev
```

桌面端设置页里的“移动端配套”面板会显示所有可用连接地址：

- 局域网地址，例如 `http://192.168.1.20:38465`
- Tailscale 地址，例如 `http://100.x.y.z:38465`
- 6 位配对码
- 已配对设备
- `mobile_inbox` 和 `review_state` 数据目录

桌面端主界面包含“待处理收件箱”视图，用来处理手机端投递的笔记、链接和图片。桌面端还会保存移动聊天会话，并通过本机 Ollama 为手机端提供流式回答；如果手机网络中途断开，桌面端仍会继续生成并把最终结果写回该移动会话。

### Tailscale 访问

移动服务本质上仍只监听桌面端本机端口 `38465`。如果检测到 Tailscale，桌面端会尝试自动配置 Tailscale TCP Serve，把 `100.x.y.z:38465` 转发到本机服务端口。这样手机不需要和电脑处于同一 Wi-Fi，也不需要配置路由器端口转发。

如果设置页没有出现 `100.x.y.z` 地址，优先检查：

- 桌面端和手机端都已登录同一个 Tailscale tailnet。
- Tailscale 桌面客户端在线，并允许 `tailscale serve`。
- 桌面端设置页点击“刷新状态”后重新读取地址。

局域网地址和 Tailscale 地址可以并存。配对后移动端会探测候选地址并优先使用当前响应更快的可达地址；局域网不稳定或校园网隔离时可使用 Tailscale，同一 Wi-Fi 下通常可直接使用局域网地址。

## 本地模型

桌面端默认使用本机 Ollama：

- 聊天模型：`qwen3.5:9b`
- 候选节点抽取：`qwen3:8b`
- Pipeline Summary / Pipeline 命名 / Edge 抽取 / Edge 校验：`qwen3.5:9b`
- Embedding：`nomic-embed-text`

设置页的“模型”面板会优先复用本机已有 Ollama 模型；缺少索引所需模型时，会在 `prepare_models` 阶段按当前配置尝试拉取。侧载 Ollama 二进制的说明见 [scripts/README.md](./scripts/README.md)。

## 移动端开发与真机测试

启动开发服务器：

```bash
pnpm --dir mobile-app dev
```

推荐测试方式：

- Android / iPhone 真机：安装 `Expo Go`，手机和电脑连同一 Wi-Fi，扫码启动
- Android 模拟器：运行 `pnpm --dir mobile-app android`，配对地址使用 `http://10.0.2.2:38465`

真机联调步骤：

1. 启动桌面端，记录设置页展示的局域网地址或 Tailscale 地址，以及 6 位配对码。
2. 在手机端进入“配对桌面端”页，输入地址和配对码。
3. 配对成功后，在“聊天”页新建移动会话，测试桌面模型是否能流式返回。
4. 在“聊天”页顶部切换到“采集”，发送笔记、链接或图片。
5. 回到桌面端“待处理收件箱”确认新条目出现。
6. 在手机“知识”页刷新同步，新建并编辑一张卡片和一篇笔记，再验证删除前出现确认提示、删除后桌面与手机列表一致。
7. 在“知识”页顶部切换到“复习”并完成几次操作，确认桌面端复习状态有同步。
8. 在手机“论文”或“知识”中打开 PDF，确认在线 AI 阅读器能够翻页、直接拖动选字、翻译和解释；断开桌面端后确认已缓存 PDF 自动回退到离线阅读。
9. 在手机“聊天”页顶部切换到“创新”，输入 AD 与 GNN，确认概念后检查双路证据卡片、Markdown 正文和 `[A1]`、`[B1]`；分别验证“删除分析”和“从 Idea Map 删除”不会误删论文。

## 移动端导航与资料同步

移动底部导航精简为“知识、论文、聊天、设置”四个入口：

- “聊天”页顶部在“会话 / 创新 / 采集”之间切换。创新页提供 A/B 双概念输入和当前会话创新结果；会话消息区独立滚动，输入 Dock 固定在底部。
- 点击 `/` 或 `@` 会在输入栏当前光标或选区处插入触发符；选择候选时只替换光标左侧对应草稿，并把光标恢复到 Token 之后。可见的 `/<command>` 或 `@「论文标题」` Token 会在发送前剥离，仅通过结构化 `command` 与 `paperContext` 传输，选择后仍可继续输入和正常发送。
- 已选择论文时，`/brief`、`/method`、`/exp`、`/claim` 可以不补正文直接执行；`/ask` 仍要求具体问题，`/innovation` 仍要求两个概念，避免静默猜测研究意图。
- “知识”页顶部在“卡片 / 笔记 / 复习”之间切换。卡片和笔记可在手机上新建、编辑、Markdown 预览和删除；写操作必须先由已配对桌面端成功持久化，再刷新本地 SQLite。复习评分继续支持离线排队。
- 旧“采集”和“复习”路由仍保留为兼容重定向，但不再占用底部 Tab。
- 删除卡片或笔记必须先获得桌面端成功响应，再清理手机 SQLite 缓存；离线时不会执行假删除。卡片删除还会清理对应复习状态。
- 同步到手机的 Markdown 会剥离 YAML frontmatter，来源论文只保留文件名，不下发桌面绝对路径。

## 移动端 PDF AI

桌面在线时，移动端默认使用桌面 companion service 提供的 PDF.js 阅读器：

- PDF.js、worker 和样式随桌面应用本地打包，不访问 CDN。
- 手机只提交 `sourceType`、`sourceId` 和页码，桌面端解析受控 PDF 来源；移动端不能提交任意桌面文件路径。
- PDF 内容接口支持 HTTP Range，请求只读取当前渲染所需的数据，避免打开大文件时等待完整下载。
- 阅读器提供原生长按选择和“选字”模式；选字模式直接按下并沿阅读方向拖动，不要求长按，也不显示矩形框。服务先按视觉位置重建行、栏与字符顺序，再生成连续文字高亮和可拖动端点手柄；跨栏内容需要分次选择，避免把上方或左栏无关文字夹进选区。
- 选中文字后可执行“翻译选中内容”和“解释术语”，也可执行“翻译当前页”；解释结果可保存为知识卡片，保存成功后立即同步到手机“知识”页。
- 划词翻译以已经选中的文字为主输入；遇到损坏的 PDF ToUnicode CMap 时会放弃可选页面 Context 并继续调用翻译模型，不再因整页提取失败而中断。
- 解释术语时优先使用 PDF.js 文字层生成的选区周边上下文；桌面端回退提取文本会执行 Unicode 替换字符和控制字符质量门禁，乱码片段不会展示或传给模型。
- 术语解释会并行执行模型独立解释与 5 秒限时百科查询。移动结果明确分为“AI 综合解释、百科资料、页面上下文、生成信息”；模型先使用稳定领域知识定义概念，页面 Context 只用于说明该词在本文中的含义。
- PDF 在后台进入本地缓存。桌面断开或在线阅读器失败时，移动端保持当前页并切换到原生离线阅读器；AI 操作需要重新连接桌面端。
- Token 通过请求头传递，不写入 PDF URL、日志或持久化 PDF 缓存。

## A+B 组合创新分析

移动科研会话会在发送前识别“在 A 上使用 B”“A+B”“结合 A 与 B”等组合创新意图。识别命中后不会直接猜测缩写，而是展示可编辑确认卡；用户确认后才执行分析，取消则按普通聊天处理。

桌面端分别用概念 A 和概念 B 检索本地 Research Memory，每侧最多选择两篇论文，并以 `[A1]`、`[A2]`、`[B1]`、`[B2]` 发送结构化证据。未完成索引的演示 PDF 可按标题相关性和实际首页文字作为受限回退证据。若某一侧没有本地论文，模型可以基于通用知识提出待验证假设，但该侧不得生成论文引用；两侧都没有证据时，回答会明确标注本次未使用本地论文证据。

完成且包含本地论文证据的 A+B 回答会自动保存为桌面 `Idea Map` 节点。每篇证据论文显示为 `Paper` 节点，并以标有 `[A1]`、`[B1]` 等标签的 `supports_idea` 边指向创新点；点击节点或边可查看片段并打开原文页。

手机会话中的同一条回答也会显示独立的“创新点”卡片：卡片展示 `A × B`、本地证据覆盖状态，并从固定回答结构中提取 2–3 条创新假设。聊天页另有明确的“创新”子页面，可发起 A+B 分析并浏览当前会话历史结果；重新打开历史会话时可由已持久化正文恢复显示。

创新历史提供两个语义独立的删除动作：“删除分析”只删除本次提问与回答，不删除已经保存到桌面 Idea Map 的节点；“从 Idea Map 删除”只删除 Idea 节点及论文支持边，保留聊天正文、来源论文和引用卡片。引用片段若包含大量替换字符或典型乱码，会隐藏污染文本并保留论文标题、页码和打开原文入口。

移动会话输入框支持 `/` 指令选择器和 `@` 论文选择器。`/ask`、`/method`、`/exp`、`/claim`、`/brief`、`/innovation` 会切换桌面模型的回答策略；`@` 选择作为结构化论文范围发送，只检索所选论文，而不是把标题简单拼入问题文本。

移动端使用受控的原生 Markdown 渲染器展示助手回答、创新分析、PDF AI 结果、知识卡片与论文笔记。它支持标题、段落、列表、粗斜体、引用、代码和 HTTP(S) 链接，不执行原始 HTML，也不加载 Markdown 远程图片。

当前演示工作区保留 6 篇代表论文，其余 PDF 已物理清理。应用同时持久化 `demo_library.json` 可见集，确保移动论文页和 `@` 选择器不会重新混入非演示条目。

该功能用于生成可检验的跨概念假设，不把两个概念的拼接自动视为已成立的学术创新。完整机制、证据约束和已知风险见 [设计规范](./Design%20Specification.md#7-ab-组合创新分析机制)。

## Android Release APK

当前项目用于比赛演示，不以应用商店上架为目标。在仓库内构建可安装的演示 APK：

```bash
pnpm --dir mobile-app android:apk:release
```

Gradle 原始产物路径：

- `mobile-app/android/app/build/outputs/apk/release/app-release.apk`

当前本机还会额外保留一份稳定命名副本：

- `mobile-app/dist/android/researchassistant-mobile-release.apk`

注意：

- `mobile-app/dist/` 被 `.gitignore` 忽略，APK 只作为本机构建产物保存，不提交入库。
- GitHub Release 中的 Android 文件命名为 `researchassistant-mobile-v<版本>-demo.apk`，使用测试签名，只适合比赛设备和内部演示。
- 本阶段不配置应用商店正式签名、AAB、渠道包、商店元数据或自动上架。

## Windows 下 Android 构建约束

为了让同仓库 monorepo 在 Windows 上稳定出包，仓库当前采用了这套策略：

- 根 `.npmrc` 使用 `node-linker=hoisted`，减少 `.pnpm` 深路径对 CMake 的影响。
- 根 `package.json` 通过 `pnpm.patchedDependencies` 固化了两个原生补丁：
  - `expo-modules-core@55.0.15`
  - `@react-native/gradle-plugin@0.83.2`
- `mobile-app/android/settings.gradle` 会优先把 Expo / React Native Android 子项目映射到较短的 `mobile-app/node_modules/...` 路径。
- `mobile-app/android/autolink-*.json` 和 `build-*.log` 仅用于本地调试，已经忽略，不作为仓库输入。

如果你修改了 Expo / React Native 版本，记得同步检查：

- `patches/`
- `mobile-app/android/settings.gradle`
- `mobile-app/android/app/build.gradle`

## GitHub CI/CD

仓库当前包含三条 GitHub Actions 流水线：

- `CI`：在推送到 `main` / `master` 和发起 PR 时运行。Repository/Web、Mobile、Rust 三个任务并行执行，优先给出失败反馈。
- `Release Desktop`：推送 `v*` tag 时运行。先创建 draft release，再并行构建 Windows 桌面包与 Android 演示 APK。
- `Release Android`：手动触发，检出指定的已有 tag 后重新构建并上传 Android 演示 APK，不会用当前 `main` 冒充旧标签代码。

常规 CI 的快速门禁包括：

- 冲突标记、统一版本和 Prettier 检查
- Web TypeScript 生产构建
- 移动端 TypeScript 与聊天输入纯函数测试
- Rust 格式与库测试；Rust/Tauri 任务会用 `--ignore-scripts` 快速恢复 PDF.js 打包资源，避免 `cargo` 校验因缺少 `node_modules` 误报失败

发布工作流不会重复完整 CI。它会校验 tag 与根包、共享协议、Tauri、Cargo、Expo 和 Android 版本一致，再恢复 pnpm、Rust、Gradle 与 Ollama 缓存并构建。第三方 Action 均固定到不可变提交 SHA；Windows 和 Android 产物分别附带 SHA-256 校验文件。

Android 流水线面向比赛演示，固定生成测试签名的 `-demo.apk`，不包含应用商店上架流程。

### 发布桌面版

推荐流程：

1. 先把要发布的代码合并到 `main` 或 `master`。
2. 确认 GitHub 上最近一次 `CI` 已通过。
3. 更新版本号：
   - [package.json](./package.json)
   - [src-tauri/tauri.conf.json](./src-tauri/tauri.conf.json)
   - [src-tauri/Cargo.toml](./src-tauri/Cargo.toml)
   - [packages/contracts/package.json](./packages/contracts/package.json)
   - 如果移动端也要同步发版，再更新 [mobile-app/package.json](./mobile-app/package.json)、[mobile-app/app.json](./mobile-app/app.json) 和 [mobile-app/android/app/build.gradle](./mobile-app/android/app/build.gradle)；Android `versionCode` 必须递增。
4. 执行统一版本校验：

```bash
pnpm check:release-version
```

5. 创建并推送 tag，例如：

```bash
git tag -a v1.1.12 -m "release: v1.1.12"
git push origin main
git push origin v1.1.12
```

6. GitHub 会自动触发 `Release Desktop`，生成一个 draft release。
7. 在 GitHub Releases 页面检查安装包、版本号、Android 的 `-demo` 标识和 SHA-256，确认后再手动发布 draft。

### 回滚或重发

- 如果 tag 打错了，不要强推覆盖旧 tag。
- 更稳妥的做法是删除错误 tag 后重新打一个新版本 tag，例如 `v1.0.9`。
- 如果只是 release 文案要改，直接在 GitHub 的 draft release 页面编辑即可，不需要重新构建。

## 相关文档

- [设计规范](./Design%20Specification.md)
- [版本变更记录](./CHANGELOG.md)
- [scripts/README.md](./scripts/README.md)
- [COPYRIGHT_NOTICE.md](./COPYRIGHT_NOTICE.md)
