# ResearchAssistant

ResearchAssistant 是一个本地优先的科研助理工作台，当前同时包含桌面端和配套移动端：

- 桌面端：Tauri + React + TypeScript
- 移动端：Expo Router + React Native
- 共享协议：`packages/contracts`

当前主线已经覆盖资料导入、知识库检索、Research Memory、PDF 阅读与术语卡片、Notes 草稿、移动端收件箱、局域网配对、复习事件同步，以及桌面端/Android release 构建。

## 仓库结构

- `src`：桌面端前端
- `src-tauri`：桌面端 Rust 后端与移动 companion service
- `mobile-app`：移动端 Expo Router 工程
- `packages/contracts`：桌面端与移动端共享协议类型
- `patches`：`pnpm.patchedDependencies` 使用的原生构建补丁

## 环境要求

- Node.js 20+
- `pnpm` 10
- Rust stable
- Android SDK + JDK 21（仅 Android APK 构建需要）
- 手机与桌面端处于同一局域网（配对和同步需要）

## 安装依赖

```bash
pnpm install --force
```

根目录 `.npmrc` 使用 `node-linker=hoisted`，并且根 `package.json` 会自动应用 Android 原生构建补丁，所以依赖安装必须从仓库根目录执行。

## 桌面端开发

```bash
pnpm run tauri dev
```

桌面端设置页里的“移动端配套”面板会显示：

- 局域网地址，例如 `http://192.168.1.20:38465`
- 6 位配对码
- 已配对设备
- `mobile_inbox` 和 `review_state` 数据目录

桌面端主界面包含“待处理收件箱”视图，用来处理手机端投递的笔记、链接和图片。

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

1. 启动桌面端，记录设置页展示的局域网地址和 6 位配对码。
2. 在手机端进入“配对桌面端”页，输入地址和配对码。
3. 配对成功后，在“采集”页发送笔记、链接或图片。
4. 回到桌面端“待处理收件箱”确认新条目出现。
5. 在手机“复习”页完成几次操作，确认桌面端复习状态有同步。

## Android Release APK

在仓库内构建正式 APK：

```bash
pnpm --dir mobile-app android:apk:release
```

Gradle 原始产物路径：

- `mobile-app/android/app/build/outputs/apk/release/app-release.apk`

当前本机还会额外保留一份稳定命名副本：

- `mobile-app/dist/android/researchassistant-mobile-release.apk`

注意：

- `mobile-app/dist/` 被 `.gitignore` 忽略，APK 只作为本机构建产物保存，不提交入库。
- 如果没有 `mobile-app/android/keystore.properties`，release 会回退使用 debug keystore，仅适合本地安装测试。

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

- `CI`：在推送到 `main` / `master` 和发起 PR 时运行，负责 Web、Mobile、Rust/Tauri 的常规检查。
- `Release Desktop`：推送 `v*` tag 时运行，负责构建 Windows 桌面版，并在桌面产物完成后附加 Android APK。
- `Release Android`：手动触发，用于把 Android APK 重新上传到指定已有 release tag。

`Release Desktop` 不重复跑常规检查，它只保留发布必需步骤：

- 安装 Node.js、pnpm、Rust
- 恢复 pnpm 与 Rust 缓存
- 安装依赖
- 调用 Tauri Action 构建并发布 Windows 安装包
- 构建并上传 Android APK

### 发布桌面版

推荐流程：

1. 先把要发布的代码合并到 `main` 或 `master`。
2. 确认 GitHub 上最近一次 `CI` 已通过。
3. 更新版本号：
   - [package.json](./package.json)
   - [src-tauri/tauri.conf.json](./src-tauri/tauri.conf.json)
   - 如果移动端也要同步发版，再更新 [mobile-app/package.json](./mobile-app/package.json)
4. 创建并推送 tag，例如：

```bash
git tag v0.1.1
git push origin v0.1.1
```

5. GitHub 会自动触发 `Release Desktop`，生成一个 draft release。
6. 在 GitHub Releases 页面检查安装包、版本号和发布说明，确认后再手动发布 draft。

### 回滚或重发

- 如果 tag 打错了，不要强推覆盖旧 tag。
- 更稳妥的做法是删除错误 tag 后重新打一个新版本 tag，例如 `v0.1.2`。
- 如果只是 release 文案要改，直接在 GitHub 的 draft release 页面编辑即可，不需要重新构建。

## 相关文档

- [Design Specification](./Design%20Specification.md)
- [coding_plan.md](./coding_plan.md)
- [masterplan.md](./masterplan.md)
- [scripts/README.md](./scripts/README.md)
- [COPYRIGHT_NOTICE.md](./COPYRIGHT_NOTICE.md)
