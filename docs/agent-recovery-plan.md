 > 历史设计记录：模型路由、委派与托管 Reviewer 已退役。本文不构成当前执行规则；现行边界见 README 的「主线治理边界」。

# 拒绝诊断与 Agent 不可用恢复方案

日期：2026-10-09。状态：格子已批准方案 A；实现与验证记录见第 13 节。

核对源码基线：`c5247aca9d3b05ed1dfc28b5c176b31d008112b1`。本文只新增方案文档；未修改业务代码、提交或部署。实施时重新核对相关文件的增量，不覆盖期间其他任务的修改。

## 1. 决策与成功标准

推荐 **方案 A：复用现有拒绝评估与路由恢复指引，纠正过时提示，补齐只读页面展示**。保持 Node、React、现有控制面和原生派发架构，不新增 npm 依赖、数据库、调度服务或自动恢复引擎。

用户和 Agent 遇到问题时，应能确定：为什么被拒绝、谁来处理、下一步是什么、怎样确认可以继续。执行器不可用时，当前主模型能在既有授权下继续；权限条件不成立时，恢复指引不能变成越权通道。

| 选择 | 实施边界 | 收益与代价 |
| --- | --- | --- |
| **A，推荐** | 修正共用拒绝指引；展示现有 `next_action`；增加受限的拒绝记录 GET；明确历史记录适用性 | Agent、Hook、页面都有入口；增加少量控制面与 UI 代码，需要接口和安全回归 |
| B，缩减方案 | 只修正文案、展示路由 `next_action`，不增加拒绝记录查询 | 改动更小；无路由的拒绝仍只能从 Hook 输出排查，页面不能覆盖完整需求 |

已决事项：格子确认执行推荐方案 A 的完整范围，包含只读拒绝查询接口。实现任务 `task-9ae50a99-cbe0-4412-bfec-3382942e4efd`。无需重新选择技术栈。

成功标准：

1. 已知拒绝分类均有原因、可执行恢复步骤、验证方法；未知问题明确要求保留错误并核对前置条件。
2. 普通执行器缺少原生能力、过载、额度耗尽、熔断或运行失败，都有明确接管路径，不循环重试、不回退 CLI、不重复申请同一授权。
3. 历史失败、租约过期和执行器失联不会被展示成“已经接管”或“可以立即并发写入”。
4. 页面只提供解释和只读刷新；不会启动 Agent、撤销委派、变更审批、重启服务或修改角色配置来“修复”。
5. 不新增依赖，不放宽 MCP/构建/依赖体积预算，不恢复已经移除的 Bug 闭环和 Codex CLI 驱动能力。

## 2. 已验证现状与缺口

| 现有能力 | 源码证据 | 本次补齐 |
| --- | --- | --- |
| 单次、重复、批量拒绝有分类及 `reason/recovery/verification` | [governance-metrics.mjs](../scripts/governance-metrics.mjs)，`classifyGateDenial`、`evaluateGateDenials`、`formatGateDenialAssessment` | 更新 native-only 指引；防止宽泛规则吞掉具体分类；保留现有去重/窗口 |
| Hook POST 拒绝记录，输出恢复步骤；上报失败不改变拒绝结果 | [taskcenter-hook.mjs](../scripts/taskcenter-hook.mjs)，`reportGateDenial` | 控制面不可用时也输出有限本地指引，不只剩上报错误 |
| 普通任务无可用执行器时返回当前主模型有效 direct 租约 | [routing-control.mjs](../scripts/routing-control.mjs)，`buildUnavailableOrMainRoute` | 沿用，不重写选模、熔断、额度或并发算法 |
| 活跃主模型回退和失败的非 direct 路由有 `next_action` | 同上，`publicRoute` | 补齐拒绝/错误分支的说明；区分当前指引与历史参考 |
| 路由日志接口已经通过 `publicRoute` 返回指引，读取时处理过期租约 | 同上，`routingDecisions`；[control-server.mjs](../scripts/control-server.mjs)，GET `/routing/decisions` | UI 消费已有字段；防止旧失败记录误导当前执行 |
| MCP 有界返回第一层保留 `route.next_action` | [bounded-response.mjs](../scripts/bounded-response.mjs) | 检查超长回执下仍保留必要身份、状态、简短恢复提示和有效期，维持 4096 字节默认预算 |
| 路由页面展示原因码、回退原因、回执，没有消费 `next_action` | [RoutingDecisions.tsx](../features/console/RoutingDecisions.tsx) | 展示中文原因与下一步，保留技术码供定位 |
| 有 POST `/gate-denials`，没有对应 GET；控制代理白名单未允许该路径 | [control-server.mjs](../scripts/control-server.mjs)、[control-proxy.mjs](../lib/control-proxy.mjs) | A 中新增受限 GET，只读白名单仅放行 GET |
| 模型策略来自集中配置，普通执行为 native-only | [model-roles.json](../config/model-roles.json) | 不复制型号、不修改配置；保留历史 CLI 回执兼容 |

