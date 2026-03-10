# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
  
2.  **启动应用**：
    ```bash
    pnpm run tauri dev
    ```

3.  **使用流程**：
    *   应用启动后，点击左侧栏顶部的 **文件夹图标**。
    *   选择你的 **Obsidian 笔记文件夹**。
    *   应用会在后台扫描文件，并调用本地 Ollama (`nomic-embed-text`) 进行切片和向量化（终端会显示进度）。
    *   向量化完成后，在右侧聊天框输入问题，系统会检索相关笔记并调用 `qwen3-4b-thinking-2507` 进行回答。

现在你可以尝试运行应用了。# ResearchAssistant

## Copyright Notice

本项目 `ResearchAssistant` 为团队参加计算机设计大赛（4C 比赛）的专属参赛作品。

项目的代码、界面设计、交互方案、文档内容与相关实现成果，均归参赛团队所有。未经团队书面授权，任何个人或组织严禁以任何形式搬运、转载、镜像、分发、改名发布、二次提交，或用于其他比赛、课程、商业与展示场景。

如需使用、引用或展示本项目内容，请先取得团队明确授权。详情见 [COPYRIGHT_NOTICE.md](./COPYRIGHT_NOTICE.md)。
