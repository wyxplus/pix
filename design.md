---
name: Pix Desktop
description: 以 Codex 桌面端为视觉参照的克制、紧凑、清晰的开发工具界面。
colors:
  interactive-accent: "#3A83F7"
  light-canvas: "#FFFFFF"
  dark-canvas: "#212121"
  light-panel: "#FFFFFF"
  dark-panel: "#181818"
  light-sidebar: "#F9F9F9"
  dark-sidebar: "#000000"
  light-foreground: "#1A1C1F"
  dark-foreground: "#DFDFDF"
  light-secondary: "rgb(26 28 31 / 0.7)"
  dark-secondary: "rgb(255 255 255 / 0.7)"
  light-tertiary: "rgb(26 28 31 / 0.5)"
  dark-tertiary: "rgb(255 255 255 / 0.5)"
  light-hover: "rgb(26 28 31 / 0.05)"
  dark-hover: "rgb(255 255 255 / 0.08)"
  light-border: "rgb(26 28 31 / 0.08)"
  dark-border: "rgb(255 255 255 / 0.08)"
  light-border-subtle: "rgb(26 28 31 / 0.05)"
  dark-border-subtle: "rgb(255 255 255 / 0.04)"
  light-border-strong: "rgb(26 28 31 / 0.12)"
  dark-border-strong: "rgb(255 255 255 / 0.16)"
  light-user-bubble: "#F5F5F5"
  dark-user-bubble: "#2F2F2F"
  light-maximum: "#924FF7"
  dark-maximum: "#AD7BF9"
  slider-thumb: "#FFFFFF"
  modal-overlay: "rgb(0 0 0 / 0.32)"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "var(--ui-font-size, 14px)"
    fontWeight: 430
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "calc(var(--ui-font-size, 14px) - 1px)"
    fontWeight: 500
    lineHeight: 1.428571
  caption:
    fontSize: "max(11px, calc(var(--ui-font-size, 14px) - 2px))"
  section-label:
    fontSize: "max(12px, calc(var(--ui-font-size, 14px) - 2px))"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "normal"
  settings-title:
    fontSize: "24px"
    fontWeight: 600
    letterSpacing: "-0.025em"
  dialog-title:
    fontSize: "calc(var(--ui-font-size, 14px) + 4px)"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.015em"
  model-label:
    fontSize: "13px"
    fontWeight: 430
    lineHeight: 1.428571
    letterSpacing: "normal"
  model-effort:
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.5
  model-name:
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.333333
  code:
    fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "var(--code-font-size, 12px)"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  2xl: "16px"
  3xl: "20px"
spacing:
  micro: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.light-foreground}"
    textColor: "#FAFAFA"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "8px 16px"
  button-primary-dark:
    backgroundColor: "{colors.dark-foreground}"
    textColor: "{colors.dark-canvas}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "8px 16px"
  button-outline:
    backgroundColor: "transparent"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "8px 16px"
  input:
    backgroundColor: "transparent"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "4px 12px"
  sidebar-row:
    rounded: "{rounded.lg}"
    height: "max(30px, calc(var(--ui-font-size, 14px) * 1.5 + 9px))"
    padding: "0 8px"
  menu:
    rounded: "{rounded.2xl}"
  panel:
    rounded: "{rounded.xl}"
  composer:
    rounded: "{rounded.3xl}"
  model-trigger:
    typography: "{typography.model-label}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 8px"
  model-picker:
    typography: "{typography.model-label}"
    rounded: "{rounded.2xl}"
    width: "254px"
    padding: "4px"
---

## Overview

**设计方向：克制的 Codex 桌面风格。**

本文件记录截至 **2026-09-10**，本次会话中已确认并落地的 Pix 前端视觉设计。适用范围是 `apps/desktop` 的桌面界面，不自动套用到 `apps/landing`。参考是 Codex 桌面端，保留 Pix 名称、功能和已有信息架构。

界面以内容、对话和工作区为中心。导航紧凑，设置以平直列表组织，颜色和字重承担层级，浮层材质用于区分前后关系。避免装饰性卡片、突出的品牌标识和导航中的粗重分隔线，延续 `apps/desktop/PRODUCT.md` 的设计方向。

