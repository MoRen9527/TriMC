# TriMC Cron Scheduler 运维 Runbook（周平面迁移五段链）

## 文档同步元信息

- sourceOfTruth: TriMC/docs/ops/trimc-cron-plane-shift-runbook.md
- syncMode: source-only
- lastSyncedAt: 2026-08-13

> 关联：TriMC/docs/engineering/trimc-scheduler-adapter-design.md（r1-1 APPROVED，r1-2 实现）
> 树：TriMetaverse/docs/workflow/operating-records/2026-W33/trees/prod-grade-1-trimc-weekly-cron

## 1. 架构速览

```
trimc.service（root，tsx 直跑）
  └─ src/cron/（JobExecutor 调度循环 + command-handler）
       └─ 周日 23:00 Asia/Singapore 触发（cron `0 23 * * 0`）
            └─ runAs fleet：python3.8 五段链 --sync
                 ├─ /srv/fleet/TriMetaverse 写 docs/workflow/operating-records/
                 ├─ git add + commit（内联身份 TriMC Scheduler）
                 └─ git push /srv/git/TriMetaverse.git HEAD:dev
```

- 存储：`/var/lib/trimc/cron/jobs.json`（TRIMC_CONFIG_DIR=/var/lib/trimc，service drop-in 注入）
- 日志：`/var/lib/trimc/cron/logs/<jobId>__<ISO>.log` + systemd journal（`journalctl -u trimc`）
- 解释器：**python3.8**（服务器系统 python3.6.8 不兼容 `from __future__ import annotations`，checklist #2 定案 A'）

## 2. 部署步骤（代码版本更新）

1. 本地 push sg-server（编排层执行；收口复核 `git ls-remote`）
2. 服务器：`cd /srv/fleet/TriMC && git pull`（**执行身份 root**——root pull 会把 TriMC 工作区新文件写成 root 属主；fleet 只消费 TriCompany/TriMetaverse 两仓，TriMC 仓属主 root 无碍；也可 `runuser -u fleet` pull 保持 fleet 单主体，二选一记录在案）
3. **TriMetaverse 仓 .git 属主修正**（root pull 后新对象为 root 属主，fleet 无法写 index/refs）：
   `chown -R fleet:fleet /srv/fleet/TriMetaverse/.git`（r1-2 P4 实测：曾发现 838 个 root 属主文件阻断 fleet git 段）
4. `systemctl restart trimc`
5. 验证：`curl -s http://127.0.0.1:8710/healthz | grep -o '"cron":{[^}]*}'`

## 3. 装周平面迁移 job（首次/重装）

```bash
cd /srv/fleet/TriMC
npx tsx src/cli.ts cron add --plane-shift   # 预设：周日 23:00 Asia/Singapore + runAs fleet
npx tsx src/cli.ts cron list
```

验证触发链路（不跑真迁移）：

```bash
# 测试根 dry 链（无 --sync 不写；或改用 --sync 在测试 operating-root 全链写验证）
cd /srv/fleet/TriCompany && python3.8 -m runtime.cognition.weekly_plane_shift \
  --from W33 --to W34 --start-date 2026-08-17 \
  --operating-root <测试根> [--sync]
```

真迁移触发（编排层定案：不做人工提前点火）：

```bash
# 主路径：自然触发 —— r1-3 验证 PASS 后由 cron 周日 23:00 Asia/Singapore 自动首跑
# 兜底：cron 未触发时手动补跑（幂等：重复跑安全）
npx tsx src/cli.ts cron run <jobId>
npx tsx src/cli.ts cron log --job-id <jobId> # 审计
```

写路径前置验证（fleet 身份，r1-2 P4 实测通过）：`/home/fleet` 存在（command-handler HOME 覆盖有效）、
`.git` 递归 fleet 属主后 `git add` 可写 index、`git diff --cached --quiet` no-op 幂等。

## 4. 本地回流（运维步骤，调度器不负责）

服务器 push 裸仓后，本地执行：

```bash
cd D:/Code/ai/TriMetaverse && git pull sg-server dev
```

**边界**：服务器无法触发本地动作；本地回流由编排层（小贾）执行。调度器职责止于服务器侧 push 裸仓。

## 5. 异常处理

| 症状 | 处置 |
| --- | --- |
| healthz cron.enabled=false | `systemctl restart trimc`；查 `journalctl -u trimc -n 50` |
| job 卡 running（崩溃残留） | service.start() 自动重置（stale-run 恢复）；手动：编辑 jobs.json 置 runningAtMs=null 后 restart |
| consecutiveFailures ≥ 3（degraded） | `trimc cron log` 查错误尾部；修复后 `trimc cron run <id>` 重跑（幂等） |
| 五段链失败 | 脚本幂等：create already_exists 不失败、carry_over 目标存在即 skip；修正后直接重跑 |
| 周平面文件被误改 | 本地 pull 回流后 diff 审查；写方向单主体（服务器只写 operating-records/） |

## 6. 约束与纪律

- 代码修改一律本地发起（本地 → 裸仓 → 舰队克隆）；服务器只写周平面文件（生产级开发期 §三方向例外）
- 迁移窗口单实例：runningAtMs 守卫 + 单 systemd 实例
- 真迁移触发时机由编排层决定（硬 deadline 2026-08-16 23:59 前可触发 W33→W34）
- scheduler 未就绪时迁移走既有路径兜底（服务器手工执行同命令链）
