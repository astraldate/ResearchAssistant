# ResearchAssistant Master Plan

更新日期：2026-03-14

## 1. 总目标

把 ResearchAssistant 做成一个本地优先、桌面端为主、移动端补充的科研工作台：
- 桌面端负责资料导入、知识库、PDF 阅读、知识卡片和同步权威状态。
- 移动端负责随手采集、轻量复习、卡片浏览和局域网补充输入。
- 所有核心能力优先围绕“同一仓库、同一协议、同一版本节奏”推进。

## 2. 架构原则

- 本地优先：核心数据默认落本机，不依赖外部云服务才能使用。
- 桌面权威：移动端是 companion，不与桌面端争夺最终状态。
- 单仓协作：桌面端、移动端、共享协议继续保留在同一仓库。
- 可复现构建：Windows 上的 Android release 方案必须在当前仓库内重复执行。
- 渐进增强：先把可用链路跑通，再逐步补正式签名、CI 和更复杂同步能力。

## 3. 当前系统分层

### 3.1 桌面端

- 资料导入与知识库检索
- PDF 阅读、术语解释、知识卡片
- 待处理收件箱
- 移动 companion service

### 3.2 移动端

- 局域网配对
- 采集笔记 / 链接 / 图片
- 复习事件离线缓存与回传
- 卡片摘要浏览

### 3.3 共享层

- `packages/contracts` 统一协议
- `patches/` 固化 Windows 原生构建补丁
- 根 `.npmrc` 和 workspace 统一依赖布局

## 4. 2026 近期优先级

### P0

- 完成 Android release 正式签名
- 补齐桌面端 / 移动端联调验收清单
- 继续完善待处理收件箱的后续处理动作

### P1

- 把 APK 产物导出和校验收成稳定脚本
- 为 Android release 增加自动化校验
- 继续削减 Windows 下原生构建路径 warning

### P2

- iOS 安装链路
- OCR 扫描 PDF
- 卡片编辑、标签和更完整的复习计划

## 5. 工程规则

- 依赖安装从仓库根目录执行，保证 patch 与 workspace 同步生效。
- Android 原生版本升级后，要同步检查 `patches/`、`mobile-app/android/settings.gradle` 和 `mobile-app/android/app/build.gradle`。
- `mobile-app/android/autolink-*.json`、本机日志和 APK 构建产物只保留本地，不进入仓库。
- 文档必须和真实构建链一致，不能保留模板文案或乱码状态。
