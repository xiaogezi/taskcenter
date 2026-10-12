 > 历史设计记录：模型路由、委派与托管 Reviewer 已退役。本文不构成当前执行规则；现行边界见 README 的「主线治理边界」。

# 轻量化执行方案：移除 Bug 闭环与 Codex 执行依赖

- 日期：2026-10-08（Asia/Shanghai）
- 状态：用户已批准执行；P1–P4 本机实现与验证，跨平台基线校准待完成；未提交、未部署
- 实施代码基线：`201e567b335133e09990718fc4e2b210b94b9a4a`
- 项目目录：`/Users/gezi/Documents/project/ReqRadar`

最初方案取证基线为 `2486f8d2848e7cee8b1ebcf6f20a5c240648e49f`。实施前刷新为上述 revision，已包含 CLI 模型目录新增消费者；本次一并退休该消费者。第 2 节保留方案制定时的现状，第 12 节记录实际结果，不能将旧观察值当作优化后的数字。

## 1. 结论与授权边界

推荐按以下顺序推进：**完整移除 Bug 闭环 → 取消项目内 Codex 主动执行能力并卸载依赖 → 验证发布依赖裁剪 → 固化体积预算**。保留展示、同步、本地任务记录、MCP 登记和通用验证/验收协议，不引入另一套 Agent 执行框架。

这条路径优先减少真实消费者，再移除依赖，最后收紧预算。只隐藏入口、把依赖改成可选安装、改用全局 Codex CLI，都无法达到本方案推荐的运行边界。

| 事项 | 当前状态 | 执行条件 |
| --- | --- | --- |
| Bug 专属流程全部移除 | 已批准并实现 | 历史数据保留，退休输入明确拒绝 |
| Codex SDK/CLI 移除 | 已批准并实现 | 含模型目录和内置 Reviewer 启动；外部回报协议保留 |
| release 构建后裁剪开发/可选依赖 | 已实现并通过隔离生产启动 | 正式部署仍需另行授权 |
| 固定体积预算 | 本机门禁已实现 | 未校准的平台阻断，发布清理仍单独授权 |
| 本轮写入 | 代码、依赖分类、配置、测试、文档和 Unreleased | 不改变 SemVer，不删除真实运行数据 |
| Git 提交与部署 | 用户明确要求暂不提交，未授权部署 | 不因文档完成或实现完成自动恢复提交；等待后续指令 |

用户已选择该执行边界：取消项目自身的 Codex 会话创建、消息投递、CLI 委派、改进任务自动启动和试点唤醒。保留 Codex 记录读取和外部客户端协议，不要求用户卸载桌面 Codex 或全局 CLI。

## 2. 现状、体积口径与收益

### 2.1 已验证事实

- `package.json` 直接依赖 `@openai/codex-sdk`；本机安装版本为 `0.149.1`，它依赖同版本 `@openai/codex`，后者通过可选依赖安装平台二进制。
- Bug 功能包含 React 入口、独立持久队列、`codex queue` 宿主唤醒、人工验收和本地 Git 合入核验，还参与任务完成判定。
- Codex SDK 另有会话创建消费者；CLI 另有会话恢复和 `app-server --stdio` 委派消费者。移除 Bug 功能不足以卸载 SDK/CLI。
- `config/model-roles.json` 的普通 executor 通道为 `native`。TaskCenter 的路由、租约、登记和回报协议与内置 Codex CLI 进程不是同一能力。
- `scripts/taskcenter-control.mjs` 创建独立 release worktree，执行完整 `npm ci` 后构建；当前安装流程没有 `--omit=dev`，也没有构建后的开发依赖裁剪。
- `scripts/release-retention.mjs` 已有安全清理：保留当前 release 和上一不同成功 release，检查受管目录、标记、Git 身份、用户改动和运行实例健康。无需另造清理器。
- `scripts/codex-compaction-host.mjs` 使用原生 WebSocket 连接已有本地宿主，不启动 Codex CLI。不能因文件名含 Codex 就将它和 SDK 一起删除。
- 并发工作区另出现 `scripts/harnesses/codex-model-catalog.mjs`：通过启动 `codex app-server` 查询 `model/list`，控制面新增 `GET /routing/model-catalog`。即使只查询元数据、不创建 turn，它仍是 CLI 消费者；该能力尚未包含在本方案 HEAD 基线内。

### 2.2 本机观察值

测量环境：macOS / arm64，当前命令使用 Node.js `v26.7.0`。项目声明的最低 Node 版本为 `22.13.0`；后续对比必须记录实际 Node/npm 版本，不能跨环境直接比较。

| 口径 | 本轮观察值 | 解释 |
| --- | ---: | --- |
| 工作区 `node_modules` 分配磁盘占用 | 1,146,836 KiB，约 1.09 GiB | 完整安装，包含开发依赖；不是前端下载体积 |
| `node_modules/@openai` 分配磁盘占用 | 276,000 KiB，约 269.5 MiB | 本机目录内为 Codex SDK/CLI 相关包 |
| 平台包 `@openai/codex-darwin-arm64` | 约 269 MiB | 上述依赖链的主要占用；不能再次相加 |
| 工作区已有 `dist` 分配磁盘占用 | 1,708 KiB，约 1.67 MiB | 含构建产物；未重新构建，也未确认产物所属 revision |
| `.local/releases` 总分配磁盘占用 | 2,316,140 KiB，约 2.21 GiB | 多版本历史占用；不代表单次发布包大小 |

以上采用独立 `du -sk <路径>` 调用，单位为 KiB。它是文件系统分配占用；逻辑字节、gzip 字节、tarball 大小另行测量。`build/` 是仓库构建插件源码目录，不用作产物体积指标。

### 2.3 预测与限制

| 阶段 | 可预期收益 | 尚不能承诺的数字 |
| --- | --- | --- |
| 移除 Bug 闭环 | 减少入口、队列、协议和状态分支；MCP schema 缩小 | 不承诺依赖目录明显下降 |
| 完整移除 Codex SDK/CLI 依赖链 | 同环境下预计减少约 269.5 MiB；完整依赖约从 1.09 GiB 降至 0.83 GiB，约 24% | 不是浏览器下载体积或发布 tarball 的同等降幅 |
| release 开发依赖裁剪 | 减少每个 release 的安装占用 | 尚未核实生产启动闭包，暂不设置绝对 MiB 目标 |
| 发布留存清理 | 限制历史版本累积 | 回收量取决于版本数量及保留版本；不得与依赖收益重复计算 |

**0.83 GiB 是第二阶段后的条件估算，不是最终轻量化验收目标。**若仍不符合产品预期，先用干净安装与生产运行闭包定位剩余占用，再单独选择构建栈调整方案。本方案不预先承诺几十 MiB，也不直接重写为另一个框架。

## 3. P1：完整移除 Bug 闭环

### 3.1 改动清单

