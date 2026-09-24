# 可选 CLI 执行入口

## 已选方案

主会话编排 → TaskCenter 路由与 delegation → 已授权 CLI → 证据回写。保留 `roles.executor`、`roles.reviewer` 和正式 Reviewer 协议；可选客户端与型号只在 `config/model-roles.json / cli_profiles` 配置。不自动调度，不新建普通子任务，不修改用户认证或全局配置。

`cli_profile` 是普通 executor 的显式单次选择，不能用于正式 OCR/Reviewer 路由或覆盖任务的 quota_preferred 策略。外部 Agent 可以把 OCR delegate 的冻结材料作为只读执行输入，输出只是候选审查证据；本入口不调用 review_finish、不产生独立验收。正式 Reviewer 仍使用原入口。接入某个 CLI 不等于切换默认 Reviewer。

## 派发

1. 主会话建立任务与合同。写入执行时先在隔离 worktree 中登记主任务；现有 delegation 要求 workspace 与主任务完全相同，不会自动搬移任务或创建 worktree。
2. 主会话调用 `taskcenter_routing_select`，指定 `channel: "cli"`、普通 `task_class` 和 `cli_profile: "kimi-k3"` 或 `"claude-mimo"`。检查 `available`，保留返回的 `route_id`、`selected_model` 和 `reasoning_effort`。无可用路由时不启动。
3. 主会话调用 `taskcenter_delegation_grant`，以返回型号作为 `executor_model`，显式填写 scope、workspace、TTL 和 allowed_tools；保留 delegation ID 与一次性 claim token。不要放入 Git、prompt 或日志。
4. 在 ReqRadar 工作目录使用 `node scripts/delegated-cli.mjs --stdin`；从其他项目工作目录启动时，使用 `node /Users/gezi/Documents/project/ReqRadar/scripts/delegated-cli.mjs --stdin`，并保持命令的 `workdir` 为被授权项目。Hook 校验脚本解析后的真实路径，CLI 路由不能授权同名的其他脚本。Codex `exec_command` 须对这条精确命令使用 `tty: true`，取得 session 后通过 `write_stdin` 发送一行以换行结束的 `{"manifest":{...},"prompt":"有界任务输入"}`；非交互执行会关闭 stdin。交互式豁免只覆盖受信任启动器的 `--stdin` 命令，仍要求有效 CLI 路由。prompt 最多 32 KiB；manifest 包含以下字段，但省略 `prompt_path` 和 `output_path`，由启动器创建权限 0600 的临时文件。启动前无需主会话写文件。旧 manifest 文件入口仍兼容。manifest 字段如下：

```json
{
  "profile": "kimi-k3",
  "task_id": "原正式任务ID",
  "parent_session_id": "原真实SessionID",
  "route_id": "路由ID",
  "delegation_id": "委派ID",
  "claim_token": "一次性授权值",
  "workspace": "/已绑定的绝对工作区",
  "prompt_path": "/临时目录/有界任务输入.txt",
  "output_path": "/临时目录/唯一结果.json",
  "mode": "read-only",
  "timeout_ms": 300000
}
```

`mode` 必填，可选 `read-only` 或 `workspace-write`。输出路径及 `.log` 必须尚不存在，防止误覆盖或无意重放。日志上限 16 MiB；输出只包含有界摘要、身份、请求型号、报告型号、请求/确认推理档位、原始终止类型与回写错误。主会话负责核对产物和测试；CLI exit 0 或模型自称完成不构成验收。

5. 启动器等待真实身份：Kimi 在提交 prompt 前登记并 claim；Claude 用注入的 SessionStart 登记/claim，PreToolUse 要求相同身份的领取凭据。claim 校验有效路由、任务、型号与 delegation 一致。未领取不能执行项目工具。
6. 启动器按原 delegation 回写，再回报 `routing_result` 释放租约。失败不重试、不换客户端；报告失败返回非零并保留结果文件，主会话据此补报。操作完成后删除自己创建的 manifest；内部包含 token 的临时副本会自动清理。

## 权限与限制

- Claude 只暴露 Read/Glob/Grep，写入模式额外开放 Write/Edit/Bash；注入现有 TaskCenter Hook，保留权限检查，不传 bypassPermissions，不向子客户端继承父 Session 身份或额外 MCP。
- Kimi 显式选择 `default` 手动权限模式，逐次权限请求交给既有 Hook，未知工具/参数拒绝。`read-only` 使用 ACP `plan`，客户端宣告不执行工具，所以要读取的 OCR 冻结材料需由主会话放入有界 prompt。它与 Claude 可读取文件的只读模式不是同一能力，不隐瞒差异。
- Hook 是生命周期守卫，不是操作系统沙箱。执行中已经启动的命令不因 TTL 到期自动终止；工作区隔离与用户原有客户端 Hook 仍需保留。不要把此入口作为运行不可信代码的安全容器。
- CLI 的完成回执与型号必须可观察；未提供型号、型号不一致或缺少终止回执，结果标为 unknown，路由记失败，禁止自动重试。模型名称是客户端报告，不能证明第三方代理后端的物理型号。
- 实际工具验证、测试质量及正式 Review/Acceptance 由主会话和独立流程负责，本入口不会将文本报告自动升级为通过。

## 推理档位探测（2026-09-20）

本机 Kimi Code 2.0.0 的 ACP `session/new` 返回 `thinking` 选项 low/high/max，默认 high；`session/set_config_option` 切换 low 后回显一致。当前普通执行选 low：这是遵守普通执行档位上限的保守起点，不是经过大量任务证明的最优点。启动时检查当前可用选项并要求服务端确认，版本不兼容就停止，不猜 medium 到 high 的映射。

本机 Claude CLI 提供 `--effort`，MiMo 通道暂选 medium 作为客户端请求值。MiMo [Responses 官方说明](https://mimo.mi.com/docs/en-US/api/chat/responses) 明确 low/medium/high 在该接口均表示开启思考，不区分强度；不能把该说明直接当成 Anthropic 兼容接口的实测。Claude 通道未返回后端档位时 `effective_effort=null`，不得宣称 medium 比 low 更好。后续只有代表性任务的正确率、耗时与用量对照才能支持调档。

## 验证与回滚

定向验证：`node --test tests/delegated-cli.test.mjs tests/kimi.test.mjs tests/routing-control.test.mjs`。真实 CLI 探测与隔离单元测试分别记录，不混用。

无新依赖、无独立调度服务。停止新派发即可停用；回滚上一已验证 release 前先结束或撤销在途授权。默认角色未改动，现有 Codex 执行和正式 Reviewer 无需迁移。
