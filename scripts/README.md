# Scripts

本目录只保留开发、发布前检查和本机 sidecar 准备脚本。

## `setup-sidecar.ps1`

把本机已安装的 `ollama.exe` 复制为 Tauri sidecar 需要的文件名：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-sidecar.ps1
```

输出路径：

- `src-tauri/binaries/ollama-x86_64-pc-windows-msvc.exe`

该二进制被 `.gitignore` 忽略，不提交入库。GitHub release workflow 会按固定 Ollama 版本自行下载 sidecar。

## `cleanup.ps1`

清理本机依赖和 Rust 构建产物后重新安装依赖：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/cleanup.ps1
```

脚本会删除：

- `node_modules`
- `src-tauri/target`

## `check-conflict-markers.mjs`

pre-commit 使用的冲突标记检查脚本，只扫描已暂存文本文件。

也可以手动运行：

```bash
pnpm check:conflicts
```

## 本地模型

应用默认连接本机 Ollama：

- Chat Completions API：`http://localhost:11434/v1/chat/completions`
- Ollama API：`http://localhost:11434/api/*`

桌面端普通聊天、科研命令和移动端聊天共用本机 Ollama。移动端聊天通过桌面 companion service 代理到 `http://localhost:11434/api/chat`，因此手机端不需要直接访问 Ollama 端口。

当前推荐模型：

- 聊天：`qwen3.5:9b`
- Research Memory 快速候选抽取：`qwen3:8b`
- Pipeline / Edge 抽取与校验：`qwen3.5:9b`
- Embedding：`nomic-embed-text`

常用准备命令：

```bash
ollama pull qwen3:8b
ollama pull qwen3.5:9b
ollama pull nomic-embed-text
```

如果使用 GGUF 文件，可通过 Ollama `Modelfile` 导入，并保持模型名与设置页配置一致。
