# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
  
2.  **启动应用**：
    ```bash
    npm run tauri dev
    ```

3.  **使用流程**：
    *   应用启动后，点击左侧栏顶部的 **文件夹图标**。
    *   选择你的 **Obsidian 笔记文件夹**。
    *   应用会在后台扫描文件，并调用本地 Ollama (`nomic-embed-text`) 进行切片和向量化（终端会显示进度）。
    *   向量化完成后，在右侧聊天框输入问题，系统会检索相关笔记并调用 `qwen3-4b-thinking-2507` 进行回答。

现在你可以尝试运行应用了。# ResearchAssistant