### 规范依据与适用条件

- 上方 YAML 记录可复用的颜色、排版、圆角和组件参数；正文记录材质、布局、交互与例外。带透明度的颜色保留源代码的精确 `rgb()` 写法，不转换成有舍入误差的八位十六进制颜色。
- 默认值以 UI 字号 14px、代码字号 12px、应用缩放 100%、默认皮肤为基准；px 均指 CSS 像素。操作系统像素比例、WebView 渲染和用户偏好可能改变最终观感。
- 数值依据当前 Pix 实现、此前读取的本机 Codex 样式资源，以及用户提供的蓝色测量结果；不代表对 Codex 当前窗口进行过完整逐像素验收。
- 当前实现入口为 `apps/desktop/src/renderer/styles.css`、`components/ComposerModelPicker.tsx`、`components/FloatingMenu.tsx` 和 `components/ui/`。字体与皮肤入口为 `lib/appearance-prefs.ts`、`lib/theme-packs.ts`。
- `lib/layout.ts` 中仍有旧的密度常量，例如侧栏行高 32px、旧圆角和旧内容宽度说明。视觉实现以当前 CSS 与本文件记录的角色参数为准，不因旧常量或历史注释恢复旧样式；侧栏宽度及响应式计算仍以实际使用的布局逻辑为准。
- `.impeccable/design.json` 是文档附属的预览与扩展数据；派生色阶仅供预览，不新增产品颜色，也不替代本文或运行时样式。

### 页面结构与密度

| 区域                        | 当前设计                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------- |
| 顶部拖动区 / 设置页顶部留白 | 46px 高，处理 macOS 窗口按钮及其他平台窗口控件避让                                      |
| 侧栏宽度                    | 默认偏好 300px，可调 232–360px；用户此前保存的 232px 不是新的全局默认值                 |
| 侧栏内容内边距              | 左右与底部各 12px；导航项内部左右各 8px                                                 |
| 侧栏行高                    | 使用 frontmatter 的 `sidebar-row` 公式，默认 30px；大字号时随之增加                     |
| 会话内容列                  | `.thread-content-column` 最大外宽 760px，居中，左右各 24px 内边距；消息与输入框共用该列 |
| 输入框停靠区                | 位于消息之后、底部 sticky，底部留白 16px，不覆盖最新消息                                |
| 设置内容列                  | 最大外宽 820px，左右 32px，顶部 32px，底部 64px                                         |
| 设置行                      | 上下各 16px，文案与控件间距 24px，末行不画分隔线                                        |

### 响应式规则

侧栏在空间不足时先收窄，给主区域预留至少 600px；CSS 可用宽度低于 832px 时折叠。已进入折叠模式后，恢复阈值为 864px，以免窗口在临界位置反复折叠。窄窗口通过临时抽屉访问导航，抽屉宽度受 `视口宽度 - 48px` 约束；折叠占宽为 0，不留下图标轨道。

临时折叠、抽屉、缩放适配不得改写用户保存的宽度和手动折叠偏好。抽屉打开时主内容不可交互，保留键盘焦点管理、Escape 关闭和焦点恢复。这里只记录实际布局行为，不把浏览器组件检查用的 400px 宽度视为本机窗口默认值。

## Colors

### 强调色

唯一的常规交互蓝色是 frontmatter 的 `interactive-accent`，来源为用户测得的 **红 58、绿 131、蓝 247**。代码入口为 `--interactive-accent`。

默认主题中，下列角色统一引用这一个源值：

| CSS 变量                   | 使用位置                                                                 |
| -------------------------- | ------------------------------------------------------------------------ |
| `--link`                   | 链接、需要蓝色强调的状态与操作                                           |
| `--switch-on`              | 开启状态的开关                                                           |
| `--ring`、`--sidebar-ring` | 键盘焦点、表单焦点                                                       |
| `--running`                | 运行状态标记，经 `--link` 引用                                           |
| `--model-text-accent`      | 思考强度标题、已填充滑轨、模型选择器焦点，经 `--interactive-accent` 引用 |

