/**
 * internal-token — CLI 侧 X-Internal-Token 解析（LG-012，2026-08-28）。
 *
 * 背景：服务端 /internal/* token 门（9fc919e）落地时 CLI 调用面未同步，
 * cron add/list 等全 401（LG-011 实测，中枢经 API 直调绕过）。本模块补齐
 * CLI 侧读取，服务端不动。
 *
 * 读取顺序：env TRIMC_INTERNAL_TOKEN → 模块相对 TriMC 仓 docker/.env → cwd
 * 探测链（进程 cwd 自身 + 上溯至多 3 个祖先目录，逐档探测 <cand>/docker/.env，
 * 首个命中即用；服务器 /srv/fleet/TriMC/docker/.env 由 cwd=仓根形态达成）。
 * 三链皆无 = 未配置，行为同旧（服务端 401）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 * 解析内部 token：env TRIMC_INTERNAL_TOKEN 优先，其次模块相对 TriMC 仓
 * docker/.env，最后兜底 cwd 探测链。
 * - 模块相对路径（../docker/.env）：src 面（src/internal-token.ts → 仓根
 *   docker/.env）命中；dist 面不命中——dist/src/internal-token.js →
 *   dist/docker/.env，而 dist 目录无 docker/ 子目录（dist 布局比 src 多一层
 *   src/，「编译态 dist/../docker/.env 同构」是错误假设）。dist 面兜底依赖
 *   cwd 链。
 * - cwd 探测链：自 cwd 起上溯至多 3 个祖先目录，逐档探测 <cand>/docker/.env，
 *   首个命中（可读且含同名键）即返回。
 * 三链皆无 = 未配置，返回 undefined（行为同旧）。
 *
 * @param env 环境变量面（默认 process.env；测试/调用方可注入空面以隔离）。
 * @param cwd 探测链起点（默认 process.cwd()；测试可直接注入受控目录）。
 */
export function resolveInternalToken(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const fromEnv = env.TRIMC_INTERNAL_TOKEN;
  if (fromEnv) return fromEnv;
  const fromModule = readModuleEnvToken();
  if (fromModule !== undefined) return fromModule;
  return probeCwdChain(cwd);
}

/** 模块相对 docker/.env 读取（src 面命中仓根 docker/.env；dist 面不存在/不可读 → undefined）。 */
function readModuleEnvToken(): string | undefined {
  try {
    const envFile = fileURLToPath(new URL('../docker/.env', import.meta.url));
    return parseInternalTokenFromEnvText(readFileSync(envFile, 'utf-8'));
  } catch {
    return undefined; // 文件不存在/不可读/无同名键 → 让下游 cwd 链接管
  }
}

/**
 * cwd 探测链：自 cwd 起上溯至多 3 个祖先目录，逐档探测 <cand>/docker/.env，
 * 首个命中（可读且含 TRIMC_INTERNAL_TOKEN 键）即返回 token；全链未命中
 * 返回 undefined。
 */
function probeCwdChain(cwd: string): string | undefined {
  let cur = cwd;
  for (let depth = 0; depth <= 3; depth++) {
    try {
      const token = parseInternalTokenFromEnvText(readFileSync(join(cur, 'docker', '.env'), 'utf-8'));
      if (token !== undefined) return token;
    } catch {
      // 该档无 docker/.env 或不可读 → 上溯下一档
    }
    const parent = dirname(cur);
    if (parent === cur) break; // 已达文件系统根（POSIX /、Windows 盘根）
    cur = parent;
  }
  return undefined;
}
