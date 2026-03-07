# Design Specification

更新日期：2026-03-07

## 1. 目标
本阶段的目标是把 PDF 阅读、术语解释和知识沉淀整合成一条闭环：
- 用户在 PDF 页面内直接选中术语或短语。
- 应用按选定的解释模式检索外部参考资料。
- 本地模型结合论文页上下文，生成适合新手理解的中文解释。
- 用户可将该解释一键保存为 Markdown 知识卡片，并在卡片库中继续浏览。

## 2. 核心交互
### 2.1 PDF 阅读与选词解释
- 组件：`src/components/PdfReader.tsx`
- 实现：直接使用 `pdfjs-dist` 的单页 `canvas + text layer` 渲染，不再依赖 `PDFViewer` 或第三方 React PDF 封装。
- Worker：使用本地打包的 `pdfjs-dist/build/pdf.worker.min.js`，避免依赖 CDN。
- 交互：
  - 用户在 PDF 文本层中选词。
  - 选区旁出现“解释”按钮。
  - 点击后打开 `TermExplainPopover`。
  - PDF 页面采用连续滚动多页渲染，页码状态随滚动自动更新，上一页 / 下一页按钮本质上是滚动定位。
  - 浮层使用固定定位并做视口边界避让，避免在阅读区边缘被裁切。
- 约束：
  - 若当前页无法提取文本，则提示“当前页不可直接选词，OCR 支持后可用”。
  - 本期不实现 OCR。
  - 若高级阅读器运行报错或加载超时，自动回退到兼容模式 `iframe`，保证 PDF 仍可打开，但此时不支持页面内直接选词解释。
  - 阅读器直接接管当前页 canvas 渲染、翻页、缩放与文本层选区，避免第三方 viewer 封装引入的 Hook 次序错误。
  - 应用入口不启用 React.StrictMode，避免当前第三方 PDF 组件在 React 19 环境下触发 Hook 次序错误并回退到兼容模式。

### 2.2 解释模式
- 类型：`TermLookupMode`
- 前端可选项：
  - `popular_cn`
  - `cs_encyclopedia`
  - `bioinformatics`
- 当前前端存储：`localStorage` 键 `ra_term_lookup_mode_v1`
- 切换位置：PDF 阅读器顶部工具条

### 2.3 解释结果浮层
- 组件：`src/components/TermExplainPopover.tsx`
- 状态：
  - `loading`
  - `success`
  - `error`
- 内容：
  - 术语名称
  - 通俗解释
  - 参考资料摘要
  - 来源提供方 / 语言 / 链接
  - 来源状态标签
- 操作：
  - 保存为知识卡片
  - 导出 Markdown（卡片保存后）
  - 关闭
- 交互细节：
  - 浮层标题区支持拖动。
  - 标题区固定，正文在浮层内部滚动，避免长内容遮挡标题和操作按钮。
  - 打开位置会自动避开窗口顶部与右侧边界。
- 缓存：
  - 使用 `sessionStorage`
  - Key：`lookupMode + pdfPath + page + selectedText`

### 2.4 知识库搜索
- 组件：`src/components/ChatInterface.tsx`
- 数据源：复用现有 Tauri 命令 `query_knowledge_base`
- 交互：
  - 用户在对话页输入关键词。
  - 前端直接检索已导入知识库的摘要片段。
  - 每条结果支持“插入输入框”和“打开文件”。
- 目标：
  - 让知识库不仅作为聊天时的隐式检索上下文，也能作为显式可搜索的资料面板使用。

## 3. 多来源解释后端
### 3.1 命令
- `explain_pdf_selection(request)`
- 输入：
  - `term`
  - `pdf_path`
  - `page`
  - `model`
  - `mode`
- 输出：
  - `plain_summary`
  - `source_title`
  - `source_url`
  - `source_provider`
  - `source_lang`
  - `source_extract`
  - `page_context_snippet`
  - `source_status`
  - `generated_at`
  - `lookup_mode`

### 3.2 外部来源链路
#### 3.2.1 通俗百科 `popular_cn`
- 模块：`src-tauri/src/encyclopedia.rs`
- 当前实现：百度百科页面摘要抓取
- 说明：
  - 之所以不写死 Wikipedia，是为了兼容中国大陆网络环境。
  - 当前实现依赖公开页面摘要，页面结构变化会影响稳定性。

#### 3.2.2 CS 百科 `cs_encyclopedia`
- 优先级链路：
  1. Stack Overflow Tag Wiki API
  2. MDN Glossary 页面摘要
  3. GitHub Topics 页面摘要
- 说明：
  - 适合框架、协议、语言、工程概念等技术术语。
  - GitHub Topics 当前未引入额外 token，采用公开页面摘要作为轻量实现。

#### 3.2.3 生信百科 `bioinformatics`
- 当前实现：NCBI Gene E-utilities
- 说明：
  - 优先面向基因符号 / 基因名。
  - 对疾病、通路、实验方法等术语覆盖仍不完整，后续可补充 MeSH / 其他专业来源。

