# Windows 适配指南（WINDOWS_PORTING.md）

> 给 Windows 端的 Claude Code：本文档是你做 Windows 适配的**唯一入口**。先完整读一遍，再读文中点名的源码文件，然后按「任务清单」逐项实现。每完成一项就用 `npm run build` 验证编译通过。

## 0. 背景与目标

这是一个把微信消息桥接到本地 Claude Code 的 daemon。目前完整支持 **macOS（launchd）** 和 **Linux（systemd）**，但**完全没有 Windows 支持**。

你的任务：让这个项目在 Windows 上能跑起来，**所有功能对齐 macOS**，包括：守护进程、文字/图片/文件双向收发、语音转文字、权限审批、选择题转发、全部斜杠命令。

核心原则：
- **不破坏现有 macOS/Linux 行为**。所有改动用 `process.platform === 'win32'` 分支隔离，或用跨平台 API 替换平台特定调用。
- **业务逻辑层（命令、会话、微信协议、CDN 加解密）本身已经跨平台**，用的是 Node 内置 API。Windows 适配的工作量集中在**进程管理、外部程序路径、守护进程**这三块。
- 改完每一项都要 `npm run build`（即 `tsc`）通过。

## 1. 技术栈与架构

- **语言**：TypeScript（ESM，`"type": "module"`），编译目标 Node.js。
- **运行**：`node dist/main.js start` 启动 daemon，长驻轮询微信消息。
- **入口**：`src/main.ts`（CLI 分发 `setup` / `start`）。
- **关键模块**：
  - `src/main.ts` — daemon 主循环、消息处理、审批/选择题状态机、流式回复
  - `src/claude/provider.ts` — spawn `claude` CLI，stream-json 双向通信
  - `src/wechat/` — 微信 iLink API、CDN 上传下载、AES 解密、媒体、语音转录
  - `src/commands/` — 斜杠命令路由与处理
  - `src/store.ts` `src/session.ts` `src/*-config.ts` — JSON 持久化
  - `scripts/daemon.sh` — 守护进程管理（**仅 bash，Windows 不可用**）

## 2. 已跨平台、无需改动的部分

先确认这些**不用动**，避免你白费功夫：

- **微信协议 / CDN 加解密**：`src/wechat/crypto.ts` 用 Node 内置 `crypto`（`aes-128-ecb`），`src/wechat/api.ts` 用 `fetch`，全部跨平台。
- **JSON 持久化**：`src/store.ts` 的原子写（temp + rename）、文件锁（mkdir）都是跨平台 API。注意 `chmodSync` 已用 `if (process.platform !== 'win32')` 包裹（`store.ts`、`config.ts`），Windows 会跳过，正确。
- **路径处理**：`src/commands/handlers.ts:403` 的路径分隔符已用 `process.platform === 'win32' ? '\\' : '/'` 判断。
- **打开文件**：`src/main.ts` 的 `openFile()` 已有 `win32` 分支（`cmd /c start`）。
- **命令/会话/审批/选择题逻辑**：纯 JS，跨平台。

## 3. 必须改的部分（按文件）

下面每一处都点名了文件、现状、问题、改法。**先读源码确认行号（可能因后续提交变动），再改。**

### 3.1 守护进程 — 最大的工作量

**现状**：`package.json` 的 `daemon` 脚本是 `bash scripts/daemon.sh`，而 `daemon.sh` 只有 `Darwin`（launchd）和 `Linux`（systemd）两个分支，遇到其他平台直接报错退出。Windows 上没有 bash（除非装了 Git Bash/WSL，但不能假设）。

**目标**：Windows 上能 `start / stop / restart / status / logs`，并支持开机自启 + 崩溃自动重启。

**推荐方案**：新建 `scripts/daemon.ps1`（PowerShell），并改 `package.json` 让 `daemon` 命令按平台分发。

Windows 守护进程有三种实现路径，**按优先级**：