| 位置 | 操作 | 必须保留的边界 |
| --- | --- | --- |
| `features/tasks/BugDetails.tsx`、`BugDispatch.tsx` | 删除组件 | 普通任务详情继续可用 |
| `features/tasks/TaskWorkspace.tsx` | 删除 Bug tab、渲染、徽标及专属入口 | 概览、调度、证据、活动和普通任务操作 |
| `lib/task-workspace.mjs` | 删除 `bug` tab、`bugs/awaiting_merge/completed_bugs` 桶 | 通用 `awaiting_acceptance` 不删除 |
| `app/globals.css` | 删除 `.bug-details` 专属样式 | 共享样式不按名称猜测删除 |
| `lib/control-proxy.mjs` | 删除 Bug 路径白名单 | 其他接口来源/权限限制 |
| `app/api/control/[...path]/route.ts` | 删除 Bug 来源判断和合入专用 timeout | 通用写请求来源检查及超时 |
| `scripts/control-server.mjs` | 删除 Bug imports、队列实例、路由、统计桶、错误类型和 `wakeBugDispatcher` | 通用 task、MCP、routing、verification、acceptance 接口 |
| `scripts/bug-workflow.mjs`、`bug-dispatch-queue.mjs` | 删除专属实现 | 不删除对应历史数据文件 |
| `scripts/taskcenter-mcp.mjs` | 删除任务输入的 `bug` 字段及 `taskcenter_bug_dispatch_host` | 其余运行时参数校验和工具身份绑定 |
| `scripts/task-ledger.mjs` | 停止新 Bug 字段写入，删除专属验收/合入标记授权与资料更新失效逻辑 | 老字段透传、旧账本和事件可读、通用验收记录 |
| `scripts/completion-state.mjs` | 删除 Bug 验收/合入附加门槛、派生 `bugClosure`、专属证据选择及 packet 业务字段 | Subject 绑定、失败/过期验证、独立验收权限 |
| `tests/bug-dispatch-queue.test.mjs`、`bug-dispatch-control.test.mjs` | 删除旧功能测试或改为退休入口/历史保护测试 | 隔离测试环境，不操作真实会话 |
| `tests/task-ledger.test.mjs`、`tasks-workspace.test.mjs`、`mcp-schema.test.mjs` 等 | 替换旧 Bug 闭环预期，加入第 3.3 节回归 | 不用删除断言掩盖通用任务回退 |
| `README.md`、`docs/harness-adapters.md`、`docs/mcp-schema-budget.md`、`CHANGELOG.md` | 收口现行能力说明；更新顶部 Unreleased；历史决策明确标注已被替代 | 本轮仅方案，以上文件当前不修改 |

### 3.2 协议与历史数据处理

| 项目 | 新版本行为 |
| --- | --- |
| `GET /bug-dispatches` | 退休，控制服务返回 404；不读取/写入 Bug 队列 |
| `GET/POST /tasks/:id/bug-dispatch` | 退休，返回 404 |
| `POST /tasks/:id/bug-dispatch/control` | 退休，返回 404 |
| `POST /bug-dispatches/host` | 退休，返回 404 |
| `POST /tasks/:id/bug`、`bug-acceptance`、`bug-merge` | 退休，返回 404；浏览器代理也不再放行 |
| MCP `taskcenter_bug_dispatch_host` | 不出现在 `tools/list`；调用返回未知工具错误 |
| 新事件携带 `bug`、`bug_merge`、`bug_acceptance` | 写入前明确拒绝，返回可识别的 400 错误；不静默忽略或假装成功 |
| 旧 URL `tab=bug` | 回落到概览 |
| 旧 URL Bug 专属 bucket | 回落到全部任务，避免显示无解释的空列表 |
| 历史任务/事件中的 Bug 字段 | 原样保留为历史事实；不再影响通用完成判定 |
| 历史 acceptance 记录 | 保留原 actor/source/subject/outcome；不补写人工通过 |
| `data/bug-dispatches.json` 或环境指定的旧队列 | 保留原文件，不初始化、不重放、不唤醒 |

字段拒绝只针对新业务写入。历史读取、可信历史证据恢复与原事件重放不能经过“新写入退休字段”限制而失去可恢复性；若某个旧提交重试接口也带退休字段，应明确返回退休错误，不将其视为新成功写入。禁止批量改写旧事件或生成等价的伪造新事件。

新版本可能使某些原本仅被 Bug 合入门槛阻挡的任务按通用规则就绪；这是判定规则变化，不代表自动完成了验收或合并。实际状态和证据保持原值。

### 3.3 验收出口

- [ ] 页面无 Bug tab、徽标、筛选或派发按钮；旧链接有明确回落。
- [ ] 退休 HTTP/MCP 入口不可用，不能绕过代理直接调用控制面。
- [ ] 新写入含退休字段时被明确拒绝，账本、事件和队列字节不变化。
- [ ] 历史 Bug 夹具仍能读取并在后续普通更新后保留原字段；导出/恢复可用路径也覆盖同一夹具。
- [ ] 历史 Bug 和不带 Bug 的等价任务，通用就绪判定一致；失败、过期、未验收仍按现行协议处理。
- [ ] 控制服务启动或轮询不再唤醒 Bug 宿主；旧队列文件校验和不变化。
- [ ] MCP 总字节和 tokens 不高于阶段前基线；其余工具 compact/inline 校验继续通过。

**阶段出口：功能及协议收口通过；本阶段不卸载 Codex SDK。**

## 4. P2：取消内置 Codex 执行能力并卸载依赖

### 4.1 推荐保留/取消边界

| 能力 | 推荐处理 | 理由与产品变化 |
| --- | --- | --- |
| Session JSONL/索引读取、用量、忙碌状态观察 | 保留 | 展示所需；不需要 SDK/CLI |
| 任务展示、同步、归档等本地记录操作 | 保留 | 本地管理能力，不启动 Agent |
| MCP task 登记、路由、native grant/claim/report/revoke | 保留 | 外部宿主执行并回报；核心无需内置 Codex CLI |
| 历史 CLI 执行记录和回报/撤销兼容协议 | 保留 | 可审计历史、可收口迟到回执；保留接口不等于允许新 CLI grant |
| Codex SDK `createSession` | 取消 | 不再从本工具启动隐藏 Codex 会话 |
| Codex CLI `resumeSession`、`runDelegatedCli` | 取消 | 不再从本工具驱动本地 Codex 进程 |
| 新增 CLI 模型目录扫描（并发变更） | 若后续合入，一并取消 CLI 扫描 | 保留集中配置模型展示；不把配置目录冒充实时宿主目录 |
| Dashboard `/dispatch` 新建/恢复投递及队列自动发送 | 取消 | 不能把需求按钮保留成失效的执行入口 |
| 改进建议分析、接受/拒绝 | 保留 | 本地建议和记录操作 |
| 改进建议 `/reflections/:id/execute` 自动创建/驱动任务 | 取消 | 接受建议不再启动 Agent |
| context_management 试点展示、历史结果与 trials 回报 | 保留 | 展示与回执可脱离主动执行 |
| `/context-management-pilots/intents` 的主动请求和唤醒 | 取消 | 当前消费者会恢复主脑 Session；删除依赖时必须同步收口 |
| 连接已有本地宿主的压缩/恢复协议 | 保留现状 | 使用原生 WebSocket，不带平台二进制；是否进一步删除是另一产品选择 |
| Kimi/Claude 现有适配、外部 Review | 不在本阶段新增或替换 | 不将 Codex 移除扩成所有客户端重构；不自动安排审查 |

这里是“无内置 Codex 进程依赖”的工具，仍可读取 Codex 数据并参与外部客户端协议；不是宣布整个产品改成纯只读，也不是卸载用户的 Codex 环境。

### 4.2 具体实施顺序