### 3.3 模型总结策略
- 先提取当前 PDF 页文本。
- 截取术语附近上下文窗口，默认前后各约 300 字符；若未命中术语，则回退到页首约 800 字符。
- 把“外部资料摘要 + 论文页上下文”发送给 Ollama 本地模型。
- 要求模型输出面向初学者的中文解释。
- Prompt 额外约束：
  - 若外部百科摘要疑似因重名命中到歌曲、电影、娱乐人物等内容，模型必须忽略该摘要。
  - 若所选词只是普通英文日常词，例如 `different`、`make`、`the`，优先给出中文翻译，再说明它在当前句子里的作用，不强行解释成科研概念。
- 回退规则：
  - 外部资料命中且模型失败：返回 `source_only`
  - 外部资料未命中但模型成功：返回 `model_only`
  - 两者都成功：返回 `source+model`

### 3.4 普通英文词拦截
- 实现位置：`src-tauri/src/lib.rs`
- 规则：
  - 对一组高频普通英文词做快速拦截。
  - 命中后默认跳过外部百科检索，直接进入“中文翻译 + 语境解释”路径。
- 目的：
  - 避免 `different` 之类的普通单词被外部百科误命中到歌曲或娱乐条目。

## 4. 知识卡片系统
### 4.1 存储路径
- 默认路径：`app_data/card_library`
- 可配置路径：通过设置页切换为任意可写目录
- 路径配置文件：`app_data/card_settings.json`
- 路径模式：单一活动路径，不做双写

### 4.2 后端命令
- `get_card_settings()`
- `set_card_root_path(path)`
- `open_card_root_in_explorer()`
- `list_knowledge_cards()`
- `read_knowledge_card(card_path)`
- `save_knowledge_card_from_explanation(request)`

### 4.3 文件命名
- 格式：`YYYYMMDD-HHmmss-slug-id8.md`
- `slug` 来自术语名的安全化结果

### 4.4 Markdown 结构
- Frontmatter 记录：
  - `id`
  - `term`
  - `title`
  - `created_at`
  - `updated_at`
  - `pdf_path`
  - `pdf_page`
  - `selected_text`
  - `source_status`
  - `source_title`
  - `source_url`
  - `source_provider`
  - `source_lang`
  - `model`
  - `lookup_mode`
  - `tags`
- 正文结构：
  - `# 术语`
  - `## 通俗解释`
  - `## 参考资料摘要`
  - `## 论文上下文`
  - `## 来源`

### 4.5 卡片库视图
- 组件：`src/components/CardLibrary.tsx`
- 主视图切换：与“对话”并列，不引入路由系统
- 当前能力：
  - 列表展示
  - 前端即时搜索筛选（术语 / 标题 / 摘要 / 来源 / 文件名）
  - 查看摘要预览
  - 打开 Markdown
  - 导出 Markdown
  - 在资源管理器中显示
  - 打开卡片目录

## 5. 应用集成
### 5.1 主界面
- 组件：`src/App.tsx`
- 主视图：
  - `chat`
  - `cards`
- 左侧：工作空间文件树、导入入口、模型选择器
- 右侧：对话 / 卡片库
- 布局：左侧栏使用可拖动分隔布局，默认宽度约 `320px`，允许用户手动调整。
- 版权标记：
  - 主界面右下角固定显示版权声明。
  - 文案明确标注项目属于 4C 比赛参赛团队专属作品，未经授权严禁搬运。

### 5.2 对话页
- 组件：`src/components/ChatInterface.tsx`
- 保留能力：
  - 普通问答
  - 图文问答入口
  - 会话持久化
  - 笔记
  - 引用片段
  - Markdown 导出
  - PDF 专注阅读模式
- 变更：
  - 移除旧的“当前页文本（可划词触发）”主面板
  - 普通文本划词菜单只保留在消息区 / 笔记区

### 5.3 文件树
- 组件：`src/components/FileTree.tsx`
- 行为：
  - 选中文件会更新活动文件
  - PDF 文件进入内嵌阅读器
  - 其他文件仍可直接调用系统打开
  - 支持右键“打开 / 在资源管理器中显示”

## 6. 已知限制
- 扫描版 PDF 暂无 OCR，不保证能直接选词。
- Baidu / MDN / GitHub 当前基于公开页面摘要提取，抗页面改版能力有限。
- 生信模式当前主要覆盖基因术语，不代表完整医学术语库。
- `dual_pipeline` 仍是后续扩展位，当前还未拆成真正的双模型视觉 / 文本路由。

## 6.1 仓库声明
- 根目录提供独立版权文件：`COPYRIGHT_NOTICE.md`
- `README.md` 底部同步展示版权归属与禁止搬运声明，避免脱离代码仓库后失去来源标识。

## 7. 验收基线
- `cargo check` 通过
- `pnpm.cmd -s tsc --noEmit` 通过
- PDF 页面可直接选词并触发解释
- 解释结果可保存为卡片
- 卡片库可见、可打开、可定位
- 知识卡片目录可切换并继续正常保存