具体过时内容包括：缺少路由时要求 direct/CLI、权限修正后重跑 CLI Run、交互拒绝推荐受管 CLI、文件权限建议修改旧 manifest；只读识别失败还建议直接去掉包装。它们必须按当前 native 策略与 RTK 规则纠正。

这不是“系统没有恢复能力”，而是恢复说明分散、部分失效、页面缺入口。TaskCenter 只记录、建议和签发租约，不负责启动/终止执行器；租约有效不等于工具可执行或任务已经成功。

## 3. 场景与处理责任

| 场景 | 下一步与责任人 | 恢复验证 / 停止条件 |
| --- | --- | --- |
| Session 未登记 | 当前 Agent 用真实 Session 登记；禁止自拟 ID | 登记 accepted，归属与 workspace 匹配 |
| 没有活跃任务 | 同一交付核对是否可接续；新目标 begin 新任务；只读查询不为门禁另建无关任务 | 获得 accepted 和独立 task_id；同 Session 不重叠活跃任务 |
| RTK/复合命令未识别 | 当前 Agent 拆分命令；仅按 RTK 明确允许的等价降级路径重试 | 同一 Hook 放行；权限拒绝不是包装问题，不能绕过 |
| 缺少/过期主模型路由 | 当前 Agent 在活跃正式任务下申请 direct，记录具体 direct_reason | 路由属于本 Session/任务、通道和有效期匹配；仍须通过操作门禁 |
| grant/claim、scope、workspace 或所有权不匹配 | 核对真实绑定，最多修正一次；失败后停止原执行器，按接管流程处理 | 新路由不扩大 scope；任务所有权或写范围仍不成立则不能写入 |
| 工具审批或文件权限拒绝 | 使用已授权工具、合法可写路径；确实缺少授权时说明需要用户处理的具体内容 | 以实际调用结果验证；不得调低审批、改沙箱或启用门禁豁免 |
| 原生能力缺失、配置无可派发候选 | 由现有路由策略返回当前主模型 direct；配置可见不等于 runtime 能派发 | 活跃 direct 租约可用，且确认同范围执行器没有继续写入 |
| server_overloaded、容量/额度不足、熔断 | 现有策略选可用候选，或主模型 direct；保留 HTTP、错误码、request ID、quota/retry 信息 | 不后台轮询、不重复撞击；下一次合格派发才重新探测 |
| spawn、初始化、工具或执行阶段失败 | 原执行器最多修正一次前置条件；仍失败则主模型完成受控接管 | 必须确认原执行器不再写入；不能把“回报失败”当作“已经停止” |
| 执行器失联，无法确认停止 | 当前主模型保留证据，继续不涉及重叠写入的工作；报告具体阻塞与人工核对方法 | 未确认停止前禁止接管同范围写入；租约过期也不证明进程已退出 |
| TaskCenter/MCP/control 不可用 | 本仓库 gate-enabled 维护仅只读，报告 `TASKCENTER_UNAVAILABLE`；使用既有有限服务恢复入口 | 恢复后核对 Session、任务和路由；保护健康实例，不直接 restart，不扩散到外部项目构建门禁 |
| Reviewer 不可用 | 如被明确要求审查，说明独立审查尚未完成；由用户安排后续 | 主模型不冒充独立 Reviewer；不自动派发、导入或等待；Review 本身不阻断已授权普通工作 |
| scheduled_readonly / Reviewer 只读拒绝 | 留在角色允许范围；业务修改由有权限的任务 Session 承接 | 越权操作必须继续被拒绝，不静默改角色或模式 |
| 已完成任务、旧路由、未知错误 | 显示历史参考或未知；重新读取当前状态和原始安全错误信息 | 不能从历史记录恢复活跃租约，不能凭通用文案宣称可继续 |

