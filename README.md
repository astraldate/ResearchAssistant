# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Mobile App Testing

### Desktop

- Start the desktop app with `pnpm run tauri dev`.
- Open the desktop settings modal and find the `移动端配套` section.
- Record the LAN address such as `http://192.168.1.20:38465` and the 6-digit pair code.
- Open the new `待处理收件箱` tab to inspect captures sent from the phone.

### Mobile App

- Start the Expo app with `pnpm --dir mobile-app dev`.
- For real-device testing, keep the phone and PC on the same Wi-Fi and prefer `expo start --lan`.
- Install `Expo Go` on the phone and scan the QR code from the Expo terminal.
- On the phone, open `配对桌面端`, enter the desktop LAN address and pair code, then wait for the first bootstrap sync to finish.

### Android Emulator

- Windows can test the mobile app with an Android emulator.
- Start an Android emulator from Android Studio, then run `pnpm --dir mobile-app android` or press `a` in the Expo terminal.
- When pairing from the emulator, use `http://10.0.2.2:38465` instead of `127.0.0.1`.

### iPhone

- Windows cannot run the iOS Simulator.
- iPhone testing still works through `Expo Go` on a real device, as long as it is on the same LAN as the desktop app.
  
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