不再用旧的 `#379CFC`、`#0A84FF`、`#4C8DFF` 分别承担以上默认角色。Codex 安装包曾出现的其他蓝色不覆盖用户实测值。主按钮仍使用明暗反转的中性色，不把所有主操作都涂成蓝色。

### 中性色与主题映射

以下名称对应 frontmatter 中的精确值：

| 角色         | 浅色 token            | 深色 token           | CSS 入口与规则                                           |
| ------------ | --------------------- | -------------------- | -------------------------------------------------------- |
| 主画布       | `light-canvas`        | `dark-canvas`        | `--background`，不要与浮层表面混用                       |
| 浮起表面     | `light-panel`         | `dark-panel`         | `--surface-panel`，卡片、菜单、对话框的底色来源          |
| 实色侧栏     | `light-sidebar`       | `dark-sidebar`       | `--sidebar`；开启原生半透明时让窗口材质透出              |
| 主文字       | `light-foreground`    | `dark-foreground`    | `--foreground`，传递到卡片、菜单与用户消息文字           |
| 辅助文字     | `light-secondary`     | `dark-secondary`     | `--muted-foreground`、`--text-secondary`，70% 不透明度   |
| 弱提示       | `light-tertiary`      | `dark-tertiary`      | `--text-subtle`，50% 不透明度；不是所有说明文字的默认色  |
| 悬停底色     | `light-hover`         | `dark-hover`         | `--surface-muted` / `--hover-fill`，透明叠加在当前背景上 |
| 普通边缘     | `light-border`        | `dark-border`        | `--border`                                               |
| 轻分隔       | `light-border-subtle` | `dark-border-subtle` | `--border-subtle`、`--divider`                           |
| 较强边缘     | `light-border-strong` | `dark-border-strong` | `--border-strong`、`--input`                             |
| 用户消息底色 | `light-user-bubble`   | `dark-user-bubble`   | `--user-bubble`，保留当前 Pix 消息样式                   |

深色辅助文字使用白色的透明度，不直接给主文字色再乘相同透明度。透明色的最终 RGB 取决于底层表面，不能以某一张截图合成后的灰色替代全局 token。

### 特殊状态

Max 思考强度文字分别使用 `light-maximum` / `dark-maximum`，这是模型控件的专用状态色，不作为全应用第二强调色。错误、成功、警告与代码语法高亮保留现有语义色；本轮没有把这些颜色宣称为 Codex 的精确复刻。

### 自定义皮肤

默认主题规范不得覆盖用户的自定义皮肤颜色、壁纸、透明度、模糊、圆角、阴影和字体设置。通过语义变量与 `html[data-theme-skin-active="true"]` 适配，不以全局硬编码强行恢复默认灰阶。

- 普通菜单在皮肤模式下继续接受皮肤的弹层不透明度、模糊和阴影设置。
- 模型选择器保留专用的 90% 背景、8px 模糊、16px 圆角和菜单阴影，同时从皮肤获取文字与表面颜色；交互蓝色仍引用用户确认的全局蓝色。
- 模型选择器在皮肤模式下，普通边缘为皮肤主文字的 8%，较强边缘为 12%，悬停填充为 5%。
- 皮肤下弱文字回退到皮肤的辅助文字色，避免继承默认主题的白色或黑色半透明文字后失去可读性。
- 原生半透明侧栏、皮肤玻璃侧栏、实色侧栏属于不同模式，不能叠加重复的模糊与背景遮罩。

## Typography

### 字体家族与偏好

使用 frontmatter 的系统 UI 字体栈和等宽代码字体栈。macOS 由系统选择适合的字体与中文字形；不额外把 Inter 或自定义下载字体设为默认，也不把“看起来略有差异”直接归因于字体家族。

默认 UI / 代码字号分别由 `--ui-font-size` / `--code-font-size` 控制。支持范围为 UI 12–20px、代码 10–20px。用户选择的字体、字号继续有效；之前仅对已持久化的旧默认字体栈做过迁移，不能重置用户自定义字体。

### 排版层级

