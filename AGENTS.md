# ReqRadar Agent Rules

请首先阅读 `/Users/liuyuge/Documents/company-ai-agent/rules/AI_RULES.md`。

## 安全边界

- 本项目是独立、本地运行的 Codex 需求管理工具，不接入 ZhiCe WebUI。
- 只读访问 `~/.codex/sessions/**/*.jsonl` 和 `~/.codex/session_index.jsonl`。
- 禁止读取 `~/.codex/auth.json`、API Key、Cookie 或其他认证材料。
- 禁止向 `~/.codex` 写入任何内容。
- 不得把会话内容上传到远端服务；远端部署前必须重新设计脱敏和数据源。
- Assistant 的“已完成”只能记录为实现声明，不能自动升级为“已验收”。

## 验证

```bash
npm run sync
npm test
```

## ReqRadar 会话闸门

- 每个 Codex、Claude 或 WorkBuddy Session 开始处理任务前，必须调用 `reqradar_session_register`，提交真实 `session_id`、`workspace`、`agent`、`provider` 和 `model`。
- 随后必须调用 `reqradar_task_create`，只有返回 `accepted=true` 和独立 `task_id` 才能修改文件。
- 如果当前会话没有 ReqRadar MCP 工具，禁止写代码，执行只读检查并报告 `REQRADAR_UNAVAILABLE`。
- 不得使用会话标题、项目名或其他 Session ID 冒充当前会话身份。
