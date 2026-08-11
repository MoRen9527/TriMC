// ── TriMC MirrorStore ──
// S7: In-memory task mirror storage with CRUD + markUnknown.
// MVP uses Map<string, MirrorTask> — post-MVP migrates to SQLite/PG.
// CPO Q6c + CTO §7.2 S7 §2.3.

import type {
  MirrorTask,
  MirrorTaskStatus,
  MirrorRequest,
  MirrorResponse,
  TaskQueryParams,
  TaskQueryResponse,
} from './types.js';
import { TERMINAL_STATUSES } from './types.js';

/** 最大 summary 长度 */
const MAX_SUMMARY_LENGTH = 500;

function buildKey(nodeId: string, taskId: string): string {
  return `${nodeId}:${taskId}`;
}

export class MirrorStore {
  private tasks = new Map<string, MirrorTask>();  // key = `${nodeId}:${taskId}`
  private versionCounter = 0;

  /**
   * 写入/更新一批镜像任务。
   *
   * 规则：
   * - 新 taskId → 插入，firstSeenAt = now
   * - 已有 taskId → 只更新 status/summary/updatedAt/lastSeenAt，version+1
   * - 不允许 status 从 terminal 回退到非 terminal（CPO 6c: TriLC 是权威方，
   *   但 TriMC 做基本防御：如果现有状态是 success/failed/cancelled 且新状态
   *   是 running，记录 warning 但仍接受——因为可能是 TriLC 恢复后的全量推送）
   */
  mirror(nodeId: string, tasks: MirrorRequest['tasks']): number {
    const now = new Date().toISOString();
    let mirrored = 0;

    for (const t of tasks) {
      const key = buildKey(nodeId, t.taskId);
      const existing = this.tasks.get(key);

      // 截断 summary
      const summary = t.summary.length > MAX_SUMMARY_LENGTH
        ? t.summary.slice(0, MAX_SUMMARY_LENGTH - 3) + '...'
        : t.summary;

      if (!existing) {
        // 新任务：插入
        const task: MirrorTask = {
          taskId: t.taskId,
          nodeId,
          title: t.title,
          status: t.status,
          summary,
          updatedAt: t.updatedAt,
          lastSeenAt: now,
          firstSeenAt: now,
          version: ++this.versionCounter,
        };
        this.tasks.set(key, task);
        mirrored++;
      } else {
        // 已有任务：增量更新
        // terminal defense: 如果现有状态是 terminal 且新状态是 running，接受但记录
        if (TERMINAL_STATUSES.has(existing.status) && t.status === 'running') {
          // TriLC 恢复后的全量推送 — 接受但记录 warning
          console.warn(
            `[trimc:mirror] terminal→running accepted (recovery push): ` +
            `${nodeId}/${t.taskId} ${existing.status}→${t.status}`,
          );
        }

        // 检查是否有实际变更（幂等）
        const changed =
          existing.status !== t.status ||
          existing.summary !== summary ||
          existing.title !== t.title;

        if (changed) {
          existing.status = t.status;
          existing.summary = summary;
          existing.title = t.title;
          existing.updatedAt = t.updatedAt;
          existing.lastSeenAt = now;
          existing.version = ++this.versionCounter;
          mirrored++;
        } else {
          // 仅更新 lastSeenAt（心跳）
          existing.lastSeenAt = now;
        }
      }
    }

    return mirrored;
  }

  /**
   * 标记某节点所有非 terminal 任务为 unknown。
   * 由 heartbeat handler 在检测到节点超时时调用。
   */
  markNodeUnknown(nodeId: string): number {
    const now = new Date().toISOString();
    let count = 0;

    for (const [key, task] of this.tasks) {
      if (task.nodeId === nodeId && !TERMINAL_STATUSES.has(task.status)) {
        task.status = 'unknown';
        task.updatedAt = now;
        task.version = ++this.versionCounter;
        count++;
      }
    }

    return count;
  }

  /** 查询任务列表 */
  query(params: TaskQueryParams = {}): TaskQueryResponse {
    const { nodeId, status, limit = 50, offset = 0 } = params;

    let tasks: MirrorTask[] = [];

    // 默认不返回 unknown 超过 1 小时的任务（可配置）
    const maxUnknownAgeMs = 60 * 60 * 1000;
    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (nodeId && task.nodeId !== nodeId) continue;
      if (status && task.status !== status) continue;

      // 过滤过期 unknown
      if (task.status === 'unknown') {
        const age = now - new Date(task.lastSeenAt).getTime();
        if (age > maxUnknownAgeMs) continue;
      }

      tasks.push(task);
    }

    // 按 updatedAt 降序排序
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const total = tasks.length;
    tasks = tasks.slice(offset, offset + limit);

    return { tasks, total };
  }

  /** 单任务查询 */
  getTask(nodeId: string, taskId: string): MirrorTask | undefined {
    return this.tasks.get(buildKey(nodeId, taskId));
  }

  /** 获取某节点所有活跃（非 terminal）任务，用于恢复后全量推送 */
  getActiveByNode(nodeId: string): MirrorTask[] {
    const active: MirrorTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.nodeId === nodeId && !TERMINAL_STATUSES.has(task.status)) {
        active.push(task);
      }
    }
    return active;
  }

  /**
   * 清理 terminal 状态超过指定毫秒数的旧任务。
   * 防止内存无限增长。
   * @param maxAgeMs 最大保留时间（默认 24 小时）
   */
  cleanup(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, task] of this.tasks) {
      if (TERMINAL_STATUSES.has(task.status)) {
        const age = now - new Date(task.lastSeenAt).getTime();
        if (age > maxAgeMs) {
          this.tasks.delete(key);
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  /** 获取当前总任务数 */
  get size(): number {
    return this.tasks.size;
  }
}
