# WeChat Claude Code Bridge — Enhanced

<p align="center">
  <strong>在微信中与本地 Claude Code 对话，并获得更强大的会话管理能力</strong>
</p>

<p align="center">
  <a href="https://github.com/Wechat-ggGitHub/wechat-claude-code"><img src="https://img.shields.io/badge/基于-wechat--claude--code-orange?style=flat-square" alt="Based on wechat-claude-code"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
</p>

本项目基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 的源代码进行增强。在保留原有全部功能的基础上，新增了历史对话恢复、原生上下文压缩、权限审批转发、选择题转发、模型别名、思考强度调节、Advisor 模型、目标驱动循环、定时任务、Workspace 配置、双向文件互传、语音输入、快捷指令等功能。

人在外面、手边只有手机时，也能用微信指挥本地的 Claude Code 干活。

---

## 安装

macOS / Linux:

```bash
git clone https://github.com/UnknownJackMe/wechat-claude-code-enhanced.git ~/.claude/skills/wechat-claude-code
cd ~/.claude/skills/wechat-claude-code && npm install
```

Windows PowerShell:

```powershell
git clone -b windows_version https://github.com/UnknownJackMe/wechat-claude-code-enhanced.git $HOME\.claude\skills\wechat-claude-code
cd $HOME\.claude\skills\wechat-claude-code
npm install
```

首次扫码绑定与 daemon 管理：

```bash
npm run setup                # 首次扫码绑定微信
npm run daemon -- start      # 启动守护进程（开机自启，崩溃自动重启）
npm run daemon -- status     # 查看运行状态
npm run daemon -- restart    # 重启（更新代码后用）
npm run daemon -- logs       # 查看日志
```

Windows 上 `npm run daemon -- start` 会自动创建计划任务并启动隐藏后台进程；`stop` 会同时停止进程并删除开机自启任务。

### 可选：语音输入依赖

macOS（Apple Silicon）:

```bash
pip install pilk
brew install ffmpeg
pip install mlx-whisper
```

Windows / Linux:

```bash
pip install pilk faster-whisper
ffmpeg -version
```

如果想直接在微信发语音让 Claude 听懂，需要本地转录工具链：

- `pilk` / `pysilk`：微信 SILK 语音编解码
- `ffmpeg`：音频封装
- `mlx-whisper`：macOS Apple Silicon 默认后端
- `faster-whisper`：Windows / Linux 默认后端

不装也不影响文字/图片/文件功能，只是发语音时会降级为”无法识别，请重发或直接打字”。

> **Windows 用户**：语音识别的详细安装步骤请参考 [Windows 语音识别模块安装指南](docs/VOICE_SETUP_WINDOWS.md)。

---

## 命令总览
```
━━━ 会话管理 ━━━
/help               显示帮助
/status             查看当前会话状态
/clear              清除当前会话（保留目录/模型设置）
/reset              完全重置（恢复所有默认设置）
/stop               停止当前对话并清空排队消息
/compact            压缩上下文（保持 session ID）
/history [数量]     查看对话记录（默认 20 条）
/undo [数量]        撤销最近对话（默认 1 条）

━━━ 对话恢复 ━━━
/resume             列出当前目录的历史对话
/resume <编号>      恢复指定编号的历史对话
/resume <uuid>      通过 session ID 恢复

━━━ 模型与权限 ━━━
/model [别名/名称]  查看或切换模型（切换前自动验证可用性）
/model-config       列出所有模型别名
/model-config <别名> <完整ID>  添加/更新别名
/model-config del <别名>       删除别名
/mode [bypass|accept] 权限模式：全自动 / 逐个 y/n 确认
/effort [级别]      思考强度（low/medium/high/xhigh/max）
/advisor [模型]     Advisor 模型（opus/sonnet/fable/off）

━━━ 任务控制 ━━━
/q                  列出所有快捷指令
/q <名字>           执行快捷指令
/q set <名字> <内容> 添加/更新快捷指令
/q del <名字>        删除快捷指令
/goal [条件]        设置目标，Claude 持续工作直到完成
/goal clear         清除当前目标
/loop <间隔> <提示> 定时循环，例: /loop 5m 检查 CI
/loop               列出所有运行中的 loop
/loop stop <id>     停止指定 loop
/loop stop all      停止所有 loop

━━━ Workspace 配置 ━━━
/configs                  列出所有 workspace 配置
/set-config <编号>        向导式创建/编辑配置
/switch-config <编号>     一键切换（目录+模型+session）
/delete-config <编号>     删除配置

━━━ 文件与工具 ━━━
/cwd [路径]         查看或切换工作目录
/prompt [内容]      查看或设置系统提示词
/send-me <路径>     发送本地文件给你（支持多路径、目录）
/send-you           开始接收你发来的文件/图片
/send-you-end [要求] 结束接收，将文件+图片发给 Claude
/send-you-cancel    取消文件接收
/skills [full]      列出已安装的 skill
/version            查看版本信息
```