## 4. 普通 Agent 接管流程

### 4.1 选模阶段尚未启动执行器

1. 读取 `routing_select` 实际结果，而不是只看 selected_model。
2. 已返回 available、leased、未过期且匹配任务的 direct 时，确认无同范围写入者后直接使用，不重复申请路由。
3. 记录实际执行与验证结果；结束后 `routing_result` 释放租约。恢复不会授予新的任务权限。

### 4.2 执行器已启动后失败

1. 保存真实失败分类、错误码、HTTP、request ID；通过 `routing_result` 回报结果并释放原路由租约。不要伪造 succeeded，也不丢失原始失败。
2. 用宿主已有停止能力终止原执行器，并确认不再写入。路由释放、回执结束和心跳超时不能代替这个确认。
3. 撤销该 delegation，保留已写入内容与回执；核对未完成操作、脏文件及原任务 scope，避免重复执行不可幂等动作。
4. 请求 `routing_select(channel=direct, direct_reason=实际失败原因)`，获得 accepted 与有效路由后，由当前主模型继续同一已授权任务。
5. 若停止或撤销无法确认，禁止重叠写入；可继续独立只读调查，并明确最小人工解除步骤。若 direct 获取失败，仅修正输入/前置条件，不循环换模型掩盖门禁。

失败回报与停止动作可因宿主而先后不同，但接管写入前，失败记录、原执行器停止、委派撤销、新路由有效这四个条件都必须满足。TaskCenter 不新增进程控制权限。

### 4.3 用户授权边界

已授权任务的主模型接管不再次询问“是否允许主模型执行”。真正新增的 scope、审批、不可逆操作仍遵守原授权规则。禁止以 direct 回退处理凭据不足、跨工作区写入或任务所有权冲突。

## 5. 接口与数据设计

### 5.1 保持两套已有输出，不新增通用恢复协议

- 拒绝诊断继续使用 `assessment.category/level/reason/recovery/verification/counts`。
- 路由继续使用 `reason/fallback_reason/next_action/status/available/expires_at/result`；保留机器码及错误回执。
- 不引入恢复任务、策略 DSL、动作注册表或单独持久化 recovery 对象。提示生成复用现有函数；前端不维护另一套原因到步骤映射。

拒绝分类先匹配具体原因，最后才匹配泛化的 TaskCenter/CLI 错误；例如包含“缺少有效路由”的 TaskCenter 门禁提示应得到 missing_route，而不是泛化 task_permission。保留稳定分类码与历史兼容，测试覆盖真实提示形态。

权限提示使用当前宿主与原生 delegation 语义。历史 CLI 错误仍能解析和展示，但不会推荐新建 CLI grant 或启动 CLI。未知分类提供保守指引，原始错误只留在调用者现场，不随方案写入公共响应。

### 5.2 新增 GET `/gate-denials?limit=20`

仅用于当前本机控制台展示最近拒绝，不新增 MCP tool。

- `limit` 为整数，默认 20，范围 1–50；非法值返回 400。暂不增加分页、检索、自动修复或新的告警服务。
- 返回 `{ generated_at, records, assessments }`：records 只含现有安全字段 `at/category/source/session_id/task_id/run_id/failure_kind`；assessments 按本页涉及的类别去重，复用当前 1 小时窗口评估。
- assessment 是查询时的当前指引和窗口统计，不宣称重现拒绝当时的策略；超过窗口的记录明确标为历史参考。保留既有 60 秒去重、3 任务/5 Run 批量阈值、连续 3 次检测，不新增一套阈值。
- 读取既有大小受限日志，不新增无限增长缓存；损坏行按现有容错读取，缺失文件返回空列表。磁盘权限/I/O 错误返回“读取失败”，不能伪装成零拒绝。
- 返回前重新校验字段白名单与长度，不信任落盘 JSON；未知类别降为 gate_other，任意自定义字段不透出。
- `lib/control-proxy.mjs` 仅新增该 GET 路径和 limit 参数转发。页面无法通过此白名单 POST `/gate-denials`、撤销委派或变更任务权限。
- 沿用本机控制面的身份与暴露边界，不增加远程访问、CORS 或上传能力；安全检查确认 GET 不泄露 command、message、claim_token、会话正文、认证文件或环境变量。

