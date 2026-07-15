# CTO-015: E2E Real Model Smoke Test

- **Date**: 2026-07-15
- **Status**: Code ready, awaiting API key injection to execute
- **Test file**: `test/e2e/real-model-agent.test.ts`
- **Run command**: `npm run test:e2e -- --test-timeout=120000`
- **Requires**: `DEEPSEEK_API_KEY` environment variable

## 范围

四个真实 DeepSeek API 端到端测试套件：

1. **Contract-driven Q&A** — 通过完整 pipeline（Soul Loader → Memory Injector → Context Builder → Tool Gater）调用真模型，验证 JSON 和 SSE 两种模式。
2. **Tool calling** — 在 `tmpdir()` 创建临时文件，通过 agent contract 声明 `read_file` 工具，验证真模型能正确调用工具读取文件并返回内容。
3. **Legacy no-contract** — 无 contract 字段时走原生 agentLoop，验证向后兼容路径在真模型下正常。
4. **Multi-turn conversation** — 两轮对话，验证上下文保持。

## 设计决策

- **零 mock**：所有套件直接调用 DeepSeek API（`https://api.deepseek.com/v1/chat/completions`）
- **优雅跳过**：无 `DEEPSEEK_API_KEY` 时所有 `describe` 块带 `{ skip: "DEEPSEEK_API_KEY not set — skipping E2E" }`
- **长超时**：60-90s，因真 API 响应 + 工具调用可能有延迟
- **真文件测试**：Tool calling 测试写一个临时文件到 `tmpdir()`，要求 agent `read_file` 它，验证返回内容包含期望字符串。通过 contract 的 `tools` 字段声明。
- **独立于 validate.mjs**：E2E 测试在 `test/e2e/` 子目录，常规 validate.mjs 运行时跳过（Node test 把 skip suite 计为 0 test），需显式 `npm run test:e2e` 或 `--target` 指定

## 待办

- [ ] 设置 `DEEPSEEK_API_KEY` 后运行 `npm run test:e2e -- --test-timeout=120000`
- [ ] 验证 4 suites 全部通过（预期 4-6 个子测试）
- [ ] 更新本文件状态为 DONE
- [ ] Commit