1. **计划任务（Task Scheduler）+ 后台进程**（推荐，无需管理员、无需第三方依赖）
   - `start`：用 `schtasks /create` 注册一个登录时启动的任务，运行 `node dist/main.js start`；同时立即 `Start-Process -WindowStyle Hidden` 拉起进程，PID 写入 `%USERPROFILE%\.wechat-claude-code\daemon.pid`。
   - 崩溃自动重启：计划任务本身不重启进程，需要一个轻量 wrapper（见下）。
2. **nohup 等价的后台进程**（最简单的兜底，对齐 Linux 的 direct 模式）
   - 用 `Start-Process node -ArgumentList 'dist/main.js','start' -WindowStyle Hidden -RedirectStandardOutput ... -RedirectStandardError ...`，PID 落盘。
   - `stop`：读 PID，`Stop-Process`。`status`：`Get-Process -Id`。
3. **NSSM / WinSW**（需要额外可执行文件，不推荐作为默认，可作为文档里的进阶选项）

**建议实现**：先做方案 2（direct 模式，保证能用），再叠加方案 1 的计划任务做开机自启。崩溃重启用一个 PowerShell wrapper 循环：

```powershell
# 伪代码思路：wrapper 循环拉起，退出非 0 就重启
while ($true) {
  node dist/main.js start
  if ($LASTEXITCODE -eq 0) { break }   # 正常退出（被 stop）则不再拉起
  Start-Sleep -Seconds 10
}
```

把 wrapper 注册为计划任务，即可同时拿到「开机自启」+「崩溃重启」。

**package.json 改法**：`daemon` 脚本不能再写死 `bash`。改成一个跨平台分发器，例如新增 `scripts/daemon.mjs`（Node 写的，天然跨平台），由它检测 `process.platform` 再调用 `daemon.sh`（Unix）或 `daemon.ps1`（Windows）：

```json
"daemon": "node scripts/daemon.mjs"
```

`daemon.mjs` 里：`win32` → `spawnSync('powershell', ['-ExecutionPolicy','Bypass','-File','scripts/daemon.ps1', ...args])`；否则 → `spawnSync('bash', ['scripts/daemon.sh', ...args])`。这样三个平台统一入口，且不破坏现有 Unix 行为。

**日志路径**：daemon.sh 用 `${HOME}/.wechat-claude-code/logs`。Windows 上 `HOME` 可能未设，要用 `%USERPROFILE%`。Node 侧 `os.homedir()` 已经跨平台正确（见 4.1），但 PowerShell 脚本里要用 `$env:USERPROFILE`。

### 3.2 语音转文字 — 二进制路径与依赖

**现状**：`src/wechat/voice-transcribe.ts` 的 `findPython` / `findMlxWhisper` / `findFfmpeg` 探测的候选路径全是 Unix 路径（`/opt/homebrew/bin`、`~/miniforge3/bin`、`/usr/bin`），且 `mlx_whisper` 是 **Apple Silicon 专属**（MLX 框架只在 Mac 上）。

**问题**：
- Windows 没有这些路径，三个 `find*` 会全部返回 null → 语音功能不可用（但有降级提示，不崩溃）。
- `mlx_whisper` 在 Windows 根本装不了。

**改法**：
1. **找二进制**：给每个 `find*` 的候选列表加 Windows 路径。Windows 上更靠谱的做法是**依赖 PATH** —— 直接探测 `python`、`ffmpeg`、`whisper`/`faster-whisper` 这些命令名（`resolveBinary` 已经支持传命令名，靠 PATH 解析）。补充候选示例：
   - python：`python`、`python3`、`%LOCALAPPDATA%\Programs\Python\Python3xx\python.exe`、`%USERPROFILE%\miniforge3\python.exe`、`%USERPROFILE%\anaconda3\python.exe`
   - ffmpeg：`ffmpeg`（PATH）、`C:\ffmpeg\bin\ffmpeg.exe`、scoop/choco 安装路径
