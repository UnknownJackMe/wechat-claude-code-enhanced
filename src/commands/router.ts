import type { Session } from '../session.js';
import { findSkill } from '../claude/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleSend, handleResume, handleEffort, handleAdvisor, handleGoal, handleLoop, handleConfigs, handleSwitchConfig, handleSetConfig, handleDeleteConfig, handleSetupWizard, handleUnknown } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  claudePrompt?: string;
  sendFile?: string;
  compactSession?: boolean;
  startLoop?: { prompt: string; intervalMs: number };
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Claude)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'skills':
      return handleSkills(args);
    case 'history':
      return handleHistory(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'compact':
      return handleCompact(ctx);
    case 'resume':
      return handleResume(ctx, args);
    case 'effort':
      return handleEffort(ctx, args);
    case 'advisor':
      return handleAdvisor(ctx, args);
    case 'goal':
      return handleGoal(ctx, args);
    case 'loop':
      return handleLoop(ctx, args);
    case 'configs':
      return handleConfigs(ctx);
    case 'set-config':
      return handleSetConfig(ctx, args);
    case 'switch-config':
      return handleSwitchConfig(ctx, args);
    case 'delete-config':
      return handleDeleteConfig(ctx, args);
    case 'send':
      return handleSend(ctx, args);
    case 'version':
    case 'v':
      return handleVersion();
    default:
      return handleUnknown(cmd, args);
  }
}

export { handleSetupWizard };
