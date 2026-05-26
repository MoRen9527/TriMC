# TriMC Code State

## Repository Map

- `src/index.ts`：进程入口，读取环境变量并启动 TriMC HTTP 服务。
- `src/server/`：当前主装配面；`app.ts` 暴露 `/healthz` 与 `POST /internal/v1/tasks` 两条最小接口。
- `src/task-controller/`：当前是任务接单占位控制器，`controller.ts` 只返回 queued placeholder。
- `src/node-bridge/`：当前只有 `bridge.ts`，提供 `offerTask()` 占位桥接实现。
- `src/policy-gate/`：已建目录，说明风险门禁已进入结构预留层，但本轮未见对外主入口装配。
- `src/observability/`：当前最成熟的代码面，包含 mapper、contract samples、timeline/replay API、runtime、Postgres client 与 SQL store。
- `src/contracts/`、`src/config/`、`src/types/`：协议、配置和类型支撑层。
- `test/`：当前已有 `observabilityMapper.test.ts` 与 `timelineReplayApi.test.ts` 两组 Node test，覆盖 observability/replay 基线。
- `sql/`：数据库初始化脚本，当前与 observability 相关落位最直接。
- `vendor/openclaw/`：上游 shadow 参考基线，需与 TriMC 自研代码显式区分。

## Current Code Health

- 代码结构清晰，现役主路径可以很快收敛到 `src/index.ts` -> `src/server/app.ts` -> `task-controller` / `observability`。
- 当前可运行的服务能力是最小骨架，不是完整控制平面；这让“代码实际成熟度”比目录规划更容易判断。
- observability/replay 代码与测试相对更具体，其他子系统仍以占位或薄实现为主。
- 2026-05-26 已补齐独立 git 仓、根级 `.gitignore` 与本地 CodeGraph 标配。
- 尚未建立 registry 级代码健康评分和 git 热区摘要。

## Change Tracking Baseline

- 首要关注 `src/server/`、`src/task-controller/`、`src/node-bridge/`、`src/policy-gate/`、`src/observability/` 和 `vendor/openclaw/` 的变化。
- 若 `/internal/v1/tasks` 从 placeholder 进入正式状态机、队列、审批或调度实现，应优先在本文件更新成熟度判断。
- 若 `node-bridge` 开始接入真实 Gateway / node registry / WebSocket 生命周期，也应单独记录从“占位桥接”到“现役桥接”的切换点。
- 若 future planner/context/tool orchestration/model-call 能力真正落地，应以新增目录、入口文件和测试为准，再更新登记层，不可提前写成已具备。
- 涉及具体项目代码仓库时，技术侧文档基线应按 `docs/engineering/DESIGN.md`、技术版 `ROADMAP.md`、技术版 `STATE.md` 以及 `docs/execution/<workstream>/<phase>/PLAN.md`、`SUMMARY.md`、`VERIFICATION.md` 维护；若缺失，应视为待补齐的技术或执行层缺口。

## Git Health

- 2026-05-26 已补齐独立 git 仓基线；后续由 `TriMCCodeRegistry` 继续维护分支、热区和 dirty worktree 摘要。
- 从当前仓结构看，现役自研代码、迁移测试、SQL 初始化与 vendored snapshot 已经分层，但后续仍需防止 shadow 资产和主实现混写。

## Local CodeGraph Index

- 2026-05-24 已在模块根目录建立本地 CodeGraph 索引，由 `TriMCCodeRegistry` 接管摘要与后续维护纪律。
- 当前索引摘要：17 files，82 nodes，144 edges；语言覆盖 `typescript`；backend 为 `node-sqlite`。
- `.codegraph/` 仅作为本地缓存与辅助索引，不作为模块真源提交；后续只在本文件记录扫描摘要、版本锚点、排除规则、入口与调用链发现、待确认缺口。
- 本地索引通过根级 `.gitignore` 排除 `.codegraph/`、`.cursor/`、`node_modules/`、`vendor/`、构建产物、覆盖率产物和环境文件；`vendor/openclaw/` 仍是 shadow 参考基线，但不进入本轮 CodeGraph 摘要。
- 首轮版本锚点：以本次本地扫描时工作区状态为准；后续正式收口时应补充对应 git commit / branch。

## Quality Risks

- `src/server/app.ts` 目前只提供健康检查和任务接单占位接口，若外部文档把它描述为完整服务域控制 API，会明显高估现役能力。
- `TaskController.acceptPlaceholder()` 只生成 queued 占位响应，说明任务状态机还没进入正式编排层。
- `NodeBridge.offerTask()` 当前仅做日志输出，说明节点桥接目前仍是占位，不应写成已具备稳定下发链路。
- `src/observability/` 是当前最成熟的落地面，因此很容易让人误以为 TriMC 已整体完成迁移；实际上 observability 已落、控制平面仍薄。
- `README.md` 的长期目标口径和当前代码成熟度存在差距，registry 需要持续扮演“防过度表述”的收口层。
- `vendor/openclaw/` 若与 `src/` 不持续区分，后续很容易把 shadow 吸收层误写成 TriMC 自研现役实现。

## Sources

- `../../package.json`
- `../../src/index.ts`
- `../../src/server/app.ts`
- `../../src/task-controller/controller.ts`
- `../../src/node-bridge/bridge.ts`
- `../../src/observability/`
- `../../src/observability/timelineReplayApi.ts`
- `../../test/observabilityMapper.test.ts`
- `../../test/timelineReplayApi.test.ts`
- `../../sql/`
- `../../README.md`