此接口是 A 唯一必要的新读取入口。拒绝可以发生在登记前或没有 task 时，因此不能强制每条都绑定正式任务，也不能为展示补造关联 ID。

### 5.3 当前路由与历史参考

`publicRoute` 继续生成 next_action；GET `/routing/decisions` 在已有任务标题关联处增补只读 `recovery_applicability`：`current`、`reference_only`、`unknown`。

- current：任务仍活跃，且记录属于当前可核对的阶段/路由；有效 direct 可以提示使用。当前失败的非 direct 只提示处理失败与申请 direct，不能提示直接写入。
- reference_only：任务已关闭、阶段已被后续路由接替、旧路由已完成或不再适用。仍可展示通用处理参考，但不显示“现在执行”的措辞。
- unknown：任务/阶段关联缺失或旧记录不足以证明适用性。显示“请先核对当前任务与有效路由”。

实施时按 task_id、phase_id 和后续记录判断，不以“该任务最新一条”掩盖并存的独立阶段；无法可靠关联就用 unknown。该字段不持久化、不授予执行权，也不代表已确认宿主进程停止。读取时的 expires_at 校验与现有权限校验必须保留。

旧客户端可忽略新增字段；新 UI 收到旧服务未提供的字段时按 unknown 展示，不自行推断可接管。历史数据不重写，不补造当时的步骤或执行事实。

### 5.4 Hook 与 MCP 的边界

- Hook 的服务端拒绝评估正常时沿用它；上报失败时复用本地分类/格式化函数给出单次恢复说明，明确“未记录、无批量判断”。不可用控制面只提示只读与恢复前置条件，不能假定任务有效。
- MCP 已有路由成功/失败响应保留 next_action；对缺任务、缺登记、绑定冲突等无路由的现有错误，复用安全分类输出原因、恢复与验证说明，不改变错误码、HTTP 或 accepted=false。
- 有界响应优先保留 accepted/error、task/route ID、channel/status/available、短 next_action 和有效期；过长回执摘要化，完整内容走既有 continuation。旧字段保持兼容，不通过放宽 4096 字节默认预算解决丢失指引。
- CURSOR_EXPIRED 仍要求重复原查询；展示当前状态前重新查询，不把过期 continuation 当作恢复凭证。

## 6. 页面行为

沿用模型调度页、console-card 和已有列表/刷新机制，不增加组件库或额外自动刷新定时器。

路由记录显示：中文原因与原码、实际回退去向、下一步、处理责任、当前/历史适用性、真实回执。next_action 缺失显示“未提供恢复指引”，不能把正常成功记录染成故障；任务完成、未知关联或过期记录显示参考提示。

拒绝记录使用一个轻量区块，显示时间、分类、可用的 Session/task/run ID、单次/重复/批量、原因、恢复、验证。没有 task 的拒绝可正常显示；记录读取失败与没有记录区分。支持已有只读刷新与条目展开，保留原码方便定位。

展示示例：

```text
原因：原生执行器无可用容量（保留原错误码）
处理：当前主模型确认原执行器不再写入后，使用有效 direct 路由继续。
状态：已提供接管路由；执行尚未确认完成。
验证：核对任务与租约有效，再检查实际工具结果及任务验收。
```

以上为方案示例，不是当前生产故障或实测结果。页面不展示不必要的工具实现细节；完整调用步骤放在展开区域或文档。使用普通文本渲染，不把错误中的内容解释为 HTML、可执行脚本或 shell 命令。

