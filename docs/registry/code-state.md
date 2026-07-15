# TriMC Code State

## Repository Map

- `src/index.ts`：进程入口，读取环境变量并启动 TriMC HTTP 服务。
- `src/agent-loop/`：Agent 循环实现，`loop.ts` 提供 `agentLoop()` async generator（while-true + tool dispatch + context injection），`tools.ts` 提供 6 个内置工具注册表（含 task 子代理 spawn），`permissions.ts` 提供三级代理权限模型（main/subagent/coordinator）。已吸收 Claude Code queryLoop 和 constants/tools.ts 权限模式。Phase 1-4 吸收分析已完成，CTO-008/009 权限系统已闭环，CTO-004 Context Builder 已集成。
- `src/server/`：当前主装配面；`app.ts` 暴露 `/healthz` 与 `POST /internal/v1/agent` 两条接口，以及 `GET /internal/v1/agent/stream` SSE 流。
- `src/task-controller/`：**v1.0 已完成**（CTO-007）。`controller.ts` 提供完整任务生命周期：`createTask`/`getTask`/`listTasks`/`updateTaskStatus` + 状态机（queued→running→completed/failed/cancelled）+ 终态不可逆 + 向后兼容 `acceptPlaceholder`。30 tests，全部通过。
- `src/node-bridge/`：当前只有 `bridge.ts`，提供 `offerTask()` 占位桥接实现。
- `src/policy-gate/`：已建目录，说明风险门禁已进入结构预留层，但本轮未见对外主入口装配。
- `src/observability/`：当前最成熟的代码面，包含 mapper、contract samples、timeline/replay API、runtime、Postgres client 与 SQL store。
- `src/contracts/`、`src/config/`、`src/types/`：协议、配置和类型支撑层。
- `test/`：当前已有 `observabilityMapper.test.ts` 与 `timelineReplayApi.test.ts` 两组 Node test，覆盖 observability/replay 基线。
- `sql/`：数据库初始化脚本，当前与 observability 相关落位最直接。
- `vendor/openclaw/`：已裁为薄参考层（2026-07-10 中央收口），社交通道归入 TriGateway，消息队列归入 TriMC，不再作为 agent runtime 参考主线。
- `vendor/claude-code/`：Claude Code 2.1.88 restored-src 复制的吸收基线，作为 TriMC agent 循环 infra 层。同源代码同时驱动本地 Claude Code CLI 演练场与 TriMC 服务器，保证 dev-prod parity。Phase 1 核心 Loop 吸收分析已完成（`docs/engineering/claude-code-absorption/phase-1-core-loop.md`）。
- 编排层四组件（v0.2.0 目标）：Soul Loader（agent contract → 系统提示词）✅、Memory Injector（四层记忆 → memdir/）✅、Tool Gater（PolicyGate → canUseTool hooks）✅、Context Builder（公司背景 + registry 引用 → CLAUDE.md 注入）✅。全部嵌入 Claude Code `query.ts` 上下文注入链路，不做重新实现。当前完成度：**4/4 ✅ v0.2.0 编排层完成**。

## Current Code Health