1. **先收口所有消费者。**在 `scripts/control-server.mjs` 清点 `sendToHarness`、`startExistingDispatch`、`processQueue`、`dispatchPilotIntent` 及反思执行路径，删除新投递入口和恢复投递的 5 秒定时器、启动触发。保留通用 reconciliation 与健康采集。
2. **同步界面和代理。**在 `features/console/ConsolePage.tsx` 删除“创建改进任务”和试点请求按钮，保留历史展示、建议决策；在 `lib/control-proxy.mjs` 删除相应写路径。其他旧界面/脚本经消费者搜索确认后同步处理。
3. **明确旧队列行为。**`data/dispatches.json` 和 pilot/reflection 历史状态不删除、不自动继续，不统一改成 cancelled/completed；页面标明历史状态仅是最后观察结果，新版本不会继续投递。尚在执行的外部 Agent 不因升级被认为已停止。
4. **收口 HTTP。**`POST /dispatch`、`POST /reflections/:id/execute`、`POST /context-management-pilots/intents` 返回 404；历史列表及已存在回执保持。`POST /dispatches/:id/cancel` 删除旧自动投递操作入口，不再用它暗示可终止外部执行。
5. **收口 Harness 与模型扫描。**`scripts/harnesses/codex.mjs` 仅保留身份、读取能力；删除 SDK 创建、CLI 恢复、委派操作。`scripts/harnesses/codex-session.mjs` 保留路径定位/JSONL 检查，删除启动 CLI 的实现；`scripts/session-cli.mjs` 删除对应恢复导出。若并发新增的 `codex-model-catalog.mjs` 已进入实施基线，删除其 CLI 扫描、import、`GET /routing/model-catalog` 和代理白名单，同步收口调用界面/测试；配置模型继续通过已有 `/routing/models` 展示，明确它不证明实际可派发能力。`codex-delegated.mjs` 在包括模型扫描在内的消费者完全消除后删除。共享的路径解析、进程管理和其他客户端调用不要连带删除。
6. **核对配置和兼容。**在 `config/model-roles.json` 收口仅用于新 Codex CLI 执行的 profiles；历史展示仍能解释旧 ID。不要因名称含 Codex 删除 native 模型映射、manual-only 策略、额度配置或客户端身份。新增 CLI grant 继续受既有 native-only 策略拒绝。
7. **卸载依赖。**所有生产调用清除后执行 `npm uninstall @openai/codex-sdk`，让 npm 同步更新 `package.json` 与 `package-lock.json`。不要手工删 vendor 文件；不要转为 optional dependency、全局 CLI 或启动时自动下载。
8. **更新测试/文档。**调整 `tests/harnesses.test.mjs`、`dispatch.test.mjs`、`reflection.test.mjs`、`context-management-pilot.test.mjs`、`codex-delegated.test.mjs`、配置/集成测试。专属 fake 只有消费者为零才删除。保留读取、未知客户端拒绝、身份与权限测试，并更新现行能力说明和 Unreleased。

### 4.3 验收出口

- [ ] 干净安装中 `npm ls @openai/codex-sdk @openai/codex --all` 无安装节点；空结果可返回非零，不能仅用退出码判断成功。
- [ ] lockfile 无 `node_modules/@openai/codex*` 安装条目，生成的发布运行目录无平台二进制。
- [ ] Codex capability 中 `createSession/resumeSession/runDelegatedCli` 为不支持，`inspectSession` 仍可使用；不能静默回退到别的执行器。
- [ ] 若基线包含 CLI 模型扫描，该扫描及其入口已退休，配置展示不会触发子进程或声称查询到实时目录。
- [ ] 需求投递、改进自动启动、试点唤醒的 UI/API/定时器全部收口；历史列表和迟到回执可读可报。
- [ ] 隔离测试使用捕获执行次数并立即报错的 Codex 替身；启动、同步、任务读取、MCP tools/list 和退休入口请求均产生零次调用。测试不依赖真实 Codex 登录。
- [ ] 项目运行不要求系统存在 `codex` 可执行文件；额外验证环境从 PATH 排除真实 Codex，同时保留 Node/npm/Git。
- [ ] 通用 task、native routing/delegation、Subject、verification、acceptance 和历史 CLI 回报语义未变化。
- [ ] 同环境干净安装前后复测，记录实际减少量；不直接以本机旧 `node_modules` 中残留包作为失败或成功证据。

**阶段出口：能正常展示/登记且不启动 Codex 进程，依赖链真实消失。**

## 5. P3：裁剪发布运行目录

本阶段保留现有 Node.js、React、vinext/Vite 栈，先区分构建时和运行时依赖。它涉及发布方式，实施前需按方案门禁确认；不与 P1 混在一个不可区分的提交中。

### 5.1 实施步骤

1. 在独立候选工作区用锁文件完成完整安装与构建。`npm test` 已包含 `sync:test` 和 `build`，不要在同一未变化代码上额外重复构建。
2. 追踪 `npm start` → `scripts/vinext-cli.mjs` → vinext production server，以及 MCP/control/watcher/sync 和 `dist` 外部导入。
3. 将真实启动必需包准确归入 `dependencies`；其他工具保留 `devDependencies`。当前 vinext 是 devDependency，却被 production start 入口直接使用，因此 **不能原样运行 `npm prune --omit=dev` 后宣称可启动**。
4. 对 Next、Cloudflare 插件、Wrangler、RSC 相关包只按运行闭包取证：构建配置引用不等于 production server 必需，也不等于已证明可以删除。保留现有构建路径；只有真实无消费者时才从项目依赖中移除。
5. 在已经完成构建的隔离候选执行 `npm prune --omit=dev`。构建输出及所有启动路径必须仍可用；若启动仍需要大部分工具链，如实记录结果，先停止扩大裁剪范围。
6. 通过隔离启动后，修改 `scripts/taskcenter-control.mjs` 的 release 准备流程及 `scripts/release-dependencies.mjs`：完整安装 → 构建 → 裁剪 → 隔离候选验证 → 写成功 release 标记。裁剪或候选失败保留原健康实例，不留下“已验证”的错误标记。
7. 同步 `tests/release-dependencies.test.mjs`、`service-deployment.test.mjs`、`release-runtime.test.mjs`，覆盖安装/构建/裁剪/候选失败。保留网络有限回退、进程树超时终止和部署回滚规则。

### 5.2 验收出口

- [ ] production 候选启动不依赖已裁剪开发包；网页、控制面、MCP、同步、watcher 均通过各自实际路径验证。
- [ ] 新 release 的完整占用与裁剪后占用分别记录，产物与运行依赖分别统计。
- [ ] 任何切换前失败都保留原 PID 与健康实例；不能把“候选能启动”当作“已部署”。
- [ ] 历史当前/上一成功 release 可用，回滚路径无需现场重新安装依赖。
- [ ] 若收益不足，记录最大剩余依赖及其真实消费者，然后单独提出构建栈选项；本阶段不隐式启动框架迁移。

## 6. 实施前检查与执行命令

以下命令是实施流程；真实执行结果见第 12 节，不表示每次都需要重复全量验证。独立工作区使用实际路径；不要在运行实例的不可变 release 内安装、裁剪或构建。普通开发工作区也不得被误认成候选数据目录。

### 6.1 P0：刷新基线与取得执行条件