## 7. 实施文件与顺序

| 阶段 | 文件/消费者 | 可验收产出 |
| --- | --- | --- |
| P1：先纠正文案与诊断 | scripts/governance-metrics.mjs、scripts/taskcenter-hook.mjs；tests/gate-denial.test.mjs、tests/hook.test.mjs | native-only、RTK、权限边界一致；具体分类优先；上报失败仍有有限说明 |
| P2：只读接口与适用性 | scripts/control-server.mjs、scripts/routing-control.mjs、lib/control-proxy.mjs；tests/model-management.test.mjs、tests/tasks-workspace.test.mjs、tests/native-routing.test.mjs | 受限拒绝查询；当前/历史路由标记；旧返回兼容 |
| P3：展示与返回边界 | features/console/RoutingDecisions.tsx、features/console/ConsolePage.tsx；scripts/taskcenter-mcp.mjs、scripts/bounded-response.mjs（仅必要分支）；tests/request-budget.test.mjs、tests/usage-query.test.mjs、tests/routing-browser.mjs | UI 展示真实指引；有界 MCP 不丢恢复核心信息；页面不产生写操作 |
| P4：集成与交付 | README.md/相关操作说明、CHANGELOG.md 顶部 Unreleased；现有验证与体积脚本 | 验收证据、真实体积、兼容说明；按授权提交及受控部署 |

以上是预计消费者，实施前按函数调用核对最小集合；不为文件数量扩散修改。共用诊断更新影响 Hook 与历史 CLI 解析测试，不能只改单个页面。服务部署脚本与角色配置本方案不改。

各阶段依次执行，以完整 A 为一个交付目标；不创建独立恢复子系统、不默认派发审查。文档阶段不运行业务构建或故障注入。实施完成后按仓库规则提交本地 commit；部署等待该阶段的明确授权，不自动 push、创建 PR 或正式发布。

## 8. 验收矩阵

| 编号 | 可控输入 | 必须成立的结果 |
| --- | --- | --- |
| R1 | 未登记、无任务、缺路由各一例 | 分类正确，输出原因/恢复/验证，不泛化为工具权限 |
| R2 | 含 RTK 包装的只读识别失败、真实权限拒绝 | 指引遵守 RTK；不出现无条件去包装、关 Hook 或改豁免建议 |
| R3 | 无 native 候选、capacity、quota、熔断 | 按集中策略回退或返回主模型有效 direct；不要求重复授权、不启动 CLI |
| R4 | 执行器 failed/unavailable/overloaded，带 error_code 和 request_id | 原失败完整保留；提示停止、确认、撤销、direct；回报失败不等于已停止 |
| R5 | 无法确认执行器停止、scope 或 claim 冲突 | 不能给出无条件写入许可；指引说明阻塞与可继续的只读工作 |
| R6 | 过期 direct、旧失败后已有接管、任务关闭、旧阶段缺失 | reference_only/unknown；不把旧失败当当前动作，不显示已完成恢复 |
| R7 | 拒绝 GET limit=1/50、0/51/小数；日志缺失、损坏、I/O 失败 | 限制和错误明确；安全字段白名单；没有记录与读取失败区分 |
| R8 | 恶意日志含 command、message、token、自定义 HTML；经代理 POST 或未知参数 | 敏感字段不返回，HTML 仅文本；GET 白名单不开放写接口或透传任意参数 |
| R9 | MCP full/summary/超大回执/过期 continuation | 预算内保留必要身份及短指引；continuation 可取全文；过期要求重查 |
| R10 | control 不可用，Hook 上报失败 | 原拒绝状态保持；输出有限本地说明；不重启健康实例、不误称已记账 |
| R11 | Reviewer 不可用、Reviewer/scheduled_readonly 越权 | 不冒充 Review，不转普通执行绕边界；Review 状态如实，普通授权流程不新增阻塞 |
| R12 | 新 UI 读取旧响应、正常成功路由、无 next_action | 页面可显示且不报错；缺失是未知/未提供，成功不被标成失败 |
| R13 | 重复/批量拒绝与空 task_id | 现有去重和窗口统计一致；不重复制造告警或伪造任务归属 |
| R14 | 页面刷新与展开交互 | 只产生限定 GET；显示原因/步骤/验证及历史提示；没有派发、修复或授权 POST |

