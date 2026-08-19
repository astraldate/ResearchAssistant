# Codex 生产配置实施记录

## 安全前提

- 在普通用户进程中临时移除 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 后，ChatGPT 后端、ChatGPT 主页和 GitHub 均能建立 HTTPS 连接并收到服务器响应。
- Clash Verge、服务和 Mihomo 内核均在运行，7897 正常监听；本次不修改 Clash Verge 配置，也不关闭其分流。

## 配置决定

- Codex Windows 沙箱从 `elevated` 切换为 `unelevated`。
- 移除 VS Code 写死的 `http.proxy=127.0.0.1:7897`，将 `http.proxySupport` 改为 `on`，网络交给 Clash Verge 系统/TUN 规则分流。
- 保留 PowerShell 的 `px` 函数，因为它只在用户手动调用时临时注入代理，命令结束后会恢复环境。
- npm 与 pnpm 已使用 npmmirror，pip 已使用清华 PyPI，Conda 已优先使用清华源，不重复覆盖。
- Cargo 新增 rsproxy 稀疏索引配置。

## 验证

- npmmirror、清华 PyPI、清华 Conda 和 rsproxy 的 HTTPS 探测均返回 HTTP 200。
- `cargo search serde --registry rsproxy` 在普通用户、无代理变量进程中成功。
- 同一 Cargo 测试在当前 elevated 沙箱中出现 Schannel `SEC_E_NO_CREDENTIALS`，属于沙箱凭据隔离现象，也是切换 `unelevated` 的理由之一。

## 异常记录

- 原诊断目录中的 `task_plan.md`、`findings.md` 和 `progress.md` 在工作期间被其他并发上下文移除，仅保留 `staged` 目录。本记录承接后续实施状态，未覆盖或恢复并发上下文删除的文件。