| 角色                 | 规则                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| 全局正文             | `body` 排版，默认 430 字重，`-webkit-font-smoothing: antialiased`                   |
| 通用小字号           | `text-sm = UI 字号 - 1px`，默认 13px，用于按钮、菜单及部分表单说明                  |
| 通用极小字号         | `text-xs = max(11px, UI 字号 - 2px)`，默认 12px                                     |
| 分组标题             | `section-label` 排版，通常辅助文字色，正常字距与大小写                              |
| 页面标题             | `settings-title` 排版，不扩大为营销页面式大标题                                     |
| 对话框标题           | `dialog-title` 排版，默认 18px                                                      |
| 对话框说明           | 通用小字号，辅助文字色，行高 1.6                                                    |
| 侧栏项目与主导航     | 跟随 UI 字号，默认 14px；普通行明确使用 normal / 400 字重，不强行将所有组件改为 430 |
| 输入框提示和输入内容 | 跟随 UI 字号，400 字重，行高 1.5                                                    |

层级主要依赖字号、颜色与留白。500 用于按钮和局部强调，600 用于标题；避免把整个界面都加粗。

### 模型选择器的独立排版

该控件为匹配参照使用固定的小型排版参数，继承 UI 字体家族，但其字号不全部随全局字号同比增长：

- 触发器、模型列表项：`model-label`，默认行高约 18.57px。
- 当前思考强度：`model-effort`，行高 21px，使用交互蓝色；Max 使用专用紫色。
- 当前模型名称：`model-name`，行高 16px，辅助文字色。
- 列表标题与 provider 分组名：12px、500、行高 16px，弱文字色。
- 思考强度标题采用 `16px / auto / 16px` 三列布局，文字放中列，箭头放右列，保证文字本身居中。
- 模型名称过长时单行省略，不能挤掉箭头、勾选标记或控件边距。

## Elevation

界面通过表面灰阶、轻边缘和少量阴影区分层级。圆角按角色分配，不能把所有容器都统一成同一个半径。

### 圆角尺度

frontmatter 的 `sm → 3xl` 对应 `--radius-sm → --radius-3xl`。当前语义别名：控件和普通导航行 `--radius-control = lg`；字段 `--radius-field = lg`；普通面板 `--radius-panel = xl`。菜单用 `2xl`，输入框用 `3xl`。模型列表项和模型触发器保留自己的 `md` 圆角。

### 普通菜单材质

`FloatingMenu` 的普通浮起模式、Popover、Select、DropdownMenu 和子菜单使用 `.desktop-menu-surface`。项目、分支、工作区与环境菜单不再单独覆盖它的背景、圆角和阴影。

```css
background: color-mix(in srgb, var(--popover) 90%, transparent);
border: 0;
border-radius: var(--radius-2xl);
box-shadow:
  0 0 0 0.5px var(--border),
  0 0 0 0.5px var(--border),
  0 8px 16px -4px rgb(0 0 0 / 0.12);
-webkit-backdrop-filter: blur(8px);
backdrop-filter: blur(8px);
```

两个 0.5px 边缘阴影对应当前实现的菜单 ring 与外缘层，不随意合并成 1px 实线边框。模型菜单采用相同结构，将表面和边缘变量换为 `--model-surface`、`--model-border`。

**背景模糊规则：** 只对背后的内容使用 `backdrop-filter`；不得对整个弹层使用 `filter: blur()`。90% 指背景颜色的 alpha，不能给整块菜单设置 `opacity: 0.9` 导致文字、图标一起变淡。

### 输入框材质

输入框本身没有 1px 实线边框。浅色模式使用表面颜色的 90%，深色模式使用不透明的 `--surface-panel`，两者都保留 `backdrop-filter: blur(16px)`（含 WebKit 前缀）。深色不透明背景下，模糊不一定可见。

```css
/* 浅色，常规视口 */
--shadow-composer: 0 0 0 1px #0000000a, 0 2px 8px 0 #0000000a, 0 4px 80px 8px #00000006;

/* 浅色，视口宽度不超过 639px */
--shadow-composer: 0 0 0 1px #0000000a, 0 2px 8px 0 #0000000a, 0 4px 40px 8px #00000006;

/* 深色 */
--shadow-composer: inset 0 0 1px 0 rgb(255 255 255 / 0.2);
```

不恢复旧的粗边框或聚焦时明显变深的整圈轮廓；内部 textarea 去掉自身背景、边框和阴影，防止输入框内又出现一层输入框。