优先在既有测试入口的临时数据、可控时间及替身宿主中验证；不拿生产 Session 故意撞门禁、不消耗真实额度制造过载。真实 native 宿主停止能力只能由授权的隔离运行补充验证，不能用模拟用例冒充。

## 9. 验证、轻量化与防止劣化

实施阶段使用仓库规定入口（以下是计划命令，本文未执行）：

```bash
rtk proxy npm run sync
rtk proxy npm run typecheck
rtk proxy npm run lint
rtk proxy npm test
rtk proxy npm run size:check
rtk git diff --check
```

`npm test` 已包含 build 和相关预算/集成检查，按当前测试入口确认覆盖；已通过且环境未变不重复执行。缺失 MCP 预算覆盖时补 `npm run mcp:budget`。界面验证复用现有 browser fixture；只覆盖新增展示与历史状态，不引入浏览器测试依赖。

生产验收在独立临时目录进行，必要时使用 `npm run verify:production -- --install`；release 裁剪后用既有 release size gate，不能在开发目录 prune 破坏验证依赖。sync 只操作项目生成数据，不修改用户 Session 或认证文件。

**体积门禁沿用 [artifact-size-budget.json](../config/artifact-size-budget.json)**：

- 全部已校准指标继续 +2% 警告、+5% 阻断；不更新基线或阈值来容纳本次方案。
- 禁用包节点检查保持：Codex SDK/CLI、Cloudflare/Workerd、Next compiler、Drizzle 不得重新进入依赖树。
- `package.json` 与 lockfile 预期零变化，新增依赖数为 0；如实施证明确有依赖必要，先停下该部分，另给选择依据。
- 记录 client 原始/gzip、最大 JS、server、完整开发依赖、生产依赖及 release 字节，与配置基线比较；本方案不承诺尚未构建的增量数字。展示代码增长应在现有预算内，超限先定位来源。
- 未校准平台继续失败关闭，不伪造 Linux/Windows 测量，不把未校准误判为方案通过。
- 不增第二套路由状态持久化、额外轮询、常驻进程或无限日志；拒绝列表与评估复用受限日志和现有窗口。

防止指引再次失效：集中诊断函数是文案来源；回归用例约束当前 native-only 和安全含义，而非只匹配完整字符串。修改执行通道、grant、路由状态或 Hook 拒绝分类时同步检查 R1–R6、R9–R11；UI 只消费返回值，未知字段按保守状态处理。验收证据保留到当次 TaskCenter Subject，不新增永久报告生成系统。

## 10. 兼容、部署与回滚

1. 新 GET 与展示字段为增量；POST 拒绝上报、既有原因码、MCP tool 输入和历史 CLI 记录继续兼容。不增加 MCP tool、不迁移数据库、不改模型角色。
2. 更新 Unreleased，明确用户可见的诊断与展示变化；普通提交/部署不修改 SemVer。正式发布按 CONTRIBUTING 的唯一规则，需另有用户授权。
3. 健康正式实例在开发和验证期间持续运行。授权部署时只用 `npm run service:deploy`，候选独立端口/runtime/数据，切换前校验测试、revision 和干净工作区。
4. 回滚仅撤销本方案代码与新增只读展示；没有数据迁移，既有拒绝和路由日志保留。不能回滚成“允许绕过门禁”。
5. 前一轮用户已要求清理旧回滚产物，因此实施/部署前必须现场核对 release 清单：不能假设旧轻量化前版本仍可用。优先使用部署当时仍在运行且已验证的 release 作为切换失败恢复目标；后续发现问题用该保留版本或受控重建，不直接停止服务重装。

## 11. 证据、推断与待验证项

**项目事实**：第 2 节来源为本次读取的源码与已有测试定义；当前 Git 工作区在新增本文前干净。已有测试描述表明相关能力有覆盖，但本次没有重跑测试，不能据此声称当前全部回归通过。