此外，**直接发文字/语音/图片/文件**即可与 Claude Code 对话；Claude 提出的选择题和需要确认的操作也会自动推送到微信（见下文）。

---

## 命令使用方法

### `/resume` — 历史对话恢复

直接在微信中浏览和恢复历史对话，无需手动查找 session ID。

- `/resume` — 列出当前目录最近 15 条历史对话，显示自定义名称（`/rename` 设置的）或首条用户消息
- `/resume 2` — 恢复列表中第 2 条对话
- `/resume <uuid>` — 通过完整 session ID 恢复

显示逻辑与 Claude Code 终端内的 `/resume` 选择器保持一致：优先显示 `/rename` 设置的自定义标题，其次是第一条真实用户消息。同时支持只有单个 session 的目录（原版会报"没有历史对话"）。

---

### `/compact` — 原生上下文压缩

原版 `/compact` 只是清除 session ID（等同于 `/clear`）。本增强版调用 `claude -p /compact --resume <sessionId>`，触发 Claude Code 的**原生压缩机制**：

- 对话在原 session 内被总结压缩，**session ID 保持不变**
- token 用量大幅下降（实测：177k → 7k tokens，减少约 96%）
- 压缩完成后推送到微信，显示压缩前后 token 数量

---

### `/mode` — 权限审批模式

控制 Claude 执行工具（运行命令、改文件等）时是否需要你确认。守护进程始终以 `--dangerously-skip-permissions` 启动，由 `/mode` 在两种行为间切换：

```
/mode          — 查看当前模式
/mode bypass   — 全自动，不再询问（默认）
/mode accept   — 每个操作推送到微信，回复 y 批准 / n 拒绝
```

`accept` 模式下，Claude 每次要用工具，会把工具名 + 命令/文件推送到微信，例如：

```
🔐 需要你确认操作

工具: Bash
命令:
  git push origin main

回复 y 批准 / n 拒绝（30 秒内有效）
```

回复 `y`/`n`（或 `是`/`否`）即可。30 秒未回复自动拒绝；审批等待期间发 `/stop` 会中止当前操作。技术上通过 `--permission-prompt-tool stdio` 的 `control_request`/`control_response` 协议实现，CLI 在等待期间阻塞，不会误执行。

---

### 选择题转发（AskUserQuestion）

当 Claude 需要你在几个方案之间做选择时（调用 AskUserQuestion 工具），选项会自动推送到微信，例如：

```
🤔 需要你做个选择

用哪种语言构建这个项目？
1. Python — 适合数据处理、AI/ML
2. Go — 适合高性能服务、并发
3. TypeScript — 适合全栈 Web

回复选项编号即可（5 分钟内有效）。也可直接打字回答。
```

回复编号（`2`）、多选用逗号（`1,3`）、或直接打字回答都可以。这个功能在任意权限模式下都生效，无需额外开启。底层复用权限审批的 stdio 协议，把你的选择作为工具结果回传给 Claude。

---

### `/model` 与 `/model-config` — 模型切换与别名

`/model <名称>` 切换模型，切换前会用一个极短的探测请求**实际验证模型可用性**再提交。验证失败会告诉你具体原因——模型名无效、认证/欠费、网络不可达、限流等——并保持原模型不变。这避免了输入无效模型导致守护进程静默卡死。

每次输入完整 model ID 很麻烦，`/model-config` 让你绑定短别名：

```
/model-config                                          — 列出所有别名
/model-config sonnet claude-sonnet-4-6-thinking[1m]   — 添加/更新别名
/model-config del sonnet                               — 删除别名
/model-config sonnet                                   — 查看单个别名
```

配置好后直接 `/model sonnet` 即可，切换时显示别名展开结果：

```
✅ 模型已切换为: claude-sonnet-4-6-thinking[1m]
（别名 "sonnet" → claude-sonnet-4-6-thinking[1m]）
```

别名持久化存储在 `~/.wechat-claude-code/model-aliases.json`，daemon 重启后保留。

---

### `/effort` — 思考强度调节

调整 Claude 的推理深度，在速度与质量之间按需切换。

- `/effort` — 查看当前级别和可选项
- `/effort xhigh` — 切换到指定级别
- 支持：`low` / `medium` / `high` / `xhigh` / `max`