- 代码结构清晰，现役主路径可以很快收敛到 `src/index.ts` -> `src/server/app.ts` -> `task-controller` / `observability`。
- 当前可运行的服务能力是最小骨架，不是完整控制平面；这让“代码实际成熟度”比目录规划更容易判断。
- observability/replay 代码与测试相对更具体，其他子系统仍以占位或薄实现为主。
- 2026-05-26 已补齐独立 git 仓、根级 `.gitignore` 与本地 CodeGraph 标配。
- 2026-07-10：确立 Claude Code 2.1.88 为 agent infra 层，OpenClaw 裁为薄参考；编排层四组件（Soul/Memory/ToolGater/Context）落地范围与嵌入路径确定。当前 v0.1.0 主干（HTTP server + Agent Contract resolver + observability/replay + heartbeat checker）+ v0.2.0 目标（编排层 + Claude Code 嵌入 + cron daemon）。
- **商用里程碑约束**：当前 TypeScript 实现为 Phase 2-3 快速验证路径；商用部署前必须择机转为 Go 或其他自主研发语言实现以规避版权风险。此约束需写入工程 ROADMAP 商业里程碑段。
- 尚未建立 registry 级代码健康评分和 git 热区摘要。
- **2026-07-14（CARRY-004）**：Docker 多阶段构建完成（137MB）、docker-compose（TriMC + PostgreSQL）健康检查通过（`/healthz` → 200）、K8s manifests 已通过 TriDeployment scaffold 生成（Deployment / Service / HPA / PDB / Kustomization）。
- **2026-07-14（CTO-007）**：agent loop 接入 TriModel UsageAccumulator，跨 turn TokenUsage 累计，`loop_end` 事件统一携带 `UsageSummary`。
- **2026-07-14（CTO-007 Smoke Test）**：小全+小柯流水线烟雾测试完成。TaskController v1.0（30 tests）+ validate.mjs 验证器（3 门禁，85 tests 全量通过）+ CTO 审查 sign-off。`scripts/validate.mjs` 可用作后续积木的质量门禁工具。
- **2026-07-15（CTO-008 Tool Permission System）**：吸收 Claude Code constants/tools.ts 三级权限模型。新增 `permissions.ts`（AgentTier: main/subagent/coordinator），loop.ts 支持 tier 参数和执行前 canUseTool 检查。26 测试 + 全量 111/111 PASS。子代理递归防护（task 工具被禁用于 subagent）。
- **2026-07-15（CTO-009 Agent Spawn Tier Integration）**：闭合 CTO-008 权限模型的最后缺口——task handler 调用 `agentLoop()` 时注入 `tier: 'subagent'`。子代理实际 spawn 路径上 tier 限制生效（5 工具，无 task）。新增 tool_blocked 事件捕获 + Suite 9 合约测试。全量 115/115 PASS。
- **2026-07-15（CTO-004 Context Builder）**：v0.2.0 编排层首个落地组件。`src/context-builder/` 提供 `buildContext()` + `mergeContextWithPrompt()`——将项目上下文（AGENTS.md、registry、tier 能力、角色标签）组装为 system prompt 前缀，以 `---` 分隔。`AgentLoopOptions` 新增 `context?: ContextSources`，`agentLoop()` 自动注入。16 测试 + 全量 131/131 PASS。
- **2026-07-15（CTO-005 Soul Loader）**：v0.2.0 编排层第二个落地组件。`src/soul-loader/` 提供 `contractToPrompt()` + `contractToContextSources()`——将 AgentContract 六要素（Identity/Responsibilities/Decision Rights/Collaborators/Instructions/Tools）转换为结构化 Markdown 系统提示词，写入 ContextSources 以注入 agentLoop pipeline。23 新测试 + 全量 154/154 PASS。
- **2026-07-15（CTO-006 Memory Injector）**：v0.2.0 编排层第三个落地组件。`src/memory-injector/` 提供 `injectAll()` + `buildMemoryContext()` + `contractToSoulMemory()`——将四层记忆（soul/memory/colleagues/social）转换为 memdir/ Markdown 文件（YAML frontmatter + body），产出 `extraContext` 行注入 Context Builder pipeline。吸收 Claude Code memdir/ 约定。25 新测试 + 全量 179/179 PASS。
- **2026-07-15（CTO-011 Tool Gater）**：v0.2.0 编排层第四/最后一个组件。`src/tool-gater/` 提供 `checkToolPermission()` + `createToolGater()` + `summarizeGater()`——将 tier-based 权限（permissions.ts）和 contract-driven risk 评估（PolicyGateService）合并为统一门禁 hook，注入 agentLoop 工具分发前检查。两层模型：tier 优先 → risk 评估（low→auto, medium→audit, high→block, critical→deny）。`AgentLoopOptions.toolSpecs` 可选，向后兼容。27 新测试 + 全量 206/206 PASS。**v0.2.0 编排层 4/4 完成** 🎉。
- **2026-07-15（CTO-012 Pipeline Integration）**：v0.2.0 编排层端到端集成测试。`test/pipeline-integration/pipeline.test.ts` 验证 `assemblePipeline()`——将四组件（Soul Loader / Memory Injector / Context Builder / Tool Gater）从 AgentContract 到 AgentLoopOptions 的完整流水线组装。7 suites, 34 tests。全量 240/240 PASS, tsc clean。小柯验证模式。**v0.2.0 集成验证完成** ✅。

## Change Tracking Baseline

- 首要关注 `src/server/`、`src/task-controller/`、`src/node-bridge/`、`src/policy-gate/`、`src/observability/` 和 `vendor/openclaw/` 的变化。
- ~~若 `/internal/v1/tasks` 从 placeholder 进入正式状态机、队列、审批或调度实现，应优先在本文件更新成熟度判断。~~ **已达到（CTO-007）**：TaskController 状态机已实现，尚未装配到 HTTP 路由——下一步是 `src/server/app.ts` 集成。
- 若 `node-bridge` 开始接入真实 Gateway / node registry / WebSocket 生命周期，也应单独记录从“占位桥接”到“现役桥接”的切换点。
- 若 future planner/context/tool orchestration/model-call 能力真正落地，应以新增目录、入口文件和测试为准，再更新登记层，不可提前写成已具备。
- 涉及具体项目代码仓库时，技术侧文档基线应按 `docs/engineering/DESIGN.md`、技术版 `ROADMAP.md`、技术版 `STATE.md` 以及 `docs/execution/<workstream>/<phase>/PLAN.md`、`SUMMARY.md`、`VERIFICATION.md` 维护；若缺失，应视为待补齐的技术或执行层缺口。
- Claude Code 吸收分析文档位于 `docs/engineering/claude-code-absorption/`，按 Phase 1-4 分阶段产出，当前 Phase 1（核心 Loop）已完成。

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
- ~~`TaskController.acceptPlaceholder()` 只生成 queued 占位响应，说明任务状态机还没进入正式编排层。~~ **已解决（CTO-007）**：TaskController v1.0 已包含完整状态机和 30 个自动化测试。
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
