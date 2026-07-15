# CTO-011: Unified Tool Gater

## 状态：COMPLETE ✅

## 概述

Tool Gater 是 v0.2.0 编排层第四个（也是最后一个）落地组件。它将 `permissions.ts`（tier-based 权限）和 `PolicyGateService`（contract-driven risk 评估）合并为统一的 `checkToolPermission()` hook，注入 agentLoop 的工具分发前检查。

## 两层门禁模型

```
工具调用 → checkToolPermission(toolName, tier, toolSpecs?)
              │
              ├─ Layer 1: canUseTool(toolName, tier)
              │   • main: 全部允许
              │   • subagent: read_file, glob_search, shell_exec, write_file, edit_file
              │   • coordinator: task only
              │
              └─ Layer 2: PolicyGateService.evaluateTool(toolSpec)
                  • low → auto-allow
                  • medium → allow with audit log
                  • high → block (approval required)
                  • critical → deny (no override)
```

## 文件位置

| 文件 | 内容 |
|------|------|
| `src/tool-gater/gater.ts` | 统一门禁实现（~120 行） |
| `src/agent-loop/loop.ts` | 集成点修改（line 170-171） |
| `test/tool-gater/gater.test.ts` | 测试（~230 行，6 suites，27 tests） |

## 导出 API

| 函数 | 用途 |
|------|------|
| `checkToolPermission(toolName, tier, toolSpecs?)` | 统一两层检查 |
| `createToolGater(toolSpecs?)` | 工厂返回 `ToolGaterFn` |
| `summarizeGater(toolSpecs?)` | 风险等级摘要（用于日志） |

## 关键设计决策

- **向后兼容**：不传 `toolSpecs` 时行为与原始 `canUseTool()` 完全一致
- **Tier 优先**：tier 检查先于 risk 检查——tier 被拒绝时不再检查 risk
- **medium = allowed_with_audit**：中风险工具允许但带有审计标记（future: 写入审计日志）
- **high = blocked**：高风险工具在 MVP 阶段直接阻止（无审批系统）
- **工具不在 specs 中 = tier-only**：仅 tier 检查，不评估 risk（安全默认：允许）
- `AgentLoopOptions.toolSpecs` 可选——不破坏现有调用方

## 验证结果

- **tsc --noEmit**：✅ PASS
- **测试**：27/27 PASS（全量 206/206 PASS）
- **门禁**：typeCheck + allTests + minTestCount 全部通过

## 测试覆盖

| Suite | 测试数 | 覆盖 |
|-------|--------|------|
| Tier checks (no toolSpecs) | 6 | main/subagent/coordinator 三层 tier |
| Risk-level checks (with toolSpecs) | 7 | low/medium/high/critical + empty + tool not in specs |
| createToolGater factory | 5 | bound gater + tier before risk |
| summarizeGater | 4 | empty/mixed/all-low |
| Backward compatibility | 3 | no-toolSpecs = original canUseTool |
| Edge cases | 3 | undefined specs, high risk not in spec list, requires_approval |

## 编排层嵌入路径（最终态）

```
AgentContract → Soul Loader → ContextSources.systemPrompt
            → Memory Injector → extraContext (via buildMemoryContext)
            → Tool Gater → AgentLoopOptions.toolSpecs
                    ↓
              Context Builder → mergeContextWithPrompt()
                    ↓
              agentLoop() ──→ checkToolPermission(toolName, tier, toolSpecs)
```

## v0.2.0 编排层完成度

| 组件 | CTO | 状态 |
|------|-----|------|
| Context Builder | CTO-004 | ✅ COMPLETE |
| Soul Loader | CTO-005 | ✅ COMPLETE |
| Memory Injector | CTO-006 | ✅ COMPLETE |
| Tool Gater | CTO-011 | ✅ COMPLETE |

**v0.2.0 编排层 4/4 完成** 🎉