**专栏证据**：《容量保障核心技术与实战》“容量治理的三板斧：扩容、限流与降级”，`sourceRelpath=容量保障核心技术与实战/04-容量治理的三板斧：扩容、限流与降级.md`，已读 `chunk_512b5d4458a2cbc838b4`（本地索引 2026-09-02）。文章支持按触发条件的确定性划分自动与人工处理，以及通过演练避免降级逻辑随迭代失效；其分布式容量背景不直接证明本项目应该自动接管。

**Agent 推断**：TaskCenter 已有选模回退和诊断链路，复用它们并补展示，比新增恢复调度器更符合本项目展示为主与轻量化目标。宿主停止状态无法由租约证明，因此安全接管需要主模型确认，不应由页面按钮自动完成。

**待验证**：真实 native 运行失败的宿主停止与回执行为；新 UI 的浏览器渲染；无路由 MCP 错误的具体返回分支；实现后的客户端增量与 release 预算；部署时实际可用回滚产物。这些均在实施阶段验收，不把方案设计当作实测结果。

## 12. 用户确认后的执行清单

- [x] 记录用户选择 A 及范围；创建实现任务和有效路由。
- [x] 按最新 revision 核对上述消费者和并行改动，保护健康实例。
- [x] P1 纠正诊断、分类与不可用时的本地说明。
- [x] P2 完成受限读取、代理边界与历史适用性。
- [x] P3 完成页面展示与 MCP 有界响应；不新增恢复执行动作。
- [x] 完成关键正反验收并区分模拟与真实证据；真实宿主停止能力未做故障注入。
- [x] 完成规定验证、体积门禁与 Unreleased；只记录实际通过项。
- 本地提交记录以 TaskCenter 最终证据为准；部署另待授权，届时核对回滚目标。

本次交付到方案文档为止。未修改业务代码、依赖或生产服务；未提交、部署、运行拒绝故障注入或独立审查。

## 13. 方案 A 实现与验证记录

2026-10-09，经用户“可以了 执行吧”批准，实施基线为 `3b68ac6ddcb9704b6bfbd44b8092eda9ec000990`。以上“只交付文档”描述是方案编写阶段的历史状态，本节记录后续实现。

- 已实现共用拒绝分类与 native-only/RTK 指引、Hook 上报失败本地说明、受限 GET/代理白名单、路由阶段适用性、MCP 错误恢复和有界核心字段保留、页面只读展示。无需统一恢复协议或新增 MCP tool。
- 新回归覆盖分类优先级、权限/停止边界、限量脱敏、空 task、历史/并存阶段、过期租约、MCP HTTP 错误、summary 与 continuation；既有 Hook HTTP fixture 验证查询和上报失败。`npm test` 完整通过 569/569。
- 隔离浏览器 fixture 验证当前/历史/旧响应、步骤与验证、文本转义、读取失败保留、恢复刷新；相关请求全部为 GET。截图与本次日志在 `/tmp/taskcenter-recovery-page.png`、`/tmp/taskcenter-recovery-browser.log`；它们是临时本机证据，不进入 release。
- `npm run sync`、typecheck、lint、完整测试和 diff 检查通过；lint 仍有两处此前已有未使用变量警告，未扩大本次范围处理。
- 构建预算全部通过：client 327,592 字节、gzip 101,096 字节、最大 JS 189,757 字节、server 661,823 字节、完整开发依赖 206,652,146 字节。相对固定基线 client +2,594 字节、gzip +777 字节；package/lock/体积预算/角色配置均未修改，新增依赖数为 0。
- 未在生产 Session 注入故障，未消耗真实额度制造不可用，未声称验证真实宿主终止能力；Reviewer、scheduled_readonly 与既有选模/权限算法继续使用已有回归证据。未启动独立 Review。Linux/Windows 未校准边界不变。
- 健康正式服务继续运行；本次不部署或推送。提交号与隔离生产验收结果记录在对应 TaskCenter 任务证据中。
- 隔离干净生产安装通过：6 个页面、47 个 MCP 工具、sync/watcher、无需 Codex CLI；生产依赖为 50,093,930 字节，release 全部指标低于现有警告阈值。临时生产目录由既有入口自动删除。