---

### `/advisor` — Advisor 模型

为主模型配置一个更强的顾问模型，在关键决策点自动介入（需要 Claude Code v2.1.170+）。

- `/advisor opus` — 启用 Opus 作为顾问
- `/advisor off` — 关闭
- 支持：`opus` / `sonnet` / `fable` / 完整 model ID

---

### `/goal` — 目标驱动循环

让 Claude 持续工作直到满足指定条件。

- `/goal 所有单元测试通过且 lint 干净` — 设置目标，Claude 自动循环
- `/goal` — 查看当前目标状态
- `/goal clear` — 提前终止

---

### `/loop` — 定时循环任务

在 wechat bot 进程内实现定时任务，结果自动推送到微信。

- `/loop 5m 检查 CI 是否通过` — 每 5 分钟执行一次
- `/loop` — 查看所有运行中的 loop
- `/loop stop <id>` — 停止指定 loop

支持间隔：`30s`（最小提升至 1 分钟）/ `5m` / `2h` / `1d`。Loop 持久化，daemon 重启后自动恢复，7 天自动过期。

---

### Workspace 配置（`/configs` 等）

针对多项目场景，一键切换目录、模型、思考强度和历史对话。

- `/set-config 0` — 向导式创建配置（分步输入名称、目录、模型、session ID）
- `/configs` — 列出所有配置
- `/switch-config 0` — 一键切换
- `/delete-config 0` — 删除配置

`/status` 会显示当前是否处于某个 workspace 配置中，所有字段分行清晰展示。

---

### 文件互传 — `/send-me` 与 `/send-you`

双向文件传输，支持多图片、多文件混合。

**`/send-me` — Claude 发文件给你**

- `/send-me ~/Documents/report.pdf` — 推送单个文件到微信
- `/send-me ./chart.png ./data.csv` — 一次推送多个
- `/send-me ~/Desktop/output/` — 推送整个目录内的可发送文件

此外，Claude 在回复中提到的本地文件路径会被自动识别并推送到微信，无需手动 `/send-me`。

**`/send-you` — 你发文件/图片给 Claude**

- `/send-you` — 进入接收模式
- 接着发送任意数量的图片和文件（可分多条消息发送）
- `/send-you-end 这两张图有什么区别？` — 结束接收，把所有文件连同要求一起交给 Claude
- `/send-you-cancel` — 取消本次接收

关键点：图片以 base64 图像块的形式直接传给 Claude，**Claude 能真正"看到"图片内容**（而非仅收到一个本地路径）；文件则会被自动用 Read 工具读取。底层通过 `claude -p --input-format stream-json` 实现，修复了 `-p` 模式下 `file://` markdown 图片不可见的问题。

---

### 语音输入 — 本地模型转文字

直接在微信里发语音，自动转成文字交给 Claude。人在外面不方便打字时尤其好用。

- 收到语音 → 本地转录 → 先回显 `🎤 识别为：...` → 再作为文字发给 Claude
- 全程**本地运行**，语音内容不经过第三方云服务

技术实现：微信语音是腾讯 SILK v3 格式（ffmpeg 不支持），处理链路为
`下载解密 → pilk 解码成 PCM → ffmpeg 封装 wav → whisper 后端转录`。
macOS 默认用 `mlx_whisper` + `mlx-community/whisper-large-v3-mlx`；Windows / Linux 默认用 `faster-whisper`。所有外部程序都会先探测 PATH，再补常见安装路径，兼容 daemon 环境与交互式终端 PATH 不一致的情况。

依赖安装见上文「安装 → 可选：语音输入依赖」。

---

### `/q` — 快捷指令 / 常用语

把常用需求存成短指令，一句话触发，省去重复打字。

```
/q                       — 列出所有快捷指令
/q set test 运行所有测试并报告结果   — 添加/更新
/q test                  — 执行（把存的内容作为 prompt 发给 Claude）
/q del test              — 删除
```

支持附加参数：`/q test --verbose` 会把 `--verbose` 拼到指令内容后面。数据存储在 `~/.wechat-claude-code/quick-commands.json`。

---

## 交流社群

如果有任何问题、使用反馈，或者想和大家一起交流，欢迎扫码加我微信进群。

> 添加时请备注 **wechat-claude code**，方便我识别。

<p align="center">
  <img src="assets/wechat-qr.jpg" width="220" alt="微信二维码" />
</p>

## 致谢

本项目基于 [wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)（MIT License）进行二次开发，感谢原作者的出色工作。

## License

MIT