### 普通面板与确认对话框

普通 `.surface-panel` 仍是实色表面、1px 轻边框及普通面板圆角；它不是菜单材质的别名。确认删除对话框仍采用清晰的实色内容面板，使用轻阴影：浅色 `0 4px 8px rgb(0 0 0 / 0.08)`，深色 `0 4px 8px rgb(0 0 0 / 0.24)`。遮罩使用 `modal-overlay`。

`/` 命令与 `@` 附件建议属于 `elevated={false}` 的平面建议面板，保留实色背景与无外部阴影，不自动改成普通浮起菜单。此例外是当前设计的一部分。

## Components

### 按钮、输入字段与开关

- 主按钮采用中性色背景和反色文字；outline 按钮为透明底、普通细边框；ghost 按钮默认透明，悬停才显出背景；link 按钮用链接色与悬停下划线。
- 按钮默认高 36px，左右内边距 16px，图标与文字间距 8px。带直接图标的默认按钮左右内边距 12px。`xs / sm / lg` 高度分别 24 / 32 / 40px，其圆角使用 8px；图标按钮尺寸按相同高度尺度处理。
- 常规按钮采用 150ms 颜色过渡。键盘焦点为 2px `--ring` 的 50% 环；禁用态透明度 50% 且不响应点击。
- 普通输入字段高 36px，左右内边距 12px、上下 4px，10px 圆角，1px `--input` 边框。默认使用正文大小，桌面 `md` 断点及以上使用通用小字号。焦点为蓝色边框与 2px、30% 蓝色环。
- 表单错误通过 `--destructive` 标识，禁用态不提供可点击假象。
- 默认开关宽 32px、高 1.15rem（默认根字号下约 18.4px），白色滑块直径 16px；小号宽 24px、高 14px、滑块直径 12px。开启使用 `--switch-on`，关闭使用 `--input`，保持原有语义与可访问标签。
- Lucide 图标为主，常用尺寸 14–16px；常见工具栏线宽约 1.75，强调勾选通常为 2。专用控件可有明确的局部尺寸，不引入另一套图标风格。

### 侧栏与设置

侧栏使用紧凑列表，分组标题、项目、会话和固定底部的设置入口形成清晰层级。普通行悬停使用主题悬停色，选中背景为侧栏文字色的 10% 透明混合。不得用较强分隔线或嵌套卡片替代层级。

设置页采用文案在左、控件在右的平直行结构。组标题与行文字对齐，行分隔线使用轻分隔色，最后一行不显示。无说明的紧凑行垂直居中，上下留白约 0.85rem。搜索、列表、滚动行为和宽度偏好不因样式更新被重置。

### 对话输入框

- 默认多行外壳采用输入框圆角与材质，左右与消息列对齐。
- textarea 至少两行，增长至十二行后启用内部滚动；上、左右内边距各 16px，下内边距 6px，行高 1.5。
- 底部工具栏内边距 `4px 10px 10px`，两侧工具组间距 8px，组内间距 4px。
- 项目 / 本地 / 分支栏在输入框上方，最小高度 32px，内边距 `6px 12px`；只圆顶部角，不添加整块面板的阴影。连接该栏时输入框顶部两个角改为 16px。
- 输入框下方停靠区保留画布底色；滚动时的渐隐只在下方还有内容时出现，不能覆盖最新回复或正在编辑的用户消息。
- Pix 当前保留多行输入框结构，未完整复刻 Codex 单行胶囊与多行之间的自适应形态切换。

### 模型选择器

#### 入口与面板

触发器顺序为模型名、弱色思考强度、向下箭头，间距 4px，最大宽度 256px。面板从触发器上方展开并右对齐，以 6px 为默认间距，靠近屏幕边界时自动限制位置或翻转。

面板外宽 254px，由 246px 内容区加左右各 4px 内边距组成。专用组件通过 `FloatingMenu surface="custom"` 提供自己的材质，不能再次叠加普通 `.surface-panel` 或通用阴影。内容区最大宽度受 `100vw - 24px` 约束。

#### 视图与操作