2. **whisper 引擎换成跨平台的**：Windows 上没有 MLX。用 **`faster-whisper`**（CTranslate2，CPU/CUDA 都行，跨平台）或 **openai-whisper**（纯 PyTorch）替代 `mlx_whisper`。
   - 建议在 voice-transcribe.ts 里抽象一个「转录后端」：macOS 用 `mlx_whisper`，Windows/Linux 用 `faster-whisper`（命令行 `faster-whisper` 或 `python -m faster_whisper`）。用 `process.platform` 选默认后端，也可在 config 里覆盖。
   - SILK 解码的 `pilk` 是纯 Python 包，**跨平台可用**，不用换。
   - `ffmpeg` 跨平台可用，不用换。
3. **路径分隔**：`resolveBinary` 候选里如果硬写路径，Windows 用 `\` 且带 `.exe`。优先用 `join(homedir(), ...)` + 命令名靠 PATH，少写死绝对路径。

> 提示：语音是「锦上添花」功能，若 Windows 上短期难以配齐 whisper，可先保证「探测不到 → 友好降级提示」正常工作（现有逻辑已具备），把完整转录作为第二步。

### 3.3 `claude` CLI 的 spawn

**现状**：`src/claude/provider.ts` 多处 `spawn('claude', ...)` / `spawnSync('claude', ...)`。

**问题**：Windows 上 `claude` 通常是 `claude.cmd` 或 `claude.ps1`（npm 全局包的 shim）。直接 `spawn('claude')` 在 Windows 上**可能找不到**，因为 Node 的 `spawn` 默认不走 shell、不解析 `.cmd`。

**改法**：
- 给所有 spawn `claude` 的地方，在 Windows 下加 `shell: true`（让系统解析 `claude.cmd`），或显式探测 `claude.cmd` 的完整路径。
- 推荐封装一个 `resolveClaudeBin()`：Windows 探测 `claude.cmd`/`claude.exe`（用 `where claude`），其他平台用 `claude`。或者统一在 spawn options 里 `shell: process.platform === 'win32'`。
- **注意**：`shell: true` + 用户可控参数有命令注入风险。这里 spawn 的参数（prompt、model 等）虽然来自内部，但 prompt 经 stream-json 走 stdin 不进命令行，model/effort 等是受控值，风险低。仍建议优先用「显式 .cmd 路径 + 不开 shell」的方式。验证 stream-json 的 stdin 双向通信在 Windows 上正常（这是权限审批/选择题的命脉）。

### 3.4 临时目录与文件路径

**现状**：`tmpdir()`（`os.tmpdir()`）已跨平台，`join()` 已跨平台 —— 这些**没问题**。

**要检查**：
- `src/wechat/send.ts:138` 有 `filePath.replace(/^~/, process.env.HOME || '')`。Windows 上 `~` 不是家目录约定，且 `process.env.HOME` 在 Windows 常为空（应是 `USERPROFILE`）。改为 `os.homedir()`，并且 Windows 用户一般不会输 `~`，但要保证 `process.env.HOME || ''` 不会把路径拼坏。统一用 `homedir()`。
- 全局搜索 `process.env.HOME`，凡是用到的都换成 `os.homedir()`（跨平台）。

### 3.5 shebang 与可执行权限

**现状**：`src/main.ts:1` 和 `src/tools/visualize-logs.ts:1` 有 `#!/usr/bin/env node`，`package.json` 有 `bin` 字段。

**说明**：shebang 在 Windows 被忽略，npm 在 Windows 安装 `bin` 时会自动生成 `.cmd` shim，所以**通常不用改**。但要验证 `npm link` / 全局安装后 `wechat-claude` 命令在 Windows PowerShell/CMD 里能调起来。

## 4. 跨平台 API 对照表

