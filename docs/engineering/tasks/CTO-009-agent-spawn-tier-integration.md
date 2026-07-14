# CTO-009: Agent Spawn Tier Integration

> **依赖**: CTO-008 Tool Permission System  
> **小全 + 小柯 Pipeline**: ✅ Phase 1-2 complete, Phase 3 CTO review

## 背景

CTO-008 建立了三级代理权限模型（`main`/`subagent`/`coordinator`），并在 `loop.ts` 的 `agentLoop()` 中实现了运行时 tier 检查（`canUseTool` 前置校验 + `tool_blocked` 事件）。但 `tools.ts` 的 task handler 调用 `agentLoop()` 时**没有传递 `tier: 'subagent'`**——子代理默认获得 `main` 层级的全部 6 个工具，意味着 CTO-008 的权限模型从未在子代理 spawn 路径上生效。

CTO-009 的任务就是闭合这个缺口：将 `tier: 'subagent'` 注入 task handler 的 `agentLoop()` 调用。

## 改动范围

仅一个文件的 task handler，约 10 行变更：

| 文件 | 变更 |
|------|------|
| `src/agent-loop/tools.ts` | task handler 注入 `tier: 'subagent'`；更新工具描述；捕获 `tool_blocked` 事件 |
| `test/agent-loop/permissions.test.ts` | +4 测试（Suite 9：Task Handler 层级注入合约） |

## Phase 1: 小全实现

### tools.ts 三处改动

1. **任务工具描述（L331）**
   - 旧：`"The sub-agent has access to all tools..."`
   - 新：`"...runs with restricted permissions (5 tools: read/write/edit, shell, glob — no task to prevent recursion)..."`

2. **agentLoop 调用（L357-362）**
   - 注入 `tier: 'subagent'` → `agentLoop({ model, tier: 'subagent', systemPrompt, messages, maxTurns })`

3. **tool_blocked 事件捕获（L367-369 新增）**
   - 捕获 `event.type === 'tool_blocked'` → 写入 `errorMessage` 带 `[tier:subagent]` 前缀

### permissions.test.ts: Suite 9（4 测试）

- task 工具描述验证（提及 "5 tools"、"no task"、"recursion"）
- `loop_start` 合约：tier=subagent 时 availableTools=5
- AgentLoopOptions.tier 类型安全（接受 main/subagent/coordinator）
- tool_blocked 事件契约（tool_name + reason + errorMessage 格式）

## Phase 2: 小柯验证

```
node scripts/validate.mjs
```

| 门禁 | 结果 |
|------|------|
| TypeScript 类型检查 | ✅ PASS |
| 全部测试 | ✅ 115/115 PASS |
| 最小测试数 | ✅ 115 ≥ 1 |

## 设计决策

| 决策 | 说明 |
|------|------|
| task handler 显式传 `tier: 'subagent'` | 不由 agentLoop 推断——task handler 明确知道自己在 spawn 子代理 |
| tool_blocked 事件写入 errorMessage | 主代理可从返回 JSON 的 `error` 字段看到子代理被阻止的工具调用 |
| 不传 `parentCallIds` | 当前无调用链追踪模型；未来需要时再扩展 AgentLoopOptions |

## 影响分析

- **子代理工具集**: 从 6 → 5（移除 task）
- **递归防护**: 子代理无法调用 task → 无法创建孙代理
- **向后兼容**: 主代理行为不变（不传 tier 时默认 main）
- **LLM 提示**: 工具描述告知 LLM 子代理无 task 工具

---

## CTO Sign-off

> **Approved ✅**  
> Phase 1-2 全部 115/115 测试 PASS，类型检查通过。  
> task handler tier 注入是 CTO-008 权限模型的最终闭环——子代理不再拥有 task 工具。