- 读取当前 `AGENTS.md`、相关 Skill 和本方案，确认用户选择及允许阶段；新授权不自动包含提交、push、清理和部署。
- TaskCenter 中沿用相同交付 task 或在上一 task 关闭后建立独立任务；v2 scope、non-goals、验收和验证计划只包含实际选定范围。本次正式 task 已按用户批准范围包含 P1–P4。
- 当前真实 Session 完成登记、accepted task 和适配阶段的执行路由后才写入。门禁不可用时按项目规则只读，不绕过 Hook。
- 使用 DevKit/entropy 已有流程对准备删除候选核对静态引用、动态导入、导出、外部协议和配置；无可用 DevKit profile 时记录人工消费者证据，不能声称工具验证通过。
- 检查 Git 脏工作区，记录用户已有改动；选择安全隔离工作区。不要强制 reset、覆盖他人改动或并发写相同文件。
- 记录健康实例 revision/PID，保证整个开发与验证期间实例持续健康。

```bash
cd /Users/gezi/Documents/project/ReqRadar
rtk git status --short
rtk git rev-parse HEAD
rtk proxy node -p 'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch})'
rtk proxy npm --version
rtk proxy npm run service:status
rtk proxy du -sk node_modules
rtk proxy du -sk node_modules/@openai
rtk proxy du -sk dist
rtk proxy du -sk .local/releases
```

目录不存在时记录 `missing`；不要为取得基线自动安装、构建、重启。完整 `node_modules` 对比应在相同平台、Node/npm、同一安装策略的干净临时工作区复测，并记录锁文件与 Git revision。

### 6.2 消费者核对

```bash
rtk proxy rg -n 'BugDetails|BugDispatch|bugClosure|bug_acceptance|bug_merge|bug-dispatch|bug-workflow' features lib app scripts tests config README.md docs
rtk proxy rg -n '@openai/codex-sdk|TASKCENTER_CODEX_COMMAND|sendToHarness|startExistingDispatch|processQueue|dispatchPilotIntent|runCodexDelegated|resumeSession|codexModelCatalog|codex-model-catalog|model/list' scripts features lib app config tests package.json package-lock.json
```

搜索结果分为生产消费者、退役拒绝逻辑/测试、历史兼容和文档。后两类可以保留名字；“grep 零命中”不作为删除成功标准。对动态导入、启动时恢复、轮询和外部入口分别检查，不只看直接 import。

### 6.3 功能实施后的必要验证

```bash
rtk proxy npm run sync
rtk proxy npm run lint
rtk proxy npm test
rtk git diff --check
rtk proxy npm run service:status
```

这些是仓库规定的代码阶段检查。本次实施已运行 sync/build/test，具体结果与隔离范围见第 12 节。`npm test` 内已有 MCP schema 预算检查；只在需单独定位预算时补跑 `npm run mcp:budget`。

直接执行 `node --test ...` 调试时使用既有测试入口或明确设置隔离环境；不让手工挑选用例绕开 `scripts/run-tests.mjs` 的测试 Dashboard 与凭据环境过滤。

### 6.4 上线与历史发布清理

只有后续获得明确提交/部署授权，且代码已验证、提交、工作区干净时才走现有受控部署。实现阶段不得停止/重启健康实例，也不得设置 `TASKCENTER_ALLOW_SERVICE_DISRUPTION=1`。

```bash
rtk proxy npm run service:deploy
rtk proxy npm run service:history
rtk proxy npm run service:status
```

历史发布清理是独立操作，先预览，确认当前和上一成功 release 均被保护后，再在单独清理授权范围内执行：

```bash
rtk proxy npm run service:prune -- --dry-run
# 仅在清理已获授权时：
rtk proxy npm run service:prune
```

不手工 `rm -rf .local/releases`，不因空间目标删除无标记、存在用户改动或身份不匹配的目录。

## 7. 验收矩阵与证据

| ID | 必须证明的行为 | 验证方式 | 证据要求 |
| --- | --- | --- | --- |
| AC-BUG-UI | Bug 入口和旧链接处理正确 | workspace 单测 + 实际渲染/交互 | 页面结果、URL 和检查范围；打开页面不等于验证 |
| AC-BUG-API | 退休接口/tool 不可调用 | 隔离 HTTP 与真实 stdio MCP Client | 404/未知工具结果、tools/list、无新增事件 |
| AC-HISTORY | 旧任务/事件可读，普通更新保留旧事实 | ledger、completion、export/restore 可用路径夹具 | 字段及校验和对照；通用就绪预期 |
| AC-NO-WAKE | 旧 Bug 队列和通用投递队列不再自动触发 | 隔离启动与轮询观察、Codex 进程替身 | 零调用、旧队列未变；不能只测 dry-run |
| AC-NO-CODEX | 干净依赖树无 Codex 包且启动不需要 CLI | lockfile/npm ls + 无真实 Codex 环境 | 平台、Node/npm、revision、安装策略、实际依赖树 |
| AC-CORE | 通用任务和外部客户端协议保持 | 标准测试 + MCP/控制面 smoke | 登记、native grant/claim/report、失败/过期验证、验收权限 |
| AC-RUNTIME | production 裁剪后所有服务入口可用 | 独立端口/runtime/log/data/Codex home 候选 | 启动日志、健康、网页、MCP/sync/watcher 结果 |
| AC-SERVICE | 原实例在开发与预检失败期间持续健康 | 服务策略测试 + 前后状态 | 原 PID/revision/健康与失败场景；候选与正式实例分开 |
| AC-SIZE | 指标可复现，预算能拦住反向增长 | 相同环境前后指标 + 超标负例 | 原始字节、gzip、分配占用分别记录 |

阶段完成报告记录 `SubjectReference`、Git revision 或工作区快照、命令、时间、退出码、摘要和证据位置；TaskCenter 记录不代替真实执行。外部 Review 仅在用户另行安排时处理，不能自动发起或声称通过；`done_claimed` 也不等于独立验收。

## 8. 防劣化执行机制

目标是让后续增长能被自动发现、定位并拦截，而不是依赖维护者记得检查。**新增 artifact 门禁已在本机生效，CI 已接入；Linux/Windows 的真实平台基线尚未校准，当前会明确阻断。release 留存保护复用原实现，未执行清理。**

### 8.1 防哪些劣化、在哪里阻断

| 劣化类型 | 自动检查 | 失败时阻断位置 |
| --- | --- | --- |
| 前端资产、JS/CSS 或服务端产物变大 | 固定基线与独立预算 | 本地完整测试和现有 CI |
| release 又带上开发依赖或大运行依赖 | 检查实际候选依赖树及 release 字节 | release 准备阶段，切换前失败 |
| 多次小增长累积成大体积 | 每次对比同一批准基线，不对比上一提交 | 同上，累计达到限额即失败 |
| Codex SDK/原生 CLI 被传递依赖带回 | lockfile + 候选依赖树禁止包检查 | 完整测试及 release 准备阶段 |
| Bug 闭环或主动 Codex 执行被重新接回 | 退休接口/tool、能力声明、零进程调用回归 | 完整测试及 CI |
| 某些平台没有基线却跳过检查 | 验证 platform/arch、工具版本与预算完整性 | 对应平台 CI 或受控部署失败 |
| 使用旧构建、旧报告冒充新 revision | 干净 CI 构建；release 报告绑定 revision/lockfile/config 摘要 | release 复用路径及切换前失败 |
| 发布版本不断堆积 | 保留当前与上一成功版本，受管清理预览 | 运维留存检查；不能以超预算为由强删 |

本地 Git commit 本身不会因为存在预算文件就自动被拦截；本方案通过完整测试、CI 和 `service:deploy` 阻止不合格产物上线。远端若要禁止合入红色 CI，需要用户另行配置 branch protection；本方案不声称该保护已启用，也不自动修改远端规则。

