import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { loadConfig, saveConfig } from '../config.js';
import { DEFAULT_WORKING_DIR } from '../constants.js';
import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import type { PendingSetup } from '../session.js';
import {
  loadWorkspaceConfigs,
  getWorkspaceConfig,
  upsertWorkspaceConfig,
  deleteWorkspaceConfig,
  type WorkspaceConfig,
} from '../workspace-config.js';
import {
  loadModelAliases,
  resolveModel,
  upsertAlias,
  deleteAlias,
} from '../model-aliases.js';
import {
  loadQuickCommands,
  resolveQuickCommand,
  upsertQuickCommand,
  deleteQuickCommand,
} from '../quick-commands.js';
import {
  parseInterval,
  formatInterval,
  getLoopsForAccount,
  removeLoop,
  removeAllLoops,
  MAX_LOOP_INTERVAL_MS,
} from '../loop-registry.js';
import { resolve, basename, join, extname, relative, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const HELP_TEXT = `**📋 可用命令**

---

**会话管理**
/help — 显示帮助
/status — 查看当前会话状态
/clear — 清除当前会话（保留目录/模型设置）
/reset — 完全重置（恢复所有默认设置）
/stop — 停止当前对话并清空排队消息
/compact — 压缩上下文（保持 session ID）
/history [数量] — 查看对话记录（默认 20 条）
/undo [数量] — 撤销最近对话（默认 1 条）

---

**对话恢复**
/resume — 列出当前目录的历史对话
/resume <编号> — 恢复指定编号的历史对话
/resume <uuid> — 通过 session ID 恢复

---

**模型配置**
/model [别名/名称] — 查看或切换模型（切换前自动验证）
/model-config — 列出所有模型别名
/model-config <别名> <完整模型ID> — 添加/更新别名
/model-config del <别名> — 删除别名
/mode [bypass|accept] — 权限模式：全自动 / 逐个 y/n 确认
/effort [级别] — 思考强度：low / medium / high / xhigh / max
/advisor [模型] — Advisor 模型：opus / sonnet / fable / off

---

**任务控制**
/q — 列出所有快捷指令
/q <名字> — 执行快捷指令
/q set <名字> <内容> — 添加/更新快捷指令
/q del <名字> — 删除快捷指令
/goal [条件] — 设置目标，Claude 持续工作直到完成
/goal clear — 清除当前目标
/loop <间隔> <提示> — 定时循环，例: /loop 5m 检查 CI
/loop — 列出所有运行中的 loop
/loop stop <id> — 停止指定 loop
/loop stop all — 停止所有 loop

---

**Workspace 配置**
/configs — 列出所有 workspace 配置
/set-config <编号> — 向导式创建/编辑配置
/switch-config <编号> — 一键切换（目录+模型+session）
/delete-config <编号> — 删除配置

---

**文件与工具**
/cwd [路径] — 查看或切换工作目录
/prompt [内容] — 查看或设置系统提示词
/send-me <路径> — 发送本地文件给你（支持多路径、目录）
/send-you — 开始接收你发来的文件/图片
/send-you-end [要求] — 结束接收，将文件+图片发给 Claude
/send-you-cancel — 取消文件接收
/skills [full] — 列出已安装的 skill
/version — 查看版本信息

---

💡 直接发文字即可与 Claude Code 对话，也支持发送语音（本地模型转文字）和图片。`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒
const SENDABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md', '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
  '.zip', '.tar', '.gz', '.json', '.ts', '.js', '.py',
]);
const LOOP_INTERVAL_TOKEN_RE = /^(-?\d+(?:\.\d+)?)\s*(s|m|h|d)$/i;

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  ctx.updateSession({ workingDirectory: args });
  return { reply: `✅ 工作目录已切换为: ${args}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.model || '（未设置，使用默认）';
    return {
      reply: `**当前模型**\n${current}\n\n用法: /model <模型名称或别名>\n例: /model sonnet\n\n查看别名: /model-config`,
      handled: true,
    };
  }
  const resolved = resolveModel(args);
  return { handled: true, validateModel: resolved };
}

/** /mode — 切换权限模式：bypass(全自动) / accept(逐个 y/n 确认) */
export function handleMode(ctx: CommandContext, args: string): CommandResult {
  const cur = ctx.session.permissionMode ?? 'bypass';
  const curLabel = cur === 'approve' ? 'accept edits on（每个操作需 y/n 确认）' : 'bypass permissions on（全自动）';
  const arg = args.trim().toLowerCase();

  if (!arg) {
    return {
      reply: [
        '**🔐 权限模式**',
        '',
        `当前: **${curLabel}**`,
        '',
        '切换:',
        '- /mode bypass — 全自动，不再询问',
        '- /mode accept — 每个操作推送到微信，回复 y 批准 / n 拒绝',
      ].join('\n'),
      handled: true,
    };
  }

  if (arg === 'bypass' || arg === 'b') {
    ctx.updateSession({ permissionMode: 'bypass' });
    return { reply: '✅ **已切换为 bypass 模式**\n全自动执行，不再询问。', handled: true };
  }
  if (arg === 'accept' || arg === 'a' || arg === 'acceptedits') {
    ctx.updateSession({ permissionMode: 'approve' });
    return {
      reply: [
        '✅ **已切换为 accept 模式**',
        '',
        '之后 Claude 每次要执行工具，会推送到微信。',
        '回复 **y** 批准 / **n** 拒绝（30 秒未回复自动拒绝）。',
      ].join('\n'),
      handled: true,
    };
  }
  return { reply: '用法: /mode bypass 或 /mode accept', handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;

  // 检查是否匹配某个 workspace 配置
  const configs = loadWorkspaceConfigs();
  const activeConfig = configs.find(c =>
    c.cwd === s.workingDirectory &&
    (c.sdkSessionId === s.sdkSessionId || (!c.sdkSessionId && !s.sdkSessionId))
  );
  const configLine = activeConfig
    ? `#${activeConfig.id} ${activeConfig.name}`
    : '无（未使用 workspace 配置）';

  const modeLabel = (s.permissionMode ?? 'bypass') === 'approve' ? 'accept（逐个 y/n）' : 'bypass（全自动）';

  const lines = [
    '**📊 会话状态**',
    '',
    `**配置** ${configLine}`,
    `**目录** ${s.workingDirectory}`,
    `**模型** ${s.model ?? '默认'}`,
    `**思考** ${s.effort ?? '默认 (high)'}`,
    `**Advisor** ${s.advisor ?? '未启用'}`,
    `**权限** ${modeLabel}`,
    `**状态** ${s.state}`,
    '',
    `**Session ID**`,
    s.sdkSessionId ?? '无',
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleSkills(args: string): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';
  if (showFull) {
    const lines = skills.map(s => `/${s.name}\n   ${s.description}`);
    return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n\n')}`, handled: true };
  }
  const lines = skills.map(s => `/${s.name}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}\n\n使用 /skills full 查看完整描述`, handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  newSession.workingDirectory = DEFAULT_WORKING_DIR;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 压缩上下文 — 通过原生 /compact 命令压缩当前 session，保持 session ID 不变 */
export function handleCompact(ctx: CommandContext): CommandResult {
  if (!ctx.session.sdkSessionId) {
    return { reply: 'ℹ️ 当前没有活动的对话，无需压缩。', handled: true };
  }
  return { handled: true, compactSession: true };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `wechat-claude-code v${version}`, handled: true };
  } catch {
    return { reply: 'wechat-claude-code (version unknown)', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ 系统提示词已设置:\n${config.systemPrompt}`, handled: true };
}

function resolveSendPath(workingDirectory: string, input: string): string {
  const clean = input.replace(/^["']|["']$/g, '');
  if (clean.startsWith('/')) return resolve(clean);
  return resolve(workingDirectory, clean.replace(/^~/, homedir()));
}

function normalizeAllowedRoot(root: string): string {
  const expanded = resolve(root.replace(/^~/, homedir()));
  return existsSync(expanded) ? realpathSync(expanded) : expanded;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function getAllowedSendRoots(ctx: CommandContext): string[] {
  const configured = (process.env.WECHAT_CLAUDE_ALLOWED_SEND_ROOTS ?? '')
    .split(delimiter)
    .map(root => root.trim())
    .filter(Boolean);
  const roots = [ctx.session.workingDirectory || DEFAULT_WORKING_DIR, ...configured];
  return Array.from(new Set(roots.map(normalizeAllowedRoot)));
}

function findBlockedSendPaths(paths: string[], allowedRoots: string[]): string[] {
  return paths.filter((filePath) => {
    const canonicalPath = realpathSync(filePath);
    return !allowedRoots.some(root => isPathWithinRoot(canonicalPath, root));
  });
}

function getLoopIntervalError(token: string): string | null {
  const trimmed = token.trim();
  const match = trimmed.match(LOOP_INTERVAL_TOKEN_RE);
  if (!match) {
    return '间隔格式无效，支持: 30s / 5m / 2h / 1d（最小 1 分钟，最大 30 天）';
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) {
    return '间隔必须是有效数字，支持单位: s / m / h / d';
  }
  if (value <= 0) {
    return '间隔必须大于 0。';
  }
  const unit = match[2].toLowerCase();
  const multiplier = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  if (value * multiplier > MAX_LOOP_INTERVAL_MS) {
    return `间隔过长，最大支持 ${formatInterval(MAX_LOOP_INTERVAL_MS)}。`;
  }
  return null;
}

export function handleSend(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return {
      reply: [
        '用法: /send <路径> [路径2] ...',
        '支持单文件、多文件（空格分隔）、目录（发送目录内所有文件）',
        '',
        '例:',
        '  /send ~/Documents/report.pdf',
        '  /send ./chart.png ./data.csv',
        '  /send ~/Desktop/output/',
      ].join('\n'),
      handled: true,
    };
  }

  // 解析多路径（按空格分隔，支持路径含空格则需引号，但简单情况不需要）
  const rawPaths = args.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const resolved = rawPaths.map(p => resolveSendPath(ctx.session.workingDirectory, p));

  const notFound = resolved.filter(p => !existsSync(p));
  if (notFound.length > 0) {
    return { reply: `文件不存在:\n${notFound.map(p => '  ' + p).join('\n')}`, handled: true };
  }

  const allowedRoots = getAllowedSendRoots(ctx);
  const blockedInputs = findBlockedSendPaths(resolved, allowedRoots);
  if (blockedInputs.length > 0) {
    return {
      reply: [
        '以下路径已被拦截：/send-me 只能读取当前 workspace 或白名单目录下的文件。',
        '',
        ...blockedInputs.map(p => `  ${p}`),
      ].join('\n'),
      handled: true,
    };
  }

  // 展开目录
  const files: string[] = [];
  for (const p of resolved) {
    const st = statSync(p);
    if (st.isDirectory()) {
      const entries = readdirSync(p);
      const dirFiles = entries
        .map(e => `${p}/${e}`)
        .filter(f => { try { return statSync(f).isFile() && SENDABLE_EXTENSIONS.has(extname(f).toLowerCase()); } catch { return false; } });
      if (dirFiles.length === 0) {
        return { reply: `目录为空或没有可发送的文件: ${p}`, handled: true };
      }
      files.push(...dirFiles);
    } else {
      if (st.size > 25 * 1024 * 1024) {
        return { reply: `文件过大 (${(st.size / 1024 / 1024).toFixed(1)}MB)，最大支持 25MB:\n  ${p}`, handled: true };
      }
      files.push(p);
    }
  }

  const blockedExpanded = findBlockedSendPaths(files, allowedRoots);
  if (blockedExpanded.length > 0) {
    return {
      reply: [
        '以下文件已被拦截：检测到目录内文件或符号链接指向 workspace/白名单之外的位置。',
        '',
        ...blockedExpanded.map(p => `  ${p}`),
      ].join('\n'),
      handled: true,
    };
  }

  if (files.length === 1) {
    return { handled: true, sendFile: files[0] };
  }
  return { handled: true, sendFiles: files };
}

/** /send-me — 别名，功能同 /send */
export function handleSendMe(ctx: CommandContext, args: string): CommandResult {
  return handleSend(ctx, args);
}

/** /model-config — 管理模型别名 */
/** /q — 快捷指令 / 常用语 */
export function handleQuick(_ctx: CommandContext, args: string): CommandResult {
  const trimmed = args.trim();

  // /q  — 列出所有快捷指令
  if (!trimmed) {
    const commands = loadQuickCommands();
    const entries = Object.entries(commands);
    if (entries.length === 0) {
      return {
        reply: [
          '**⚡ 快捷指令列表（空）**',
          '',
          '- /q set <名字> <内容> — 添加/更新',
          '- /q <名字> — 执行',
          '- /q del <名字> — 删除',
          '',
          '例: /q set test 运行所有测试并报告结果',
        ].join('\n'),
        handled: true,
      };
    }
    const lines = ['**⚡ 快捷指令列表**', ''];
    for (const [name, prompt] of entries) {
      lines.push(`**${name}**`);
      lines.push(prompt);
    }
    lines.push('');
    lines.push('用 /q <名字> 执行，/q del <名字> 删除');
    return { reply: lines.join('\n'), handled: true };
  }

  const parts = trimmed.split(/\s+/);
  const sub = parts[0].toLowerCase();

  // /q set <名字> <内容>
  if (sub === 'set') {
    const name = parts[1];
    const prompt = parts.slice(2).join(' ');
    if (!name || !prompt) {
      return { reply: '用法: /q set <名字> <内容>\n例: /q set test 运行所有测试并报告结果', handled: true };
    }
    upsertQuickCommand(name, prompt);
    return {
      reply: [`✅ **快捷指令已保存**`, '', `**/q ${name.toLowerCase()}**`, prompt].join('\n'),
      handled: true,
    };
  }

  // /q del <名字>
  if (sub === 'del') {
    const name = parts[1];
    if (!name) return { reply: '用法: /q del <名字>', handled: true };
    const deleted = deleteQuickCommand(name);
    return { reply: deleted ? `✅ 已删除快捷指令: ${name}` : `❌ 快捷指令不存在: ${name}`, handled: true };
  }

  // /q <名字>  — 执行：把存的内容作为 prompt 发给 Claude
  const prompt = resolveQuickCommand(parts[0]);
  if (!prompt) {
    return { reply: `❌ 快捷指令不存在: ${parts[0]}\n\n用 /q 查看所有快捷指令`, handled: true };
  }
  // 允许附加参数：/q test --verbose → "运行所有测试 --verbose"
  const extra = parts.slice(1).join(' ');
  const finalPrompt = extra ? `${prompt} ${extra}` : prompt;
  return { handled: true, claudePrompt: finalPrompt };
}

export function handleModelConfig(_ctx: CommandContext, args: string): CommandResult {
  const parts = args.trim().split(/\s+/);

  // /model-config  — 列出所有别名
  if (!args.trim()) {
    const aliases = loadModelAliases();
    const entries = Object.entries(aliases);
    if (entries.length === 0) {
      return {
        reply: [
          '**📋 模型别名列表（空）**',
          '',
          '- /model-config <别名> <完整模型ID> — 添加/更新',
          '- /model-config del <别名> — 删除',
          '- /model-config <别名> — 查看单个',
          '',
          '例: /model-config sonnet claude-sonnet-4-6-thinking[1m]',
        ].join('\n'),
        handled: true,
      };
    }
    const lines = ['**📋 模型别名列表**', ''];
    for (const [alias, modelId] of entries) {
      lines.push(`**${alias}**`);
      lines.push(modelId);
    }
    lines.push('');
    lines.push('用 /model <别名> 切换，/model-config del <别名> 删除');
    return { reply: lines.join('\n'), handled: true };
  }

  // /model-config del <别名>
  if (parts[0].toLowerCase() === 'del') {
    const alias = parts[1];
    if (!alias) return { reply: '用法: /model-config del <别名>', handled: true };
    const deleted = deleteAlias(alias);
    return {
      reply: deleted ? `✅ 已删除别名: ${alias}` : `❌ 别名不存在: ${alias}`,
      handled: true,
    };
  }

  // /model-config <别名>  — 查看单个
  if (parts.length === 1) {
    const aliases = loadModelAliases();
    const modelId = aliases[parts[0].toLowerCase()];
    if (!modelId) {
      return { reply: `❌ 别名不存在: ${parts[0]}\n\n用 /model-config 查看所有别名`, handled: true };
    }
    return { reply: `**${parts[0]}**\n${modelId}`, handled: true };
  }

  // /model-config <别名> <完整模型ID>  — 添加/更新
  const alias = parts[0];
  const modelId = parts.slice(1).join(' ');
  upsertAlias(alias, modelId);
  return {
    reply: [
      `✅ **别名已保存**`,
      '',
      `**${alias}**`,
      modelId,
      '',
      `用 /model ${alias} 切换`,
    ].join('\n'),
    handled: true,
  };
}

/** /send-you — 进入文件接收模式 */
export function handleSendYou(ctx: CommandContext, _args: string): CommandResult {
  ctx.updateSession({
    pendingFileUpload: { items: [], startedAt: Date.now() },
  });
  return {
    reply: [
      '**📥 准备接收文件**',
      '',
      '请直接发送图片或文件（可多次发送）。',
      '发完后发: /send-you-end [对这些文件的要求]',
      '',
      '取消: /send-you-cancel',
    ].join('\n'),
    handled: true,
  };
}

/** /send-you-cancel — 取消文件接收 */
export function handleSendYouCancel(ctx: CommandContext): CommandResult {
  if (!ctx.session.pendingFileUpload) {
    return { reply: '当前没有进行中的文件接收。', handled: true };
  }
  const count = ctx.session.pendingFileUpload.items.length;
  ctx.updateSession({ pendingFileUpload: undefined });
  return { reply: `已取消文件接收（已丢弃 ${count} 个文件）。`, handled: true };
}

/** /send-you-end — 结束文件接收，整合发给 Claude */
export function handleSendYouEnd(ctx: CommandContext, args: string): CommandResult {
  const upload = ctx.session.pendingFileUpload;
  if (!upload) {
    return { reply: '当前没有进行中的文件接收，请先发 /send-you 开始。', handled: true };
  }
  if (upload.items.length === 0) {
    ctx.updateSession({ pendingFileUpload: undefined });
    return { reply: '没有收到任何文件，已取消。', handled: true };
  }

  const requirement = args.trim();

  ctx.updateSession({ pendingFileUpload: undefined });
  return {
    handled: true,
    sendYouPayload: {
      requirement,
      items: upload.items,
    },
  };
}

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
  created: string;
  modified: string;
  messageCount: number;
  gitBranch: string;
}

interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
  originalPath: string;
}

function cwdToProjectSlug(cwd: string): string {
  // Claude Code converts the full path to a slug by replacing every non-alphanumeric
  // character (slashes, underscores, dots, etc.) with a hyphen.
  // e.g. /Users/unknown_liang/Desktop/Code/atlas_v01
  //   → -Users-unknown-liang-Desktop-Code-atlas-v01
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function extractSessionInfo(jsonlPath: string): { customTitle?: string; firstUserMessage?: string } {
  if (!existsSync(jsonlPath)) return {};
  try {
    const lines = readFileSync(jsonlPath, 'utf-8').split('\n');
    let customTitle: string | undefined;
    let firstUserMessage: string | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      // custom title set by /rename — keep updating to get the latest
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
        customTitle = obj.customTitle.trim();
      }
      // first real user message
      if (!firstUserMessage && obj.type === 'user') {
        const content = obj.message?.content;
        if (typeof content === 'string' && content.trim().length > 5) {
          firstUserMessage = content.trim();
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 5) {
              firstUserMessage = block.text.trim();
              break;
            }
          }
        }
      }
      // once we have firstUserMessage, we still need to scan for the latest customTitle
      // so never break early here
    }
    return { customTitle, firstUserMessage };
  } catch { /* ignore */ }
  return {};
}

function loadSessionIndex(cwd: string): SessionIndexEntry[] {
  const slug = cwdToProjectSlug(cwd.replace(/^~/, homedir()));
  const projectDir = join(homedir(), '.claude', 'projects', slug);
  const indexPath = join(projectDir, 'sessions-index.json');

  if (existsSync(indexPath)) {
    try {
      const data: SessionIndex = JSON.parse(readFileSync(indexPath, 'utf-8'));
      return (data.entries || []).sort(
        (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
      );
    } catch {
      // fall through to directory scan
    }
  }

  // Fallback: scan .jsonl files directly (happens when only one session exists)
  try {
    const files = readdirSync(projectDir);
    const entries: SessionIndexEntry[] = files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const fullPath = join(projectDir, f);
        const sessionId = f.replace(/\.jsonl$/, '');
        let modified = new Date(0).toISOString();
        let created = modified;
        try {
          const st = statSync(fullPath);
          modified = st.mtime.toISOString();
          created = st.birthtime.toISOString();
        } catch { /* ignore */ }
        return {
          sessionId,
          fullPath,
          summary: '',
          firstPrompt: '',
          created,
          modified,
          messageCount: 0,
          gitBranch: '',
        };
      })
      .sort((a, b) =>
        new Date(b.modified).getTime() - new Date(a.modified).getTime()
      );
    return entries;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') {
      // Missing or unreadable Claude project dirs should behave like "no sessions found".
      return [];
    }
    logger.warn('loadSessionIndex scan failed', {
      cwd,
      projectDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function formatSessionLabel(entry: SessionIndexEntry, index: number): string {
  const { customTitle, firstUserMessage } = extractSessionInfo(entry.fullPath);
  // customTitle (from /rename) takes priority, then first user message, then summary
  const raw = customTitle || firstUserMessage || entry.summary || '（无内容）';
  const label = raw
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 50);
  const titleMark = customTitle ? `[${customTitle}] ` : '';
  const displayLabel = customTitle
    ? `[${customTitle}]`
    : (firstUserMessage || entry.summary || '（无内容）')
        .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim()
        .slice(0, 50);
  const modified = new Date(entry.modified).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const msgs = entry.messageCount;
  return `${index + 1}. [${modified}] ${displayLabel} (${msgs}条)`;
}

export function handleResume(ctx: CommandContext, args: string): CommandResult {
  const cwd = ctx.session.workingDirectory || DEFAULT_WORKING_DIR;

  const entries = loadSessionIndex(cwd);
  if (entries.length === 0) {
    return { reply: `当前目录 ${cwd} 没有历史对话记录。`, handled: true };
  }

  // /resume 不带参数 — 列出会话列表
  if (!args) {
    const MAX_LIST = 15;
    const shown = entries.slice(0, MAX_LIST);
    const lines = shown.map((e, i) => formatSessionLabel(e, i));
    const footer = entries.length > MAX_LIST ? `\n…共 ${entries.length} 条，仅显示最近 ${MAX_LIST} 条` : '';
    return {
      reply: `📋 历史对话（目录: ${cwd}）\n\n${lines.join('\n')}${footer}\n\n用 /resume <编号> 恢复，例: /resume 1`,
      handled: true,
    };
  }

  // /resume <sessionId> — 按完整 UUID 恢复（必须先于编号判断，防止 parseInt 误解析 UUID）
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(args.trim())) {
    const target = entries.find(e => e.sessionId === args.trim());
    if (!target) {
      // UUID 格式正确但不在当前目录的 sessions-index 里
      // 可能是活跃会话还未写入索引，直接信任用户输入
      ctx.updateSession({ sdkSessionId: args.trim() });
      return {
        reply: [
          `✅ 已切换到 session:`,
          `  ${args.trim()}`,
          '',
          '（该 session 未在当前目录的历史索引中，已直接设置）',
          '直接发消息即可继续该对话。',
        ].join('\n'),
        handled: true,
      };
    }
    ctx.updateSession({ sdkSessionId: target.sessionId });
    const label = (target.summary || target.firstPrompt || target.sessionId).slice(0, 60);
    return {
      reply: [
        `✅ 已切换到历史对话`,
        '',
        `摘要:\n  ${label}`,
        `时间:\n  ${new Date(target.modified).toLocaleString('zh-CN')}`,
        '',
        '直接发消息即可继续该对话。',
      ].join('\n'),
      handled: true,
    };
  }

  // /resume <编号> — 按编号恢复
  const num = parseInt(args.trim(), 10);
  if (!isNaN(num) && num >= 1 && num <= entries.length) {
    const target = entries[num - 1];
    const label = (target.summary || target.firstPrompt || target.sessionId).slice(0, 60);
    ctx.updateSession({ sdkSessionId: target.sessionId });
    return {
      reply: [
        `✅ 已切换到历史对话 #${num}`,
        '',
        `摘要:\n  ${label}`,
        `时间:\n  ${new Date(target.modified).toLocaleString('zh-CN')}`,
        '',
        '直接发消息即可继续该对话。',
      ].join('\n'),
      handled: true,
    };
  }

  // /resume <关键词> — 按自定义名称或首条消息模糊搜索
  const keyword = args.trim().toLowerCase().replace(/^["']|["']$/g, '');
  const matched = entries.filter(e => {
    const { customTitle, firstUserMessage } = extractSessionInfo(e.fullPath);
    const haystack = [customTitle, firstUserMessage, e.summary].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(keyword);
  });

  if (matched.length === 0) {
    return {
      reply: [
        `未找到包含 "${args.trim()}" 的历史对话。`,
        '',
        '可以用 /resume 列出所有对话，再用编号恢复。',
      ].join('\n'),
      handled: true,
    };
  }

  if (matched.length === 1) {
    const target = matched[0];
    const { customTitle, firstUserMessage } = extractSessionInfo(target.fullPath);
    const label = (customTitle || firstUserMessage || target.summary || target.sessionId).slice(0, 60);
    ctx.updateSession({ sdkSessionId: target.sessionId });
    return {
      reply: [
        `✅ 已切换到历史对话`,
        '',
        `名称:\n  ${label}`,
        `时间:\n  ${new Date(target.modified).toLocaleString('zh-CN')}`,
        '',
        '直接发消息即可继续该对话。',
      ].join('\n'),
      handled: true,
    };
  }

  // 多个匹配，列出让用户选择
  const lines = matched.slice(0, 10).map((e, i) => {
    const { customTitle, firstUserMessage } = extractSessionInfo(e.fullPath);
    const label = (customTitle || firstUserMessage || e.summary || '（无内容）')
      .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/<[^>]+>/g, '').trim().slice(0, 50);
    const modified = new Date(e.modified).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `${i + 1}. [${modified}] ${label}`;
  });
  return {
    reply: [
      `找到 ${matched.length} 条匹配 "${args.trim()}" 的对话：`,
      '',
      ...lines,
      '',
      '请用 /resume <编号> 选择，编号对应上方列表。',
    ].join('\n'),
    handled: true,
  };
}

/** 查看或调整思考强度 */
export function handleEffort(ctx: CommandContext, args: string): CommandResult {
  const VALID_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const DESCRIPTIONS: Record<string, string> = {
    low:    '快速响应，适合简单短任务',
    medium: '均衡，减少 token 消耗',
    high:   '默认级别，平衡质量与效率',
    xhigh:  '更深推理，token 消耗较多',
    max:    '最深推理，仅当前会话有效',
  };

  if (!args) {
    const current = ctx.session.effort ?? '默认 (high)';
    const list = VALID_LEVELS.map(l =>
      `  ${l === (ctx.session.effort ?? 'high') ? '▶' : ' '} ${l}  — ${DESCRIPTIONS[l]}`
    ).join('\n');
    return {
      reply: `⚡ 当前思考强度: ${current}\n\n可选级别:\n${list}\n\n用法: /effort <级别>\n例: /effort high`,
      handled: true,
    };
  }

  const level = args.trim().toLowerCase();
  if (!VALID_LEVELS.includes(level)) {
    return {
      reply: `无效的级别: ${level}\n可选: ${VALID_LEVELS.join(' / ')}`,
      handled: true,
    };
  }

  ctx.updateSession({ effort: level });
  const note = level === 'max' ? '\n\n⚠️ max 仅对当前会话有效，重启后恢复默认' : '';
  return {
    reply: `✅ 思考强度已设为:\n  ${level}\n\n${DESCRIPTIONS[level]}${note}`,
    handled: true,
  };
}

// ---------------------------------------------------------------------------
// Workspace config commands
// ---------------------------------------------------------------------------

/** /configs — 列出所有已保存的 workspace 配置 */
export function handleConfigs(_ctx: CommandContext): CommandResult {
  const configs = loadWorkspaceConfigs();
  if (configs.length === 0) {
    return {
      reply: '暂无 workspace 配置。\n用 /set-config <编号> 开始创建，例: /set-config 0',
      handled: true,
    };
  }
  const lines = configs.map(c => {
    const parts = [
      `#${c.id} ${c.name}`,
      `  目录: ${c.cwd}`,
      `  模型: ${c.model ?? '默认'}`,
      `  思考强度: ${c.effort ?? '默认'}`,
      `  Session: ${c.sdkSessionId ? c.sdkSessionId.slice(0, 8) + '...' : '无'}`,
    ];
    if (c.advisor) parts.push(`  Advisor: ${c.advisor}`);
    return parts.join('\n');
  });
  return {
    reply: `📋 Workspace 配置 (${configs.length} 个):\n\n${lines.join('\n\n')}\n\n用 /switch-config <编号> 切换`,
    handled: true,
  };
}

/** /switch-config <id> — 一键切换到指定配置 */
export function handleSwitchConfig(ctx: CommandContext, args: string): CommandResult {
  const id = parseInt(args.trim(), 10);
  if (isNaN(id)) {
    return { reply: '用法: /switch-config <编号>\n例: /switch-config 0', handled: true };
  }
  const cfg = getWorkspaceConfig(id);
  if (!cfg) {
    return { reply: `未找到配置 #${id}。用 /configs 查看所有配置。`, handled: true };
  }
  ctx.updateSession({
    workingDirectory: cfg.cwd,
    model: cfg.model,
    effort: cfg.effort,
    advisor: cfg.advisor,
    sdkSessionId: cfg.sdkSessionId,
  });
  const parts = [
    `✅ 已切换到配置 #${cfg.id}: ${cfg.name}`,
    '',
    `目录:\n  ${cfg.cwd}`,
    '',
    `模型:\n  ${cfg.model ?? '默认'}`,
    '',
    `思考强度:\n  ${cfg.effort ?? '默认'}`,
    '',
    `Session:\n  ${cfg.sdkSessionId ? cfg.sdkSessionId.slice(0, 8) + '...' : '新对话'}`,
  ];
  if (cfg.advisor) parts.push('', `Advisor:\n  ${cfg.advisor}`);
  parts.push('', '直接发消息即可开始工作。');
  return { reply: parts.join('\n'), handled: true };
}

/** /delete-config <id> — 删除指定配置 */
export function handleDeleteConfig(_ctx: CommandContext, args: string): CommandResult {
  const id = parseInt(args.trim(), 10);
  if (isNaN(id)) {
    return { reply: '用法: /delete-config <编号>\n例: /delete-config 0', handled: true };
  }
  const ok = deleteWorkspaceConfig(id);
  if (!ok) {
    return { reply: `未找到配置 #${id}。`, handled: true };
  }
  return { reply: `✅ 已删除配置 #${id}。`, handled: true };
}

/** /set-config <id> — 启动向导，创建或编辑配置 */
export function handleSetConfig(ctx: CommandContext, args: string): CommandResult {
  const id = parseInt(args.trim(), 10);
  if (isNaN(id) || id < 0) {
    return { reply: '用法: /set-config <编号>\n编号从 0 开始，例: /set-config 0', handled: true };
  }
  // 载入已有配置作为草稿默认值
  const existing = getWorkspaceConfig(id);
  const draft: PendingSetup['draft'] = {
    name: existing?.name,
    cwd: existing?.cwd,
    model: existing?.model,
    effort: existing?.effort,
    sdkSessionId: existing?.sdkSessionId,
  };
  ctx.updateSession({
    pendingSetup: { configId: id, step: 'name', draft },
  });
  const prefix = existing ? `编辑配置 #${id}（${existing.name}）` : `创建配置 #${id}`;
  const hint = existing ? `当前: ${existing.name}\n直接回车保留，或输入新名称` : '请输入配置名称（例: Atlas ROS2）';
  return {
    reply: `🔧 ${prefix}\n\n第 1 步 / 5：配置名称\n${hint}\n\n发送 /cancel 取消`,
    handled: true,
  };
}

/**
 * 向导步骤处理 — 由 main.ts 在普通消息路由前调用。
 * 返回 null 表示没有进行中的向导，调用方继续正常流程。
 */
export function handleSetupWizard(ctx: CommandContext, text: string): CommandResult | null {
  const setup = ctx.session.pendingSetup;
  if (!setup) return null;

  // 允许随时取消
  if (text.trim().toLowerCase() === '/cancel') {
    ctx.updateSession({ pendingSetup: undefined });
    return { reply: '已取消配置向导。', handled: true };
  }

  const { configId, step, draft } = setup;
  const input = text.trim();

  switch (step) {
    case 'name': {
      const name = input || draft.name || '';
      if (!name) return { reply: '名称不能为空，请重新输入：', handled: true };
      ctx.updateSession({ pendingSetup: { configId, step: 'cwd', draft: { ...draft, name } } });
      return {
        reply: `✅ 名称: ${name}\n\n第 2 步 / 5：工作目录\n${draft.cwd ? `当前: ${draft.cwd}\n直接回车保留` : '请输入完整路径（例: /Users/你/Desktop/Code/myproject）'}\n\n发送 /cancel 取消`,
        handled: true,
      };
    }
    case 'cwd': {
      const cwd = input || draft.cwd || '';
      if (!cwd) return { reply: '目录不能为空，请重新输入：', handled: true };
      ctx.updateSession({ pendingSetup: { configId, step: 'model', draft: { ...draft, cwd } } });
      const modelHint = draft.model
        ? `当前: ${draft.model}\n直接回车保留，或输入新模型名称`
        : '请输入模型名称（例: sonnet / opus）\n直接回车使用默认';
      return {
        reply: [`✅ 目录:\n  ${cwd}`, '', '第 3 步 / 5：模型', modelHint, '', '发送 /cancel 取消'].join('\n'),
        handled: true,
      };
    }
    case 'model': {
      const model = input || draft.model || undefined;
      ctx.updateSession({ pendingSetup: { configId, step: 'effort', draft: { ...draft, model } } });
      const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
      const effortHint = draft.effort
        ? `当前: ${draft.effort}\n直接回车保留`
        : '直接回车使用默认 (high)';
      return {
        reply: [`✅ 模型:\n  ${model ?? '默认'}`, '', `第 4 步 / 5：思考强度\n可选: ${EFFORT_LEVELS.join(' / ')}`, effortHint, '', '发送 /cancel 取消'].join('\n'),
        handled: true,
      };
    }
    case 'effort': {
      const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
      const effort = input
        ? (EFFORT_LEVELS.includes(input.toLowerCase()) ? input.toLowerCase() : null)
        : (draft.effort || undefined);
      if (input && !EFFORT_LEVELS.includes(input.toLowerCase())) {
        return { reply: `无效的思考强度，请从以下选择: ${EFFORT_LEVELS.join(' / ')}\n或直接回车跳过`, handled: true };
      }
      ctx.updateSession({ pendingSetup: { configId, step: 'sdkSessionId', draft: { ...draft, effort: effort ?? undefined } } });
      const sessionHint = draft.sdkSessionId
        ? `当前: ${draft.sdkSessionId.slice(0, 8)}...\n直接回车保留`
        : '直接回车跳过（新对话）';
      return {
        reply: [
          `✅ 思考强度:\n  ${effort ?? '默认'}`,
          '',
          '第 5 步 / 5：Session ID（可选）',
          '用于恢复指定的历史对话。',
          '先 /switch-config 到目录，再 /resume 到对话，然后用 /status 查看 Session ID 复制过来。',
          sessionHint,
          '',
          '发送 /cancel 取消',
        ].join('\n'),
        handled: true,
      };
    }
    case 'sdkSessionId': {
      const sdkSessionId = input || draft.sdkSessionId || undefined;
      ctx.updateSession({ pendingSetup: { configId, step: 'confirm', draft: { ...draft, sdkSessionId } } });
      const summary = [
        `配置 #${configId} 确认信息`,
        '',
        `名称:\n  ${draft.name}`,
        '',
        `目录:\n  ${draft.cwd}`,
        '',
        `模型:\n  ${draft.model ?? '默认'}`,
        '',
        `思考强度:\n  ${draft.effort ?? '默认'}`,
        '',
        `Session:\n  ${sdkSessionId ? sdkSessionId.slice(0, 8) + '...' : '无（新对话）'}`,
        '',
        '发送 确认 或 y 保存，发送其他内容取消。',
      ].join('\n');
      return { reply: summary, handled: true };
    }
    case 'confirm': {
      if (!['确认', 'y', 'yes', 'ok', '是'].includes(input.toLowerCase())) {
        ctx.updateSession({ pendingSetup: undefined });
        return { reply: '已取消，配置未保存。', handled: true };
      }
      const newConfig: WorkspaceConfig = {
        id: configId,
        name: draft.name!,
        cwd: draft.cwd!,
        model: draft.model,
        effort: draft.effort,
        sdkSessionId: draft.sdkSessionId,
      };
      upsertWorkspaceConfig(newConfig);
      ctx.updateSession({ pendingSetup: undefined });
      return {
        reply: [`✅ 配置 #${configId} 已保存！`, '', `用 /switch-config ${configId} 切换到此 workspace。`].join('\n'),
        handled: true,
      };
    }
  }
}

/** /loop — 定时循环执行 prompt */
export function handleLoop(ctx: CommandContext, args: string): CommandResult {
  const accountId = ctx.accountId;

  // /loop 不带参数 — 列出
  if (!args) {
    const loops = getLoopsForAccount(accountId);
    if (loops.length === 0) {
      return {
        reply: [
          '⏱ 当前没有运行中的 loop。',
          '',
          '用法:',
          '  /loop <间隔> <提示>  创建定时 loop',
          '  间隔格式: 30s / 5m / 2h / 1d（最小 1 分钟）',
          '  例: /loop 5m 检查 CI 是否通过',
        ].join('\n'),
        handled: true,
      };
    }
    const now = Date.now();
    const lines = loops.map(l => {
      const nextIn = Math.max(0, Math.round((l.nextFireAt - now) / 1000));
      const nextStr = nextIn < 60 ? `${nextIn}s 后` : `${Math.round(nextIn / 60)}m 后`;
      return [
        `[${l.id}] 每 ${formatInterval(l.intervalMs)}`,
        `  任务: ${l.prompt.slice(0, 60)}${l.prompt.length > 60 ? '...' : ''}`,
        `  下次触发: ${nextStr}`,
      ].join('\n');
    });
    return {
      reply: [`⏱ 运行中的 loop (${loops.length} 个):`, '', ...lines, '', '用 /loop stop <id> 停止'].join('\n'),
      handled: true,
    };
  }

  const trimmed = args.trim();

  // /loop stop <id> 或 /loop stop all
  if (trimmed.toLowerCase().startsWith('stop')) {
    const target = trimmed.slice(4).trim();
    if (!target || target.toLowerCase() === 'all') {
      const count = removeAllLoops(accountId);
      return { reply: count > 0 ? `✅ 已停止全部 ${count} 个 loop。` : 'ℹ️ 没有运行中的 loop。', handled: true };
    }
    const ok = removeLoop(target);
    return { reply: ok ? `✅ 已停止 loop [${target}]。` : `未找到 loop [${target}]，用 /loop 查看列表。`, handled: true };
  }

  // /loop <interval> <prompt> — 解析间隔
  const parts = trimmed.split(/\s+/);
  const intervalError = getLoopIntervalError(parts[0] ?? '');
  if (intervalError) {
    return {
      reply: [
        intervalError,
        '',
        '用法: /loop <间隔> <提示>',
        '例:   /loop 5m 检查 CI 是否通过',
      ].join('\n'),
      handled: true,
    };
  }
  const intervalMs = parseInterval(parts[0]);
  if (!intervalMs) {
    return {
      reply: [
        '间隔格式无效，支持: 30s / 5m / 2h / 1d（最小 1 分钟，最大 30 天）',
        '',
        '用法: /loop <间隔> <提示>',
        '例:   /loop 5m 检查 CI 是否通过',
      ].join('\n'),
      handled: true,
    };
  }
  const prompt = parts.slice(1).join(' ').trim();
  if (!prompt) {
    return { reply: '请提供要执行的任务描述。\n例: /loop 5m 检查 CI 是否通过', handled: true };
  }

  return { handled: true, startLoop: { prompt, intervalMs } };
}

/** /goal — 设置持续目标，转发给 Claude 执行 */
export function handleGoal(_ctx: CommandContext, args: string): CommandResult {
  const CLEAR_ALIASES = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'];

  // /goal 不带参数 — 查询当前状态
  if (!args) {
    return {
      handled: true,
      claudePrompt: '/goal',
    };
  }

  const input = args.trim().toLowerCase();

  // /goal clear / stop / off ...
  if (CLEAR_ALIASES.includes(input)) {
    return {
      handled: true,
      claudePrompt: '/goal clear',
    };
  }

  // /goal <条件> — 设置目标
  return {
    handled: true,
    claudePrompt: `/goal ${args.trim()}`,
  };
}

export function handleAdvisor(ctx: CommandContext, args: string): CommandResult {
  const VALID_MODELS = ['opus', 'sonnet', 'fable'];
  const DESCRIPTIONS: Record<string, string> = {
    opus:   '强推理，适合复杂任务的规划与决策',
    sonnet: '均衡，适合日常任务的二次确认',
    fable:  '最强能力，需要 Fable 5 访问权限',
  };

  if (!args) {
    const current = ctx.session.advisor;
    const currentLine = current ? `当前 Advisor:\n  ${current}` : `当前 Advisor:\n  未启用`;
    const list = VALID_MODELS.map(m =>
      `  ${m === current ? '▶' : ' '} ${m}  — ${DESCRIPTIONS[m]}`
    ).join('\n');
    return {
      reply: ['🧠 Advisor 工具', '', currentLine, '', '可选模型:', list, '', '用法:', '  /advisor <模型>  启用，例: /advisor opus', '  /advisor off     关闭'].join('\n'),
      handled: true,
    };
  }

  const input = args.trim().toLowerCase();

  if (input === 'off' || input === 'none' || input === 'disable') {
    ctx.updateSession({ advisor: undefined });
    return { reply: '✅ Advisor 已关闭', handled: true };
  }

  // 接受别名或完整 model ID（如 claude-opus-4-8）
  const isAlias = VALID_MODELS.includes(input);
  const isFullId = /^claude-/.test(input);
  if (!isAlias && !isFullId) {
    return {
      reply: `无效的 advisor 模型: ${input}\n可选别名: ${VALID_MODELS.join(' / ')}\n也可传完整 model ID，例: claude-opus-4-8`,
      handled: true,
    };
  }

  ctx.updateSession({ advisor: input });
  const desc = DESCRIPTIONS[input] ?? '自定义模型';
  return {
    reply: [
      `✅ Advisor 已设为:\n  ${input}`,
      '',
      desc,
      '',
      'Advisor 会在 Claude 做出关键决策时自动介入，消耗额外 token。',
      '⚠️ 需要 Claude Code v2.1.170+，当前版本不支持则自动忽略。',
    ].join('\n'),
    handled: true,
  };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args ? `Use the ${skill.name} skill: ${args}` : `Use the ${skill.name} skill`;
    return { handled: true, claudePrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 skill: ${cmd}\n输入 /skills 查看可用列表`,
  };
}
