# Windows 使用说明

Pix 使用 pi SDK 0.85.1。聊天会话在没有自定义 `defaultTools` 时，默认启用 `read`、`powershell`、`edit`、`write`、`ls`、`find` 和 `grep`。模型执行 PowerShell 命令不需要 Git Bash；列目录也可以直接使用 `ls`。

## PowerShell 和路径

原生命令工具优先使用 `pwsh.exe`，没有时回退到 `powershell.exe`。Pix 从开始菜单启动时，会在自身进程环境中补充已经存在的 PowerShell 7、系统 PowerShell、System32、npm、WinGet、Scoop 和 Git 的 `cmd` 目录。系统和用户目录按环境变量解析，支持系统不在 C 盘和用户目录重定向。

这些补充不会修改 Windows 的全局 PATH。应用会合并 `PATH` / `Path`，去除带引号、大小写或尾部分隔符导致的重复项。Git 的 Unix 工具目录不会加入前置路径，避免覆盖 Windows 同名命令。

项目的“打开方式”菜单会显示已找到的 PowerShell 7、Windows PowerShell、Windows Terminal 和 CMD。终端直接从检测到的程序启动，工作目录支持中文、空格、单引号、方括号及 `&`；打开请求在进程启动后结束，无须等终端关闭。

在聊天中可以要求执行：

```powershell
$PSVersionTable.PSVersion
Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Desktop'))
```

## 中文输出

pi 原生 PowerShell 工具设置 UTF-8 输出。Pix 在 Windows 子进程环境中补充 `PYTHONUTF8=1` 和 `PYTHONIOENCODING=utf-8`，让 Python 的默认文本编码及重定向输出使用 UTF-8；已有的显式编码设置优先。

读取已有的旧编码文件时，仍需按文件实际编码指定参数。以上处理不会转码现有文件，也不会修改系统区域设置或 PowerShell profile。

## npm 和全局 pi

Pix 的内置 SDK 无须全局安装 pi。在设置中主动选择全局 pi 时，Windows 的 npm/pi 探测和安装会通过对应 JavaScript 入口与 Node 执行，避免直接执行 `.cmd` 失败，也避免路径或参数被额外的 CMD 解释。

pi 入口根据所安装包的 `package.json` 解析，支持新版 `dist/bundle/cli.js`。非标准、无法定位入口的启动脚本会返回说明，此时可选择内置 SDK。

## 自定义工具和终端模式

用户已有的 `defaultTools`、显式工具限制和扩展工具继续生效。Pix 的聊天默认值不会写回用户配置。

独立 pi CLI 和内嵌 pi TUI 读取自己的 pi 配置。如果也要让它们默认使用 PowerShell，可在 Windows 电脑的 `%USERPROFILE%\.pi\agent\settings.json` 中合并以下字段，保留已有的模型、插件和其他字段；设置了 `PI_CODING_AGENT_DIR` 时以该目录为准。

```json
{
  "defaultTools": ["read", "powershell", "edit", "write", "ls", "find", "grep"]
}
```

`shellPath` 控制的是 Bash 入口，不能代替 `defaultTools`。`!`、`!!` 手动命令仍走 Bash。插件自己的角色工具列表独立生效，Pix 不自动重写这些列表。

本轮保留现有上下文管理、MCP、权限、通知及其他插件方案，不安装经验帖中的个人插件组合。

## 验证

Windows CI 覆盖原生 PowerShell 执行、系统 PowerShell 回退、中文输出、错误退出码、空 PATH 恢复、Node CLI 参数传递，以及外部终端的启动参数和生命周期。macOS/Linux 测试会跳过必须在 Windows 上执行的用例。

开发版修改后需要重启应用；安装版需要重新构建、打包和安装。

参考：[Pi Windows 工作流第四版](https://linux.do/t/topic/2860399)、[pi Windows 文档](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/windows.md)、[Node 子进程文档](https://nodejs.org/api/child_process.html)、[Python 环境变量文档](https://docs.python.org/3/using/cmdline.html#envvar-PYTHONUTF8)。