### 8.2 固定预算，防止基线不断抬高

已采用与已有 MCP 预算一致的初始策略：**累计增长超过 2% 预警、超过 5% 失败**。这是本次采用的 artifact 策略；MCP 原预算保持不变。每个指标单独判定，不允许“服务端变小抵消前端变大”。

对指标 `i`，以优化后批准基线 `B_i` 计算：

```text
warn_i = floor(B_i × 1.02)
limit_i = min(floor(B_i × 1.05), absolute_cap_i)  # 未设绝对上限时只用前项
M_i > limit_i → FAIL
M_i > warn_i 且未 FAIL → WARN
任一必需指标 FAIL → 整体 FAIL，退出码 1
```

例如基线 100 MiB，103 MiB 预警，106 MiB 失败；不能将 103 MiB 自动记成下一次基线。连续十次各增长 1% 也会累计触发失败。绝对上限只有完成干净生产闭包测量后才填写，不能拿第 2 节预测值填作基线。

预算文件 `config/artifact-size-budget.json` 应记录：算法版本、基线 revision、platform/arch、Node/npm 版本、安装策略、各指标 baseline/warn/max bytes、可选 absolute cap、禁止包列表。度量值使用整数 bytes；报告另显示 MiB。工具版本、统计算法或支持平台变化需要显式重新校准，不能当作零增长。

基线维护规则：

- 普通构建和测试只读预算文件，绝不自动更新 baseline；实现不提供“失败后自动接受新值”的开关。
- 新增功能仍受同一预算约束。必要增长先说明需求、前后指标、替代方案和消费者，由用户明确选择后再调整预算；不能只写一个 reason 字段就视作授权。
- 预算上调与功能变更分别列明，保留旧基线及差异证据；报告同时展示相对批准基线和上一已验证版本的变化，只有前者决定累计门禁。
- 优化获得稳定收益后，按真实测量显式下调上限以锁住收益；没有下调前，不声称新节省量已经被预算保护。
- 预算缺字段、目录缺失、测量异常、未知平台或报告过期都不是 PASS。build 模式明确不要求 production 依赖指标；release 模式必须要求完整生产指标，不能把缺失指标记为 0。

### 8.3 具体指标和同口径测量

| 指标 | 统计方法 | 必须遵守的口径 |
| --- | --- | --- |
| 前端全部资产 | `dist/client` 全部文件逻辑字节 | 图片、字体、wasm 也计入，不能只盯 JS |
| 前端 JS/CSS gzip | Node `zlib` 固定参数逐文件压缩后求和 | 不等于首屏实际下载量，不与 raw 字节混合 |
| 最大前端 JS chunk | 最大单文件 raw 字节 | 防止总量不变但单文件集中变大；初版不冒充首屏性能指标 |
| 服务端产物 | `dist/server` 全部文件逻辑字节 | 不含外部运行依赖；与前端独立预算 |
| production 运行依赖 | 已构建并裁剪候选的 `node_modules` 逻辑字节 | 按平台建立基线，明确定义 soft/hard link 去重及越界规则 |
| 单次 release | 产物、生产依赖与其余文件分类求和 | 不计 `.git` 管理元数据；记录清单；不能混入多版本历史总量 |
| 完整开发依赖 | 相同环境干净 `npm ci` 后测量 | 初版趋势报告；开发工具不能藏进生产指标 |
| MCP schema | 复用既有 bytes/tokens 检查 | 保留运行时校验、compact/inline 等价和固定 tokenizer |

新测量脚本使用 Node 标准库，不增加体积分析依赖或常驻服务；遍历结果按路径排序。软链接不能越过声明的统计根目录，循环链接直接失败；报告包含去重规则，不能将不同算法的字节混用。OS、arch 和 npm 可选依赖不一致的安装结果分别建档。

报告输出：指标、baseline、实测、增量 bytes/%、warn/max、前 10 个最大文件/包及其消费者调查入口、Git revision、lockfile/config 摘要、Node/npm、platform/arch 和采集时间。只测本地构建/依赖，不读取认证文件或上传会话内容。

### 8.4 三个接入点与防绕过

| 接入点 | 后续具体改动 | 失败语义 |
| --- | --- | --- |
| 本地完整测试 | 新增 `tests/artifact-size-budget.test.mjs`；沿用 `scripts/run-tests.mjs` 自动发现；在 `npm test` 已完成构建后检查 build 指标和禁止包 | 任一预算/边界回归失败，`npm test` 非零；不重复构建 |
| 现有 CI | `.github/workflows/ci.yml` 已有 Ubuntu/Windows、Node `22.13.0`、干净 `npm ci` 和 `npm test`；通过上述测试覆盖 build 指标，另记录对应平台 production 依赖测量 | 不用 macOS arm64 旧值代替 CI 平台基线；校准完成前明确未覆盖范围 |
| 受控部署 | `scripts/taskcenter-control.mjs` 的 `prepareRelease` 在裁剪后、成功标记前检查 release 指标；`verifyBeforeServiceCutover` 保留原 PID 健康校验 | 超预算、包禁用、缺指标立即失败，不能调用 `stopOriginal` |

预算脚本只依赖当前工作区文件、Node 标准库和明确的构建输入；CI/生产门禁不要求 TaskCenter MCP、Codex Session 或模型服务在线。TaskCenter 仅记录执行证据，不能成为其他项目构建或本门禁算法的运行依赖。

release 复用也是门禁入口：旧实现可凭标记与目录存在直接返回。新实现会核对预算策略/测量版本及报告 revision、lockfile/config 摘要，并重新检查实际目录；旧标记缺报告不视作已通过。健康的 active release 不原地修改，不能为补报告裁剪它的依赖。

生产测量不得在 CI 主测试目录先 prune 再跑完整测试，避免破坏测试依赖。优先用完整测试已构建的输出，在独立临时运行目录安装 `--omit=dev` 依赖并核对 startup；或者复用隔离 release 构建流程。不得复制 CI 环境中的用户会话或认证信息。

macOS 正式部署环境需单独校准与核验；现有 Ubuntu/Windows CI 不能冒充 macOS production 启动验证。CI 失败若在当前远端规则下仍可合入，部署门禁仍必须失败；不能把 CI 是否被 branch protection 选为必需检查当作本地部署条件。

### 8.5 依赖与功能准入，防止换个入口长回来

P2 完成后在预算文件明确禁止实际安装节点 `@openai/codex-sdk`、`@openai/codex` 和各平台 Codex 包；直接依赖与传递依赖都检查。lockfile 中其他平台的可选安装条目也算进入依赖链，不因本机没安装而放过。测试 stub 和历史文档中的字符串不误判为安装节点。

新增 `dependencies`、原生包或大型静态资产时，变更说明至少包含：真实消费者、为何现有代码/标准库不能满足、完整传递体积、是否运行时必需，以及同环境前后指标。不让小型展示需求引入新的 SDK、执行框架或平台二进制。

新增后台队列、自动唤醒、子进程、外部上传或权限能力属于新的产品/架构选择，不能通过“补一个展示功能”隐式引入。保留以下持续回归：

- Bug 退休 API/MCP 入口仍不可用，旧数据仍可读；新输入的退休字段不能重新接受。
- Codex `createSession/resumeSession/runDelegatedCli` 能力仍不支持；模型目录查询、同步、启动和展示路径调用 Codex 进程次数为 0。
- production 启动不要求 Codex 可执行文件，不触发运行时下载或从全局 CLI 回退。
- native routing/delegation、失败/过期验证及独立验收协议继续有效，不能为变轻删掉必要校验。

