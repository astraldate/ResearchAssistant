# ResearchAssistant

ResearchAssistant 是一个本地优先的科研助理工作台，当前同时包含桌面端和配套移动端：
- 桌面端：Tauri + React + TypeScript
- 移动端：Expo Router + React Native
- 共享协议：`packages/contracts`

当前主线已经覆盖资料导入、知识库检索、PDF 阅读与术语卡片、移动端收件箱、局域网配对、复习事件同步，以及 Android release APK 构建。

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

## 相关文档

- [Design Specification](./Design%20Specification.md)
- [coding_plan.md](./coding_plan.md)
- [masterplan.md](./masterplan.md)
- [COPYRIGHT_NOTICE.md](./COPYRIGHT_NOTICE.md)
