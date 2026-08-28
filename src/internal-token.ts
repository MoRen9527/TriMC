/**
 * internal-token — CLI 侧 X-Internal-Token 解析（LG-012，2026-08-28）。
 *
 * 背景：服务端 /internal/* token 门（9fc919e）落地时 CLI 调用面未同步，
 * cron add/list 等全 401（LG-011 实测，中枢经 API 直调绕过）。本模块补齐
 * CLI 侧读取，服务端不动。
 *
 * 读取顺序：env TRIMC_INTERNAL_TOKEN → 兜底解析 TriMC 仓 docker/.env 同名键
 * （服务器 /srv/fleet/TriMC/docker/.env；对齐 TriLC trimc-auth 模式与 FADE-006
 * Close CLI 载体先例）。两处皆无 = 未配置，行为同旧（服务端 401）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 从 .env 文本解析 TRIMC_INTERNAL_TOKEN 键（引号/首尾空白容错；缺键返回 undefined）。 */
export function parseInternalTokenFromEnvText(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*TRIMC_INTERNAL_TOKEN\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']+|["']+$/g, '');
  }
  return undefined;
}

/**
 * 解析内部 token：env TRIMC_INTERNAL_TOKEN 优先，其次 TriMC 仓 docker/.env
 * （路径相对本模块：src/../docker/.env，编译态 dist/../docker/.env 同构）。
 */
export function resolveInternalToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.TRIMC_INTERNAL_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const envFile = fileURLToPath(new URL('../docker/.env', import.meta.url));
    return parseInternalTokenFromEnvText(readFileSync(envFile, 'utf-8'));
  } catch {
    return undefined; // docker/.env 不存在/不可读 = 未配置
  }
}