这些测试分别从真实接口和副作用取证；不是仅扫描文件名，也不禁止 Node 同步器、Git 查询等仍有合法消费者的所有子进程。

### 8.6 超标处置与留存治理

超标时先报告最大的增量文件/依赖链，比较锁文件及 build 清单。依次检查重复打包、运行/开发依赖分类、静态资产、残留执行消费者，再决定是否需依赖替换。没有新代码或环境变化时，不重复跑已经通过的全量验证。

必要增长必须经第 8.2 节的预算选择流程，不能设置 ignore、继续上线、自动刷新基线或只在失败后降为 warning。测量脚本应把“预算超限”和“环境/测量失败”区分在错误分类里，但两者都不允许部署。

历史 releases 复用现有 `service:prune`：每次已授权部署完成后检查受管留存候选，先 dry-run；当前与上一不同成功 release 以及有用户改动/身份不匹配目录必须保留。清理仍需要其操作授权，不默认新建定时删除任务。无法清理时报告候选与原因，不强删，不把历史目录总占用当作新 release 构建劣化。

### 8.7 P4 交付物与负例验收

| 交付物 | 职责 |
| --- | --- |
| `scripts/artifact-size-budget.mjs`（已新增） | 测量、禁止包校验、预算判定、结构化报告；build/release 模式 |
| `config/artifact-size-budget.json`（已新增） | 显式固定基线、平台档案、阈值、禁止包和算法版本 |
| `tests/artifact-size-budget.test.mjs`（已新增） | 预算算法及真实构建检查；由既有测试入口发现 |
| `package.json`（已修改） | 增加 `size:check` 与 `size:report` 命令；report 不替代 gate |
| `.github/workflows/ci.yml`（已修改） | 平台生产依赖测量和报告；继续使用已有完整测试 |
| `scripts/taskcenter-control.mjs`、发布测试（已修改） | 实际候选、release 复用和切换前失败保护 |

人工定位命令已提供并验证；report 同样返回超限状态，不替代 release 门禁：

```bash
rtk proxy npm run size:check
rtk proxy npm run size:report
# release 检查由 service:deploy 对实际候选调用，不由维护者手选一个较小目录代替。
```

验收不能只跑一次 PASS，必须验证门禁会失败：

- [ ] 100 MiB 夹具在 103 MiB 预警、106 MiB 失败；连续小增长仍对原固定基线累计判断。
- [ ] gzip 单项、前端资产单项、最大 chunk 或 production 依赖单项超限均失败，其他指标缩小不能抵消。
- [ ] 注入直接/传递/可选 Codex 安装节点后失败，历史字符串不误报；替身检测新增执行入口调用。
- [ ] 缺 `dist`、缺预算、未知平台、工具版本不匹配、越界/循环链接或旧报告时失败，不产生 0 字节 PASS。
- [ ] 复用旧 release 标记时也执行实际检查；修改实际产物或 config 后旧报告不能通行。
- [ ] 超预算候选不会进入 `stopOriginal`；原 PID 持续健康，失败留下真实发布事件。
- [ ] 测量/检查不修改预算文件；测试前后 budget 校验和一致。
- [ ] Ubuntu、Windows 和实际 macOS 发布环境各有对应基线证据；未验证平台明确记为未覆盖。

只有以上负例及常规功能回归通过，才可声称“新增 artifact 防劣化门禁已落地”。只有文档、报表、warning 或建议不算已落地。

### 8.8 防劣化与进一步优化的边界

本机制先防止已获得的收益丢失，并不证明当前体积已足够小。P1/P2 后若完整依赖仍不符合产品目标或生产闭包仍带大工具链，先给出真实消费者及占用，再选择下一优化方案；不靠不断放宽预算继续增加功能，也不为某个 MiB 数字删除必要权限和数据保护。

## 9. 回滚、风险与停止条件

| 风险/触发条件 | 处理与回滚 |
| --- | --- |
| 历史记录无法读取，或普通更新丢失 Bug 历史字段 | 停止该阶段，修复读取/透传；没有生产数据迁移，不批量重写真实账本 |
| 通用失败/过期验证、Subject 或验收权限改变 | 阶段不通过，恢复对应判断；禁止用放宽测试解决 |
| 仍有 SDK/CLI 生产消费者 | P2 不通过，不只删除 lockfile；补齐调用收口或重新选择产品边界 |
| 有外部 Agent 仍在执行或结果未知 | 如实保留运行事实；升级不等于终止，禁止批量标记完成/取消。涉及该阶段旧主动通道的执行应先由其所有者收口，再切换 |
| production 裁剪后模块缺失 | 候选失败保留原服务，恢复必要 runtime dependency，重新验证变动路径 |
| 原服务不健康或候选切换失败 | 不手工重启；按既有受控发布恢复上一已验证 release，保留发布事件 |
| 节省量低于预测 | 核对统计口径、干净安装、残留包和依赖闭包；不伪造收益，不自动启动技术栈重写 |

代码实施分 P1、P2、P3/预算治理形成独立可恢复检查点。只有用户解除暂不提交的限制后才按仓库规则创建本地提交。回滚已提交阶段使用对应提交的 revert，保留其他用户改动；不使用强制 reset。部署回滚复用 `service:deploy` 内已有回滚逻辑，不覆盖健康 release 原目录。

## 10. 交付拆分与实施结束报告

| 顺序 | 工作包 | 前置条件 | 交付物 |
| --- | --- | --- | --- |
| P0 | 基线刷新、消费者及运行实例取证 | 获准恢复实施 | revision/环境/体积、范围和 TaskCenter 合同 |
| P1 | Bug 闭环完整删除 | 移除方向已确定，恢复执行指令 | 清单改动、历史保护回归、协议与 UI 验收 |
| P2 | Codex 执行消费者收口与依赖卸载 | 第 4 节产品边界已选定，P1 通过 | 无 Codex 干净安装及启动证据、实际节省量 |
| P3 | 发布运行依赖裁剪 | 发布方式已选定，闭包取证完成 | 隔离候选、发布策略回归、production 基线 |
| P4 | 固定 artifact 预算与依赖/执行边界门禁 | 优化后指标稳定；各平台基线已校准 | 本地/CI/release 三处检查、累计增长与超标负例、release 复用保护；已有 prune 预览及获准清理记录 |
| 上线 | 受控部署 | 验证通过、已获提交/部署授权、Git 干净 | 正式 revision、health、发布历史和可用回滚版本 |

结束报告必须区分：代码已实现、检查已通过、独立验收、已提交、已部署和实际生效。每项提供依据，未发生项写“未执行”。记录前后体积时列出同口径基线、平台、revision、原始数值和降幅，不只给百分比。

## 11. 证据与文档维护

项目事实以本方案基线下的当前代码为准，主要取证入口：

