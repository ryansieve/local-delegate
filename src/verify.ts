import { config } from './config.js';
import { runShell } from './shell.js';
import type { VerifyReport, VerifyStep } from './types.js';

/** Runs verification commands in order, stopping at the first failure. */
export const runVerify = async (commands: string[], cwd: string, signal?: AbortSignal): Promise<VerifyReport> => {
  const steps: VerifyStep[] = [];
  for (const command of commands) {
    const result = await runShell(command, cwd, config.agent.commandTimeoutMs, config.agent.verifyOutputChars, signal);
    steps.push({ command, ...result });
    if (result.exitCode !== 0) return { passed: false, steps };
  }
  return { passed: true, steps };
};

export const formatReport = (report: VerifyReport): string =>
  report.steps
    .map(({ command, exitCode, timedOut, output }) =>
      `$ ${command}\n[exit ${timedOut ? 'timeout' : exitCode}]\n${output}`.trimEnd())
    .join('\n\n');

/**
 * Protected path patterns: "dir/" matches everything under dir, anything else matches exactly.
 * Kept deliberately simple; the spec author controls the list.
 */
export const isProtected = (path: string, patterns: string[]): boolean =>
  patterns.some((pattern) => (pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern));