- 默认显示思考强度面板；点击居中的模型 / 强度标题切换为模型列表。没有当前模型时直接显示列表。
- 模型列表按 provider 分组，当前选择在右侧显示勾选。选中模型后回到思考强度页，面板保持打开。
- 列表项最小高 32px、内边距 `6px 8px`、圆角 8px。列表滚动区最大高 `min(316px, 70vh - 48px)`。
- 分组标题为透明背景的普通列表内容，不添加 sticky 实色遮罩或伪元素补色。
- 闪电按钮在标题左侧，尺寸 28px，圆角 8px；进入单独的请求优先级列表。优先状态用蓝色并填充图标，保留后端支持的 service tier 选项。
- 不支持思考强度的模型不显示无效滑杆；可用强度由模型数据决定，不强行补齐不存在的档位。
- 运行中禁用入口。保留原有模型选择数据、包含斜杠的模型 ID 与隐藏兼容字段。

#### 键盘和焦点

面板使用 dialog 语义，触发器提供名称、展开状态和关联。每个视图有明确的初始焦点；Tab / Shift+Tab 在可用控件中循环；列表支持上下方向键和 Home / End，左方向键返回强度页；Escape 关闭并将焦点交还入口。滑杆保持方向键操作，不能只支持鼠标拖动。

### 思考强度滑杆

| 部位         | 当前设计                                                              |
| ------------ | --------------------------------------------------------------------- |
| 外部容器     | 高 32px，水平外边距 2px，内边距 `2px 6px`                             |
| 滑杆根节点   | 高 28px，全宽，禁止原生触摸滚动干扰拖动                               |
| 胶囊轨道     | 高 24px，圆角 12px，溢出隐藏                                          |
| 未填充轨道   | 主文字色的 10% 透明混合，叠加 `inset 0 0 0 0.5px var(--model-border)` |
| 已填充轨道   | `--model-text-accent`，左侧两个角为 12px，右侧与滑块连接              |
| 灰色刻度     | 直径 4px，弱文字色再乘 50% alpha；默认主题等效约 25% alpha            |
| 已经过的刻度 | 白色 30% alpha；仍由实际选中位置控制                                  |
| 刻度悬停     | 放大至两倍，亮度 0.85，隐形命中范围向外扩 6px                         |
| 白色滑块     | 直径 28px、0.5px 较强边框、`0 0 2px rgb(0 0 0 / 0.1)` 阴影            |
| 滑块悬停     | `scale(1.142857)`，视觉直径约 32px；隐形命中范围向外扩 3px            |
| 拖动指针     | 正常为 grab，按下为 grabbing                                          |
| 焦点         | 2px 蓝色 outline，offset 为 -2px                                      |
| 禁用         | 整体透明度 60%，滑块与刻度禁用指针交互                                |

档位离散分布，填充长度跟随滑块中心，处理中间档位的滑块半径补偿，避免轨道与滑块脱节。不显示永久可见的两端强度文案。

### 确认删除与通用对话框

确认删除采用 Radix AlertDialog，内容放在 `display: flex; align-items: center; justify-content: center` 的全屏遮罩内，用布局居中。内容保持 `position: relative`，**不使用 `translate(-50%, -50%)`，也不使用缩放或内容模糊**。

内容面板圆角 12px、1px 普通边框、内边距 24px、内容间距 16px，最大高 `100dvh - 48px`，内部可滚动。默认桌面最大宽 512px，小号最大宽 320px，窄屏由外层 16px 内边距避让。遮罩与内容仅做 150ms ease-out 淡入淡出。

本次清晰度修复针对 AlertDialog；通用 `Dialog` 目前仍有基于平移的居中实现。不能把“确认删除已避免平移”误写成所有对话框均已修改。普通 Dialog 和皮肤专用对话框保留各自实现，后续如需调整须另行核验。

### 浮层定位与层级

`FloatingMenu` portal 到 `document.body`，使用固定坐标定位，避免被输入框或侧栏的 overflow、sticky、transform 祖先裁剪。默认最小宽 200px，最大宽 `min(视口宽度 - 16px, 28rem)`，最大高 `min(70vh, 480px)`，屏幕四边保留至少 8px。