- [依赖和命令](/Users/gezi/Documents/project/ReqRadar/package.json)、`package-lock.json` 及本机已安装 Codex 包的 package metadata。
- [任务界面](/Users/gezi/Documents/project/ReqRadar/features/tasks/TaskWorkspace.tsx)、[任务筛选](/Users/gezi/Documents/project/ReqRadar/lib/task-workspace.mjs)。
- [控制服务](/Users/gezi/Documents/project/ReqRadar/scripts/control-server.mjs)、[MCP](/Users/gezi/Documents/project/ReqRadar/scripts/taskcenter-mcp.mjs)、[账本](/Users/gezi/Documents/project/ReqRadar/scripts/task-ledger.mjs)、[完成判定](/Users/gezi/Documents/project/ReqRadar/scripts/completion-state.mjs)。
- [Codex Harness](/Users/gezi/Documents/project/ReqRadar/scripts/harnesses/codex.mjs)、[CLI 恢复及读取](/Users/gezi/Documents/project/ReqRadar/scripts/harnesses/codex-session.mjs)、[委派实现](/Users/gezi/Documents/project/ReqRadar/scripts/harnesses/codex-delegated.mjs)、[已有宿主协议](/Users/gezi/Documents/project/ReqRadar/scripts/codex-compaction-host.mjs)。
- [发布控制](/Users/gezi/Documents/project/ReqRadar/scripts/taskcenter-control.mjs)、[依赖安装](/Users/gezi/Documents/project/ReqRadar/scripts/release-dependencies.mjs)、[安全留存](/Users/gezi/Documents/project/ReqRadar/scripts/release-retention.mjs)。
- [MCP 预算](/Users/gezi/Documents/project/ReqRadar/docs/mcp-schema-budget.md)、[版本发布规则](/Users/gezi/Documents/project/ReqRadar/CONTRIBUTING.md)、[项目工作规则](/Users/gezi/Documents/project/ReqRadar/AGENTS.md)。历史 Harness 文档包含旧 CLI 策略描述，与当前角色配置冲突时以代码和配置为准。

专栏证据：《ClaudeCode企业级全链路开发实战》“产品定义：动第一行代码之前你该想清楚什么”，`sourceRelpath: ClaudeCode企业级全链路开发实战/03-产品定义：动第一行代码之前你该想清楚什么.md`，已读取 `chunk_70cf9e75e6ae42330e54`；支持先确定功能取舍再做技术选择。这里的模块删除、收益预测和预算策略是结合项目证据的 Agent 建议，不是专栏对本项目的结论。

防劣化补充证据：《10x程序员工作法》“快速反馈：为什么你们公司总是做不好持续集成？”，`sourceRelpath: 10x程序员工作法/24-快速反馈：为什么你们公司总是做不好持续集成？.md`，已读取 `chunk_8da35a67398a507cdd40`；支持开发机先反馈、CI 再验证，而不是只依赖服务器检查。第 8 节阈值、release 复用保护和禁止包策略是结合项目证据制定的方案，本次实现与验证见第 12 节。初次检索“性能预算”无直接命中，不用该专栏替代体积实测。

最初仅保存方案时记录 `changelog: not required`。本次实施改变用户入口、公共协议和发布依赖流程，已按 `CONTRIBUTING.md#versioning-and-changelog` 更新 Unreleased；不改变版本号。

维护要求：用户选定边界后更新第 1 节状态；实施后填入真实 revision、验证与测量结果。未经实施，不把候选预算、退休接口或预测体积改写为当前事实。


## 12. 本次实施结果与剩余条件

### 12.1 实施范围

用户批准后在当前工作区执行 P1–P4；实施基线为 201e567b335133e09990718fc4e2b210b94b9a4a。未提交或部署，没有删除真实账本、会话、旧队列或历史 release。

- P1：移除 Bug UI、HTTP/MCP、宿主队列及专属完成门槛。新字段返回 RETIRED_BUG_WORKFLOW；历史字段在普通更新、详情及 JSON 导出中保留，旧链接回落到普通任务。
- P2：移除 SDK、恢复/委派 CLI、CLI 模型目录和内置 Reviewer 启动；旧 Reviewer 启动器明确拒绝。保留配置模型编辑、外部原生和审查回报协议。旧 dispatch、反思执行、试点唤醒入口退休，历史队列不迁移或重放。
- P3：vinext 归为运行依赖，Next 保留为开发依赖。普通 omit=dev 仍通过可选 peer 带回 Next/SWC，经隔离验证采用 omit=dev + omit=optional。生产入口直接使用 vinext/server/prod-server 的原 API。成功标记在裁剪、预算和隔离启动之后写入。
- P4：固定预算、标准库测量、构建摘要、禁用包检查、负例测试、CI 和 release 复用门禁已接入。完整测试最多四个 worker，避免大量控制服务同时启动造成已有用例超时；不改变生产并发策略。

vinext 字体插件会复制整个 .vinext/fonts 缓存，即使源码已无消费者。构建前仅清理该生成缓存；输入摘要排除 Finder .DS_Store，仍校验源码、锁文件和全部实际构建产物。

### 12.2 同环境测量

macOS/arm64、Node v26.7.0、npm 11.19.0。优化前为基线 revision 的干净 npm ci/build；优化后为干净完整 npm ci，再裁剪的隔离候选，并额外验证干净 npm ci --omit=dev --omit=optional。逻辑字节采用 artifact-size/v1，磁盘分配占用单列。

| 指标 | 优化前 bytes | 优化后 bytes | 变化 |
| --- | ---: | ---: | ---: |
| 完整开发依赖 | 1,259,117,152 | 976,532,227 | -269.5 MiB / -22.44% |
| client 全部资产（干净构建） | 337,886 | 326,108 | -3.49% |
| client JS/CSS gzip | 103,852 | 100,299 | -3.42% |
| 最大 JS chunk | 189,757 | 189,757 | 持平 |
| server 产物 | 1,157,194 | 1,136,700 | -1.77% |
| 单 release（旧全量依赖 / 新生产依赖） | 1,263,370,345 | 约 64,650,000 | 约 -94.9%，约 61.7 MiB |
| production 依赖 | 旧 release 使用完整依赖 | 60,517,579 | 57.7 MiB 逻辑字节；78.4 MiB 磁盘分配 |

原日常工作区还包含 146,464 bytes 的过期字体缓存，已不再打入 client。上表对比前后均无过期字体的干净构建，不能把缓存差异冒充功能删除收益。完整开发依赖仍约 931 MiB，Cloudflare/Workerd、Next、Vite 等构建工具保留，未计入新 release 的运行依赖；本次没有更换框架。

### 12.3 验证

- npm run sync 通过；当前选择范围输出 0 会话。生产 smoke 另以隔离 fixture 证明同步，不拿空同步冒充启动验证。
- npm run lint 通过；两个已有 task-reconciler unused-vars warning 未扩展处理。
- npm test：560/560 通过，包含 task/native/Subject/verification/acceptance、SSR 和真实 MCP 预算。随后仅补 EOF 格式、预算元数据和旧队列回归，分别再次 build、预算/退休入口测试与 diff 检查。
- 固定预算/退休 Reviewer 定向测试 8/8；队列/会话定向测试 6/6；历史 Bug 详情与 JSON 导出通过。
- npm run verify:production -- --install 通过：干净生产安装、六个页面、控制面、47 个 MCP 工具、退休 Bug tool 拒绝、同步与 watcher；Codex 进程替身调用为 0。
- npm ls @openai/codex-sdk @openai/codex --all 输出 empty（退出码 1 是 npm 空树语义）；锁文件及真实安装树禁用节点检查通过。
- release 复用、active 写保护、旧报告/修改目录拒绝及超预算不进入 stopOriginal 的负例通过；未执行真实切换或回滚。
- MCP 预算未上调；当前紧凑目录为 84,263 bytes / 23,978 o200k_base tokens。