| 用途 | 不要用 | 用 |
|---|---|---|
| 家目录 | `process.env.HOME` | `os.homedir()` |
| 临时目录 | 写死 `/tmp` | `os.tmpdir()` |
| 路径拼接 | 字符串拼 `/` | `path.join()` |
| 路径分隔符 | 写死 `/` 或 `\` | `path.sep` / `path.delimiter` |
| 打开文件 | `open` | 已封装 `openFile()`（含 win32 分支） |
| spawn claude | `spawn('claude')` 裸调 | win32 下 `.cmd` 路径或 `shell: true` |
| 守护进程 | launchd/systemd | 计划任务 + PowerShell wrapper |

## 5. 任务清单（按顺序做，每步 build 验证）

- [ ] **T1 基础设施**：全局搜 `process.env.HOME` → 换 `os.homedir()`；确认 `tmpdir()`/`join()` 用法无写死分隔符。`npm run build`。
- [ ] **T2 claude spawn**：封装 `resolveClaudeBin()` 或加 `shell: process.platform==='win32'`，让 `provider.ts` 在 Windows 能 spawn claude。手动验证 `node dist/main.js start` 能起来、发一条消息能拿到 Claude 回复（stream-json 双向通信正常）。
- [ ] **T3 守护进程**：新建 `scripts/daemon.ps1` + `scripts/daemon.mjs` 分发器，改 `package.json` 的 `daemon` 脚本。实现 `start/stop/restart/status/logs`，先做 direct 后台模式，再加计划任务开机自启 + 崩溃重启。
- [ ] **T4 语音（可降级）**：voice-transcribe.ts 加 Windows 二进制候选路径；抽象转录后端，Windows 用 `faster-whisper`。若暂不配齐，先确保探测失败时的降级提示正常。
- [ ] **T5 端到端验证**：在 Windows 上跑完整流程 —— setup 扫码绑定 → daemon 启动 → 文字对话 → 图片/文件收发 → /mode accept 审批 → 选择题转发 → 各斜杠命令。逐项对照 macOS 行为。
- [ ] **T6 文档**：更新 README 的「安装」章节，加 Windows 分支说明（依赖、daemon 命令、语音引擎差异）。

## 6. 验证清单（功能对齐 macOS）

每项在 Windows 实测通过才算完成：

- [ ] `npm install` + `npm run build` 无错误
- [ ] `npm run setup` 弹出二维码图片（`openFile` 的 win32 分支）、扫码绑定成功
- [ ] `npm run daemon start` 启动，`status` 显示 Running，重启电脑后自启
- [ ] 微信发文字 → 收到 Claude 回复（长回复不被限频截断）
- [ ] 微信发图片 → Claude 能"看到"图片内容
- [ ] 微信发文件 → Claude 能读取
- [ ] `/send-me` 推送文件到微信、`/send-you` 接收文件
- [ ] 微信发语音 → 转文字（或友好降级提示）
- [ ] `/mode accept` → 操作推送审批，回 y/n 生效
- [ ] Claude 提选择题 → 推送选项，回编号生效
- [ ] 全部斜杠命令（见 README「完整命令列表」）逐个验证
- [ ] daemon 崩溃后自动重启；`stop` 后不再自启

## 7. 注意事项

- **不要假设 WSL**。WSL 里其实就是 Linux，现有 Linux 分支已覆盖。本适配针对**原生 Windows + PowerShell**。
- **不要破坏 Unix 行为**：所有平台分支都要保留 Darwin/Linux 原路径。`daemon.mjs` 分发器对 Unix 必须仍调 `daemon.sh`。
- **行尾**：Windows 上注意 `.sh` 别被 CRLF 污染；新写的 `.ps1` 用 UTF-8（带 BOM 或确保中文不乱码）。
- **凭证/密钥**：daemon.sh 会把 `ANTHROPIC_*` 环境变量写进 plist/service。Windows 的计划任务同样要把这些环境变量传给进程，否则 Claude CLI 无法鉴权。
- **改完提交前**：`npm run build` 必须通过；在 Windows 实机跑过验证清单。