默认顶部间距 6px，其他方向 4px；内容尺寸变化后重新测量。保留点击外部、Escape、滚动和窗口变化时的关闭行为。默认 FloatingMenu 层级为 10000，模态遮罩和内容为 11000，模态内 Select 的默认层级为 12000；局部菜单可能有显式覆盖，新增弹层必须检查实际容器层级，不能只机械沿用 z-index。

### 动态与未完成差异

| 当前运动                      | 参数                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| 普通按钮 / 导航颜色           | 通常 150ms                                                      |
| Radix 菜单 / Popover / Select | 现有 150ms 淡入淡出与按方向滑入                                 |
| 确认删除                      | 150ms ease-out，仅 opacity                                      |
| 侧栏折叠                      | 360ms，`cubic-bezier(0.3, 1.2, 0.4, 1)`                         |
| 滑轨填充与滑块位置            | 300ms，`cubic-bezier(0.23, 1, 0.32, 1)`；按下操作时缩短为 150ms |
| 滑块悬停缩放                  | 300ms，`cubic-bezier(0.34, 1.56, 0.64, 1)`                      |
| 刻度                          | transform 120ms、颜色 300ms、透明度 400ms                       |

所有上述运动尊重 `prefers-reduced-motion: reduce`：滑杆直接取消过渡，全局动画与过渡压缩至近乎即时，并关闭平滑滚动。

**尚未复刻：** Codex 的真实弹簧物理、模型面板视图切换时完整的尺寸 / 平移过渡、Max shader / 粒子和快速模式动态特效。现有 CSS 缓动仅是 Pix 的实现，不等价于完整 Codex 动画。状态颜色、布局和静态材质已按本文件记录调整；本文件不将未实现效果写成已完成规范。

## Do's and Don'ts

### Do

- **Do** 复用语义变量、共用组件和明确的组件例外；需要新的样式时先检查现有角色。
- **Do** 保留默认主题与自定义皮肤、系统字体与自定义字体、明暗模式的独立性。
- **Do** 用背景 alpha 实现半透明，用 backdrop-filter 模糊背后内容，保持文字和图标清晰。
- **Do** 为模型控件保留独立字号和几何参数，为普通菜单复用同一材质。
- **Do** 检查长模型名、provider 分组、无思考支持、禁用态、键盘焦点、窄窗口和大字号。
- **Do** 让设置入口固定在侧栏滚动列表下方，让消息与输入框共用水平边界。
- **Do** 按实际状态区分“已实现”“专用例外”“尚未复刻”，修改实现时同步维护本文件。

### Don't

- **Don't** 使用 PRODUCT.md 明确反对的 “decorative cards, prominent branding, and heavy separators in navigation”。
- **Don't** 把所有圆角都改成 12px，或把每个表面都套上菜单的玻璃材质。
- **Don't** 在普通菜单调用处重新加入不透明底色、旧圆角、重复边框和重阴影覆盖。
- **Don't** 让模型选择器、开关、链接和默认焦点分别使用不同的旧蓝色。
- **Don't** 给整个菜单设置 90% opacity，或对文字所在内容层使用 blur / 缩放来模拟磨砂。
- **Don't** 给确认删除重新加回平移居中或缩放动画，破坏已完成的清晰度修复。
- **Don't** 通过更改用户偏好来“修复”字号、缩放、侧栏宽度或皮肤造成的差异。
- **Don't** 根据被缩小的截图推断字体模糊原因，或未经同尺度验证就声称与 Codex 像素级完全一致。

### 已有验证与后续验收基线

此前样式实现已完成浅色、深色、自定义皮肤、UI 20px 大字号及 400px 宽浏览器组件检查；普通菜单边界、背景透明度、模糊、圆角和蓝色已读取计算样式核验。确认删除示例的 `filter`、`transform`、`backdrop-filter` 均为 none。

本机 Tauri Pix 已构建并查看主会话和设置页，相关格式、类型检查及前端 / 桌面构建通过。400px 检查是组件预览，不等于整个原生应用的最小窗口验收；Codex 的当前窗口设置与完整动态效果没有逐像素比对。

后续改动至少复查受影响的浅深色、皮肤覆盖、字体偏好、菜单边界、键盘操作与 reduced-motion；只新增文档时不必重新构建前端。