结构化数据见 [测量证据](evidence/lightweight-2026-10-08.json)。本次临时完整安装目录在取证后清理，证据和日志保留；不清理历史 release。

### 12.4 剩余条件

1. Linux/x64、Windows/x64 的 Node 22.13.0 CI 环境尚无真实基线，不以 macOS 数字代填。CI 当前会明确失败并输出该平台测量值；实际校准后才能声明三平台覆盖。普通检查不会自动接受基线。
2. 未做浏览器人工交互或真实三端登录验收；SSR、URL 和协议测试不能冒充人工实测。
3. 当前服务父 PID 98061、revision 201e567b3351 保持。旧 control 子进程在验证期间堆内存耗尽，由既有 supervisor 自动恢复，导致两次门禁暂时失败；未人工重启或替换。不声称所有子进程全程健康，该现场故障需另行定位。
4. 用户暂不提交仍有效；未 push、未部署、未配置远端 branch protection、未启动外部 Review、未清理历史 release，版本保持 0.1.5。

回滚代码时恢复基线代码和锁文件；没有真实数据迁移需要逆转。旧队列保持原事实，不将未知结果批量标记为完成或终止。

## 13. 方案 A：移除开发工具链重依赖

### 13.1 已执行的边界

用户选择方案 A 后继续在同一工作区实施：保留 vinext/React 页面、Node 控制面、MCP、同步及 watcher；移除 Cloudflare Vite 插件、Wrangler/Workerd/Miniflare、Next 编译器及 SWC、Drizzle、Worker/D1/R2 和 Sites 模板链。第 12 节是前一阶段的历史结果，其中“Next/Cloudflare 继续保留”和 931 MiB 数字不再描述当前实现。

删除对象原本随 `36c15bc` 模板引入：hosting 的 D1/R2 为 null，DB schema 为空，未找到业务数据库消费者。Cloudflare 构建入口曾真实可达，移除属于用户选定的 Node 方案边界，不能称作纯死代码。没有删除真实数据、历史 release 或本机工具安装。

DevKit CLI 已安装，但当前仓库没有 `.devkit/profile.json`；按 Skill 停止 CLI 路由，改用手工消费者、Git 历史和项目验证证据，不声称取得 DevKit 的自动安全保证。本次未初始化 Profile，也未修改客户端配置。

页面直接使用 `vinext/shims/*` 的公开导出，避免为少量兼容类型安装 Next；生产仍使用已有 vinext server API。`eslint-config-next` 的 parser 真实依赖 Next 的 Babel 编译包，因此同步移除，改用已经存在的 React、Hooks、无障碍、import 和 TypeScript 插件，并显式声明依赖。新增 `npm run typecheck`，构建前清除旧 dist，避免 Worker 产物残留。

### 13.2 实测及统计口径

环境仍为 macOS/arm64、Node v26.7.0、npm 11.19.0。独立临时目录完成干净 `npm ci`、Node build、开发 HMR 验证及 `npm prune --omit=dev --omit=optional`；额外完成一次干净生产安装。

| 指标 | 方案 A 实测 bytes | 换算/说明 |
| --- | ---: | --- |
| 完整开发依赖包文件 | 206,652,146 | 197.08 MiB |
| production 依赖 | 50,093,930 | 47.77 MiB，裁剪安装与干净生产安装一致 |
| client 全部资产 | 324,998 | 317.38 KiB |
| client JS/CSS gzip | 100,319 | 97.97 KiB |
| 最大 JS chunk | 189,757 | 与前一阶段持平 |
| server 产物 | 657,936 | 642.52 KiB |
| 隔离候选总量 | 约 53,610,000 | 约 51.1 MiB，文档证据等文件也计入 |

相对第 12 节的约 931 MiB，完整开发依赖约减少 734 MiB / 79%。新开发预算排除 node_modules 根 `.package-lock.json`、`.vite`、`.vite-temp`、`.cache` 生成元数据和缓存；旧 931 MiB 包含 npm 安装元数据，因此百分比是近似对比，精确防劣化以新的包文件固定基线为准。硬链接仍按每个路径计数，不能靠更换包管理器制造账面缩小。日常工作区约 197.8 MiB，略大于干净目录但预算通过。

候选包含完整仓库源码、文档及 fixture；它是当前发布流程的隔离快照，不等于浏览器下载大小。单版本计量会随这些文件略有变化，最终报告保存实际目录的字节和摘要。

### 13.3 防止继续劣化

1. `config/artifact-size-budget.json` 固定 macOS 实测基线：所有指标独立累计 2% 预警、最多 5% 失败。开发依赖基线 206,652,146 bytes，预警 210,785,188，失败上限 216,984,753；小增量仍相对同一基线累计，指标缩小不能抵消另一指标增长。
2. 本地 `npm run size:check`、CI 的完整测试、release 完整构建后的裁剪前检查均覆盖开发依赖。生产预算在裁剪后单独执行，旧 release 复用仍校验真实目录和报告。
3. `@openai/codex[-sdk]`、Cloudflare Vite/Workerd、Wrangler、Workerd、Miniflare、Next/SWC、Drizzle 的安装节点被强制禁止；manifest、lockfile 和实际安装树都检查，不能只把包换成间接依赖。
4. 缺开发指标、超限、旧构建或报告、未知环境都失败；普通测量不修改预算。基线变更必须先说明消费者、增长原因和取舍，在实际环境干净安装后人工校准，不能随每次升级自动上调。
5. 每次依赖升级执行 `npm ci`、`npm run typecheck`、`npm run lint`、`npm test`、`npm run size:check`、`npm run verify:production -- --install`；报告给出最大包和 `npm explain` 入口，超限时先定位新增闭包，再决定优化或明确批准新的产品边界。

### 13.4 验证、限制和回滚

- `npm test`：561/561 通过，包含预算超限、缺开发指标、缓存统计、禁止直接/传递包、旧报告及切换前失败保护；完整构建通过。
- lint 0 errors，保留两个已有 unused-vars warning；普通工作区与干净安装目录的 typecheck 均通过。临时 lint probe 证明 Hooks、TypeScript explicit-any、alt-text 和 ARIA 校验仍生效。
- 干净生产安装与裁剪后运行均通过：六个页面、47 个 MCP 工具、退休接口拒绝、fixture 同步和 watcher；Codex CLI 替身调用为 0。
- 开发 `/tasks` SSR、临时源文件变更后的响应及 Vite websocket `rsc:update` 已验证，源文件已恢复；没有声称浏览器 hydration/人工交互验收通过。
- `npm run sync` 通过，当前选择输出 0 会话；隔离 fixture 单独证明非空同步。当前服务父 PID 98061 及旧 release 保持，未重启或切换。
- Linux/Windows 的真实 CI 基线仍未校准，当前会失败关闭；这不是三平台验收完成。没有启动外部 Review、提交、push、部署或修改版本号，版本仍为 0.1.5。

结构化证据见 [方案 A 测量与验证](evidence/toolchain-a-2026-10-08.json)。临时日志用于本机排查，持久化证据保存指标和关键验证结果，不依赖临时目录长期存在。

回滚只恢复本次工具链配置、对应源码/测试和 package manifest/lock，再 `npm ci` 重建验证；保留上一阶段已批准的 Bug/Codex 清理及其他用户改动，不整体 reset 工作区。没有数据迁移，当前运行 release 不受工作区回滚影响。
