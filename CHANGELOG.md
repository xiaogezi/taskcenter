# Changelog

All notable changes to TaskCenter are documented here.

## Unreleased

- 修复按 `task_id` 查询仍全量计算无关任务的完成状态与阶段耗时：提前精确选取并保留完整详情、usage、Session 交集、已完成与归档语义；列表行为、权限与超时预算不变，`/tasks` 纳入现有脱敏慢请求观测。

- 修复维护通道将上游限流误记为未知错误：识别 CLI 错误消息、stderr 和结果中的限流信号，仅记录固定分类与数值诊断；未执行工具时按 5、10 分钟持久退避，三次后停止，已有工具调用或结果未知时须核对现场后显式接续，观察器不重置限流预算。保留原模型、任务归属与活跃宿主保护。

- 修复维护队列仅因任务事件号变化就取消、并被观察器去重阻断恢复的问题：内容未变保留行动，内容变化以当前事实替换旧分析；新增同源人工任务级显式移交，绑定任务归属、版本和快照，复用现有 task_resume 实际执行修复。网关明确拒绝工具与推理协议时停止自动重试并记录脱敏原因。原宿主、同工作区活跃执行者、未知结果不重放及独立验收保护保持不变。

- 精简现有 `taskcenter_task_close` 为轻量执行完成声明：只需任务身份，摘要、测试、证据与逐项结果均可省略；复用已有结果计算就绪度，缺证据不会自动变成验证或验收通过。显式证据的引用/Subject 校验、独立验收及全量测试与受控部署门禁保持不变。

- 只读恢复预览新增独立 `projectionDiagnostics`，暴露现存任务的持久事件领先投影问题；合法派生摘要和提醒不误报，review、未知格式、冲突身份及不完整/变化中的源保留 unknown。原 missing/removed 候选、恢复拒绝及事件源保持不变，不创建索引、不写回或自动重放。

- 修复无活跃任务时现代 Hook 准备路径缺少恢复指引：统一前置提醒、拒绝和治理提示，明确由 Agent 创建或接续当前已授权交付的任务后重试；保留纯只读适配、任务归属和授权边界，不自动创建任务或绕过门禁。

- 补齐 SSH 远端 macOS 资源与本地账户只读投影，以及固定 GitLab HTTPS 连通摘要探针；仅放行精确系统路径、固定资源键和账户字段。HTTPS 探针清空远端环境并禁用 curl 配置、代理和响应正文输出，继续拒绝写入、凭据读取、TLS 跳验与任意目标。

- 使用既有 Rolldown 构建固定的生产日志产物，保留第三方许可证和完整构建指纹；移除运行安装树中仅用于构建的日志依赖，继续按全部 release 文件计量，不提高现有体积预算。生产验证日志也写入隔离状态目录。

- 将服务及子进程输出接入 Pino 与 rotating-file-stream 持续轮转，运行日志总预算约 100 MiB，限制单行及缓冲并在退出时排空；保留子进程自动恢复。工具明细按 30 天及 200 MiB 清理，事件身份、重放摘要、状态变化及任务关键事实永久保留。新增完整 SQLite 索引，迁移预建时保持原实例服务，切换只核对并补入增量；原事件文件按校验摘要只读归档，旧 JSONL 消费者仍可读取关键事实。修复隔离启动测试路径被受控部署环境覆盖的问题。策略、恢复和空间边界见 `docs/event-storage-retention.md`。

- 降低门禁控制面首次事件查找与切换历史扫描开销：按块搜索权威日志的字节，仅重建并解析候选行，保留跨块 UTF-8、精确幂等核对和前序封存规则；大范围事件查找追加脱敏扫描字节数、候选解码行数及耗时日志，不延长超时、不自动重放未知 POST。

- 升级现有主版本内的 SDK、Zod、Vite 及兼容传递依赖，生产依赖审计由 17 项降至 3 项，清除 high/critical；剩余 OG 生成链与开发期 minimatch 影响及升级边界见 `docs/security-audit-2026-11-05.md`。
- 减少控制面在已关闭任务事件上重复同步扫描完整事件历史：只复用身份未变化的历史及本进程已核对的追加，外部追加、改写、替换和截断失效重读，保留顺序切换前驱封存校验；大历史扫描输出有界耗时日志。

- 恢复 POST 连接异常后的服务自动恢复：恢复服务与请求重放分离，GET 仍最多重试一次；结果未知的写请求不自动重发，明确提示按原 event_id 核对持久结果。继续保留共享恢复时限与权限拒绝。

- 减少 Hook 门禁热路径重复读取：同次检查复用当前 Session 准备结果，按 Session 筛选后计算任务状态，仪表盘读取复用文件身份缓存并在文件变化时刷新；不缓存跨调用授权。控制面慢请求及客户端中断记录脱敏请求 ID、接口与耗时。补齐已审核 Jev `report` 的精确只读适配，校验入口及本地依赖摘要，继续拒绝写日志、模型调用、未知参数和运行时注入。

- 修复启动及周期对账逐条任务重复计算全账本状态的问题：目标任务读取与异步检查后的版本校验改为精确读取，保持对账规则和新鲜度检查，减少对长会话冷读与门禁请求的争用。

- 修复 Hook 请求、自动恢复和拒绝上报累加超过宿主时限：共享 8.5 秒通信预算并预留上报时间；超时输出请求 ID、接口、阶段和耗时，单独归类为 `hook_timeout`，明确区别任务执行时长，保留授权拒绝且不盲目重放结果未知的写请求。

- 修复常见只读查询误拦：补齐系统/Xcode 信息、校验和、文件比较、RTK read、常见 Git 查询及可信 Jugg 设备列表；字面量 sh 查询批次逐条判定。HTTP(S) GET/HEAD、Homebrew info/search/list、限时 TCP 探测和受限 SSH 查询接入既有可信 CLI 适配，检查隐式配置与精确参数；上传、落盘、安装、转发、混合写入和任意脚本继续要求任务授权，沿用只读审计。

- 修复 `git -C <目录>` 只读查询被无任务门禁误拦：原生与 RTK 包装支持空格路径、相对目录及连续目录切换，沿用已有只读审计；写命令、配置覆写与受限 Git 对象的跨工作区读取继续拒绝。

- MCP 可信 Session 缺失、无效或冲突时提供专用故障分类与宿主恢复指引，避免误导 Agent 反复登记任务或重启健康服务；原会话的真实身份验证与拒绝保护保持生效。

- ZIP 归档只读接入通用可信 CLI 语义适配：系统 `unzip`／`zipinfo` 可跨项目、跨文件列目录，`unzip -p/-c` 可读取明确成员到 stdout；支持 RTK proxy、空格路径及常见等价参数，继续拒绝实际落盘解压、未知混合参数、注入、模式通配、敏感成员及继承的 Info-ZIP 参数覆写。

- macOS 签名只读检查接入可信 CLI：仅系统 `security find-identity -v -p codesigning` 与两个标准 Provisioning Profiles 目录内明确文件的 `security cms -D -i` 可在无任务 Session 执行；支持 RTK proxy，拒绝路径/符号链接越界、伪入口、私钥导出、密码读取和钥匙串修改。

- 修复超大任务事件日志触发 `ERR_STRING_TOO_LONG`：会话切换检查与任务审计改用分块读取，恢复控制写入和任务恢复，保留全部历史事件。

- 修复任务授权恢复后历史 `closedGoal` 仍阻止显式合同纠正：按当前关闭状态与当前目标校验，保留历史目标和关闭事件；恢复后的所属 Session 可修订合同，未恢复关闭任务、旧执行者及顺序切换封存限制保持生效。

- Claude CLI 承载的 AI 治理模型切换为 `gpt-6.1-sol`（provider 为 `openai`），保留低推理等级、无工具推理隔离和回执模型一致性校验；替换已不可用的 DeepSeek 配置。

- 修复同一 Session 恢复未完成任务时未重开 Run：恢复已收口运行会记录新 Run 并清除旧执行对账标记，执行状态重新计入“执行中”；活跃 Run 重复恢复保持幂等，归属与冲突校验继续保留。

- 历史 `planned` 任务纳入失效承载归档：仅在登记来源与任务持续静默、已记录无 Run、无活跃 CLI／维护宿主时收口，保留原计划、契约和证据；未收口 Run、未知结束状态及读取异常继续保护。主动治理明确携带已按 ID／名称关联的任务身份，区分治理问题与原业务目标，避免单条快照缺少其他任务时误判为无关。

- 修复固定 Instory Mac mini 的 SSH 只读检查被 L0 拒绝：仅可信系统 SSH、固定目标与非交互超时参数可查询主机信息、LAN 指定目录、Core/Admin Git 状态与 SHA、进程/容器摘要及本机健康 GET；远端命令按实际拼接后的 shell 文本校验，拒绝转发、配置覆写、凭据读取、写入及注入，支持 RTK proxy。

- AWS 诊断接入受信 CLI L0：仅允许可信 Homebrew 入口的精确 `--version`、STS 身份查询、单日内最多 1000 条且禁止自动分页的 CloudWatch Logs 查询，以及限定 ECS 状态查询；ECS 详情强制安全字段投影，拒绝写操作、未知参数、凭据导出与 endpoint 覆写，支持 RTK proxy。

- AI 治理仅由明确阻塞或验证失败触发：正常回合结束、执行待确认及单纯缺少完成证据均走本地规则；异常信号跨恢复与重启持久去重，新增失败诊断才重新分析。主动按钮留空只处理新异常，填写目标时先匹配明确任务名称，无法关联则给本地回执，不遍历无关任务；推理失败不再定时重试，可通过新的明确目标请求重试，本地治理持续可用。

- 统一受信 CLI 的 L0 只读适配：保留 DevKit 的固定安装入口与精确参数校验，接入经 SHA-256 校验的 DCB 版本、doctor 及 interaction 查询。已登记且无任务的 Session 无需为这些查询创建任务；伪入口、升级替换、额外参数、写入及会写状态的 preview 仍拒绝，不扩大 CLI 整体豁免。

- 收紧自动治理的模型调用条件：正常计划、进度更新与已具备交付条件的任务仅执行本地观察；按实际阻塞、失败项与交付缺项去重，不再因步骤、证据文本或 Subject 观察时间更新重复分析。同一异常自动推理失败后不循环消耗，模型冷却期间也不调用 Jev；主动提交目标仍可分析和重试，本地对账与主线工具保持可用。

- 修复自动维护将普通会话一轮结束误判为任务移交的问题：不再凭空闲、结束记录或历史失败行动中的原会话 ID 自动转移任务归属；仅恢复维护 Agent 自身此前承载的任务，继续保护活跃执行者和版本变化。等待原因持久展示，自动分析与本地对账保持可用。

- 修复任务页孤儿归档按钮与后端限制不一致：人工归档先核实真实会话结束证据，保护活跃 CLI、维护宿主和会话，并在读取后校验任务版本；保留原执行状态、合同与验收事实。历史缺失结束事件不再将已完成更新回合的 Session 永久判为忙碌；操作失败提示独立保留，不被列表刷新抹掉。

- 修复归档任务被精确查询与恢复入口过滤的问题：真实登记 Session 可恢复原 task_id，清除旧对账及脱离标记、重新打开 Run，保留合同、Subject、证据与验收事实；继续校验 workspace、预期绑定、事件版本及活跃任务冲突。普通列表仍隐藏归档任务。

- 默认自动归档扩展到执行承载失效：会话文件仍存在但运行已明确结束且来源静默，或历史任务无 Run 且任务和登记来源均静默时，由本地对账归档并退出 AI 接续队列，CLI 不可用仍可执行。保留原契约、状态、证据和验收事实；忙碌会话、活跃 CLI/维护宿主、读取异常、未确认状态及近期来源/任务变化继续保护。机械对账不刷新宿主活跃时间，AI 行为页显示归属失效的实际归档回执。

- 修复历史任务客户端为 unknown 时漏归档：使用真实登记会话的客户端判断 Codex 会话缺失，保留原任务客户端字段；明确为其他客户端或来源未确认时不套用 Codex 缺失结论。

- 已结束任务的会话缺失对账仅核对文件存在性，避免为归档重读全部历史会话；活跃任务继续完整检查执行状态，源不可读仍不归档。

- 按用户确认的策略，将会话确认缺失后的默认动作改为自动归档：持久确认后五分钟无变化、且无活跃维护宿主或 CLI 时退出待处理与 AI 接续队列。保留原契约、执行状态、证据和未验收事实，归档收口运行与计时；可通过已有取消归档入口恢复并重新绑定真实 Session。源不可读、状态未确认、近期变化或仍有运行者时保持保护，普通客户端不能借归档伪造完成。

- 收起会话一级导航，将读取白名单和门禁豁免收至设置的高级会话管理，关联会话在任务详情展示。修复会话清除后孤儿任务永久等待原执行者：区分源不可读与确实缺失，持久登记恢复依据；确认缺失且五分钟无任务变化后，复用新 Session 接续原任务与契约，同工作区孤儿不阻挡接续。保留活跃执行者、CLI 运行与读取异常保护，不删除任务、伪造完成或替代独立验收。

- 修复 Claude/DeepSeek 返回完整 JSON 代码块时被误判为调用失败；共享解析后仍验证结构、引用及敏感字段。降级记录持久保存重试时间，冷却结束后继续分析同一目标，不将降级永久缓存为已处理。任务账本逐任务原子写入，最新对账记录从文件尾分块读取，避免历史增长导致整份文本复制和内存峰值。

- AI 行为页新增本轮目标输入，持久传入分析与维护 CLI，显示模型理解、逐项结果和行动回执。重复目标复用请求，不同目标明确冲突；执行中保留后续目标，不抢占。受理超时恢复按钮并提示核对已登记轮次。忽略生成的 AI 轮转日志副本，保留日志原件。

- AI 行为页新增当前行动说明：任务名称、处理原因、当前步骤、最近操作与下一步；工具时间线显示安全操作摘要并关联返回结果，进展持久保存。隐藏疑似凭据和用户目录，不记录工具原始输出或文件写入正文。

- 系统维护 AI 接通分析→行动→效果核对：全项目治理分析自动进入持久行动队列，Claude 宿主沿用真实 Session、Hook 与原任务契约接续，记录工具调用、执行回执及交付证据状态。避免抢占运行中的 Agent；CLI 不可用保留待办并冷却重试，已执行但结果未知的动作不盲目重放，主线工具与本地对账保持可用。

- 修复 Session 切换期限构造时两次读时钟引起的偶发自拒绝：起止期限使用同一时刻，原有 15 分钟上限和恢复完整性校验保持不变。

- 修复主动处理按钮等待本地对账导致页面代理超时：持久登记后立即受理，后台对账单独记录成功/失败与实际动作；Session 逐行异步读取，写入前复核任务是否变化。时间线使用独立读取超时预算，刷新错误不覆盖受理反馈，不把已启动处理误报为 Control API 不可用。

- AI 页面新增“立即主动处理”：先执行本地对账，再持久排队核实活跃任务；重复触发复用未完成轮次、重启可接续，CLI 失败仍记录规则降级。执行待确认任务优先核实，页面展示本轮处理进度与实际结果，分析不代替业务执行或验收。

- 主动对账未归档任务：依据本地回合结束事件收口 Run、登记可恢复动作，当前版本证据满足契约时补齐完成声明；独立验收和原任务归属保持不变。任务页区分执行中与执行待确认，AI 页面显示实际处置、依据和失败结果，CLI 不可用不影响确定性对账。

- 修复部署清理将自身生成的体积报告误判为用户改动：只接受普通文件、格式与 release revision 匹配的报告；保留当前版、上一成功回滚版与真实用户改动。

- 修复 AI 协作快照升级时误将已结束历史判为新变化：启动时迁移旧快照基线，后续真实任务内容变化仍自动参与；不删除已有审计。

- AI 辅助接入 Agent 任务回包：即时返回契约补齐、阻塞恢复、证据复用与绑定修复步骤，并附上快照一致的有效 AI 建议；模型或日志不可用时仍可继续主线。行为页展示推进建议和后续任务事实，不将任务变化冒充建议已执行，不自动修改授权、契约或验收。

- AI 治理改为自主参与：受管理的独立观察器自动关联当前工作区活跃任务和新内容变化，Jev 判断是否参与，Claude/DeepSeek 自主判断并分析；同快照持久去重、每任务间隔一分钟，模型失败冷却五分钟并返回规则结果，主线操作不等待 AI。行为页优先展示观察器状态、触发原因和参与判断，手动入口折叠为补充。候选环境禁用自动推理，不重放已结束历史，不自动修改任务或验收。

- 修复正式 release 的 AI/Jev 日志目录绑定，恢复共享治理日志与已有 Jev 观察记录的读取；候选 release 继续隔离日志，并明确页面当前按需手动分析。

- 确立“任务即契约：以契约约束执行，以持久状态管理过程，以证据判定完成”为底层原则，在项目定位与 Agent 协作规则中约束后续改动；保留宿主执行、独立验收及外部 Review 边界，不改变运行协议。

- 彻底移除模型调度页面、角色配置、路由/委派/托管 Reviewer 的 HTTP/MCP、执行器与运行依赖。TaskCenter 只治理主线任务；子代理 Hook 在联网前放行，会话同步忽略子代理。保留任务合同、验证、独立验收、外部 Review 证据及历史数据。主线 AI 分析使用独立配置 `config/ai-governance.json`。

- 新增「AI 行为」页面，统一展示治理分析、Jev 路由与观察建议、执行路由和执行器回执。手动通过 Claude CLI / DeepSeek 分析完成证据与失败阻塞，发送前预览并确认受限任务快照；禁用工具与会话持久化，记录调用、结果、失败、耗时和用量，不自动验收或修改任务，AI 不可用时自动降级规则检查且不阻塞核心工具；普通执行仍保持 native-only。

- L0 精确支持可信 uv DevKit 安装入口的禁 Python 字节码包装与 doctor、asset status、asset capture preview 参数；仅允许当前工作区，只生成计划，不执行项目 check。apply、构建、未知参数、伪造入口、任意环境变量和跨工作区继续受执行门禁限制。

- 按格子授权为 `instory-pca-2` 增加唯一 `memory.md` 的 apply_patch 新建/更新能力：批准配置与宿主 automation 元数据、启动消息、登记工作区共同绑定；拒绝其他身份/路径、链接、删除/移动、多文件及 shell 写入。结构化记录的失败/未完成状态保留成功基线，补丁批准与真实落盘分别记录哈希审计，inStory 项目写门禁不变。

- 修复无活跃任务的 Git 对象巡检被 L0 误拒绝：精确支持分支 ref 验证、SHA 解析、固定 SHA 的树/blob 读取与路径差异；scheduled_readonly 复用相同校验，无需扫描豁免。保留写入、危险 Git 选项、定时复合命令和跨工作区限制，不扩大自动化身份或 memory.md 写权限。

- 拒绝诊断改用当前原生派发与 RTK 规则，具体分类优先；Hook 上报失败仍保留本地恢复说明，MCP 错误和有界路由响应保留恢复指引及必要状态。调度页展示原因、处理责任、下一步和验证，区分当前与历史路由；新增限量且仅返回安全字段的拒绝记录 GET，不增加依赖或恢复执行按钮。

- 修复 L0 只读审计用宿主 cwd 覆盖正式 Session 工作区的问题；审计仅更新时间与计数，后续任务复用、创建与顺序切换保留显式项目绑定，跨项目校验不变。

- 修复控制服务刷新大任务事件索引时同时保留新旧快照导致的堆内存耗尽；在既有堆上限内先释放旧缓存，只缓存当前查询任务的事件，减少与响应序列化叠加的占用。
- Reviewer finish 保留首次提交时间；报告已落账后，同一绑定 Session 可恢复上下文并幂等重试报告与租约释放，重复提交不同结论仍拒绝。
- Review 事件写入后进程崩溃时，重试从已有事件恢复缺失的任务投影与去重记录，不再重复追加同一报告；保留历史原始事件。

- 修复任务更新省略工作区时被 Session 当前目录覆盖的问题：已有任务优先保留绑定工作区，显式更新仍生效；独立 Reviewer 的模型、工作区、只读和身份校验保持严格。

- 方案 A 保留 vinext/React 与 Node 服务，移除 Next 编译器、Cloudflare/Wrangler/Workerd、未使用的 Drizzle/Worker/Sites 模板链。页面使用 vinext 导出的兼容 API；独立 TypeScript 检查和现有 React/Hooks/无障碍 lint 插件替代 Next 工具链。
- 固定体积预算覆盖完整开发依赖，发布在裁剪前检查；直接依赖、锁文件及安装树禁止退休的重依赖回流。平台基线必须由实际干净安装校准，检查不自动上调阈值。
- 移除 Bug 闭环的 UI、HTTP/MCP 和队列；新写入的退休字段明确拒绝，旧任务/事件保留并使用通用就绪规则。
- 移除内置 Codex SDK/CLI 创建、恢复、委派、Reviewer 启动及模型目录探测；保留只读会话、用量、配置模型展示与外部原生/Review 协议。旧投递、反思执行、试点唤醒入口退休，历史队列不迁移或重放。
- 发布依赖先完整构建再裁剪开发/可选依赖，生产启动直接调用现有 vinext server API。新增固定 artifact 预算、禁止 Codex 包、构建/报告摘要和 release 复用检查；超限或缺平台基线均在切换前失败。

- 模型调度改为读取本机 Codex 会话模型目录并勾选派发名单；集中白名单覆盖显式型号、容量与额度回退，空名单由主模型继续。目录可选性与实际原生派发能力分别校验，新增型号和档位映射自动填充。
- 调度页逐条展示持久化 Jev 阶段、候选、建议、置信度、用量、覆盖原因和实际派发回执；支持历史翻页，失败与降级记录可见，不再从任务摘要截取最近三条。

- 模型调度页新增模型启停、首选与回退排序、模型目录和原生映射增删改查；集中配置保存校验角色引用并检测并发冲突，仅影响新派发。

- 按用户当前 GPT 额度充足的派发偏好，将普通 executor 首选调整为 GPT-6 Luna，Kimi Coding、Highspeed、K3 依次保留为回退；原生派发能力、推理档位、并发与 Reviewer 策略不变。

- 修复已登记、无活跃任务的 Session 执行 `git worktree list` 被误拒绝：L0 精确支持普通输出、`--porcelain`、`-z` 和 verbose 选项及 RTK 包装；新增、删除、prune、repair、未知参数和混合写命令仍不放行。

- 手动 Reviewer 可通过 `taskcenter_review_start` 显式领取已有审查授权，已绑定独立 Session 可在 MCP 重连后恢复报告上下文；保留受管启动器兼容、模型/工作区/只读/Subject/有效期校验。失败返回错误码和接续步骤，公开 Review 记录增加 `route_id`，不公开领取令牌。

- 模型调度默认展示当前角色策略与原生会话派发，CLI 历史默认折叠；按通道统计用量覆盖率，成功率排除未决、撤销和取消授权，明确领取至结案时长并非实际执行耗时。新增原生路由与主模型接管计数。

- 修复 MCP 压缩引用被 Kimi Router 再次展开导致 token 反增：使用纯 `#/$defs/` 引用，保留工具契约与原预算；增加引用形状回归检查并记录真实 Router 离线转换对照。

- 暂停 MiMo 2.6 Flash / Pro 自动执行派发；已完成原生工具读写验收的 Kimi Coding 改为首选，回退依次为 Kimi Coding Highspeed、K3、Luna。保留 MiMo 历史记录与模型映射，配置热加载作用于新路由。

- MCP 工具目录保留全部工具与参数校验，使用工具内部 JSON Schema 引用去重；支持 `TASKCENTER_MCP_SCHEMA_MODE=inline` 回退。新增 `npm run mcp:budget` 和测试内置体积门禁，固定 o200k_base tokenizer，基线增长 2% 预警、5% 失败并列出超标来源与处理建议。

- 按用户授权将 MiMo 2.6 Flash / Pro 原生执行档位设为 high，与宿主实际支持能力一致；其他模型档位不变。

- 移除不可用的 MiMo 2.5 / 2.5 Pro 执行候选、原生映射与候选目录；保留 MiMo 2.6 Flash / Pro 优先，随后 Kimi 三款及 Luna。集中配置热加载立即作用于新路由，历史记录不清除。

- 普通路由无可用执行器、能力或容量时自动返回当前主模型 direct 租约；派发失败回执携带停止执行器、撤销授权和主模型接管步骤。Jev 的 needs_context 交回主模型处理，direct 不再受一次性口令或限定例外阻断；保留失败审计、任务权限和 Reviewer 独立边界。

- 普通执行改为 Codex 原生会话派发，停用新 CLI 路由和授权；MiMo 四款优先，Kimi 三款与 GPT-6 Luna 共八款由 Jev 按任务和宿主实际能力选择。能力缺失、容量不足或 Jev 失败不回退 CLI。两款 Kimi Coding 按用户授权使用 high，其余保持 low/medium；保留历史 CLI 回执和撤销。

- 修复显式 Codex native 路由未携带 runtime 模型 ID，导致原生 delegation grant/claim 拒绝的问题；仅当调用方声明本轮可用的 Codex 模型能力时路由成功。

- 接入 Codex 原生其他模型执行：`config/model-roles.json` 新增可选 `native_models`（canonical 模型 → Codex 原生 runtime model ID 与 low/medium 上限内的 reasoning_efforts），`routing_select` 接受 `available_native_models`（本轮 spawn 工具实际能力）。auto 路径在能力交集内优先原生路由并同时返回 canonical `selected_model` 与实际 `native_model`，健康与 quota 按 canonical 记账；显式 native 能力缺失返回可操作不可用原因且不消费容量，不再静默转换 CLI，显式 cli 与显式 Codex native 语义不变。native delegation grant 必须绑定有效 `route_id`，claim 要求独立已登记 Codex Session 的 model 等于路由 `native_model`，错配或已结束租约一律拒绝；CLI 旧协议与 report/revoke/routing_result 收尾不变。

- Hook/CLI 拒绝即时检测：PreToolUse 与 CLI Run 权限类失败在拒绝发生时上报安全分类（分类码/时间/Session/task/run，不含原始命令与错误正文）到 `/gate-denials`；服务端按 1 小时窗口、60 秒短窗口去重后同步评估 ≥3 独立任务、≥5 独立 Run 或同任务重复 3 次的异常，并对单次与异常拒绝都返回具体恢复与验证步骤。无活跃任务的 L0 拒绝与 CLI `failure_kind` 均保留可见；记录文件按大小截断保留最近数据。

- 修复 CLI 派发重放缺口：同一 Session 对同一 delegation 的幂等重复 claim 此前会被启动器视为成功并再次向 Harness 提交 prompt；现启动器在提交前以 `CLI_GRANT_REPLAY` 拒绝。claim 失败或结果未确认时不撤销可能属于另一执行的授权，也不释放其路由租约；显式新 attempt 使用新 delegation 的首次 claim，路径不变。

- 主模型直接执行除既有限定例外外，可由任务所属 Codex Session 在任务创建后发出的明确用户指令授权；授权绑定任务与 Session，两小时内仅可成功路由一次。

- delegation 申请时即拒绝窄 scope 配 Shell 工具（`Bash`/`exec_command`）：此前只在 touch 阶段 403，现申请即返回 400；仅文件工具的窄 scope 继续合法。CLI manifest 默认超时按 mode 区分：read-only 保持 300000ms，workspace-write 放宽至 1200000ms，显式 `timeout_ms` 与 1800000ms 上限不变。

- 跨项目 CLI 启动改为校验受信任启动器的真实路径；Codex 仅对持有 CLI 路由的 `--stdin` 启动允许一次交互输入，避免非交互命令关闭 stdin 后派发失败。

- 修复 CLI 派发启动前的路由自举死锁：受管启动器可从 stdin 接收授权与有界任务输入，自行创建 0600 临时文件；Hook 仅对持有 CLI 路由的精确启动命令放行，主模型写入仍需 direct 路由。
- 非 Codex CLI 执行器并发占满或明确容量／限流熔断时，按明确授权以 `gpt-6-luna` 作为末级容量兜底；权限或门禁失败不触发该回退。

- Jev 建议派发时收紧显式 direct：仅真机、原子 Git、共享脏工作区的结构化例外与证据引用可覆盖，并留存审计；模型调度页新增最近 24 小时建议、实际路由、覆盖与 CLI 授权／运行的独立计数。

- 普通阶段路由改由 Jev 完整选择执行通道；显式通道覆盖保留原因，决策账本保存有界阶段摘要、输入哈希、置信度及实际应用信息。Codex 项目执行增加活动路由门禁，兼容受控部署期间的旧服务接口。

- Codex 调度目录迁至 GPT-6 系列：Reviewer 使用 `gpt-6-luna`，显式 CLI 入口提供 `gpt-6-sol`、`gpt-6-astra`；活动额度池移除 5.6/5.3 型号与 Spark 专用旧池，旧型号留在退役列表用于拒绝历史误选。

- 模型调度页将 CLI 执行器消耗汇总置顶，其后展示当前执行器与最近派发，模型目录默认折叠；每 5 秒同步刷新租约、调度与用量，保留未保存的策略输入，刷新失败时明确标记旧数据。

- 扩展自动执行候选为四个 Kimi 与四个 MiMo 型号；Jev 在同一请求中选择类别、执行方式和具体型号，默认参与新阶段，并记录候选、选择、耗时与用量。共享额度池限制 Kimi/MiMo 各两个、执行器总计四个并发；MiMo 2.5 系列到官方下线时间停止自动选用。调度页独立展示完整候选目录。

- 部署依赖准备前移到完整测试之前：先离线安装，明确缺包时仅回退一次联网安装；离线/联网总时限分别为60/180秒，超时终止候选安装进程树并保留旧服务。安装关闭隐式audit/fund请求，完整验证、候选健康检查及回滚策略不变。

- CLI 看板仅统计 CLI 通道，区分授权与已领取、补齐撤销/过期/未领取状态；新增逐次任务、工作区、最后心跳和等待/失联状态，不再把无 active 记录称为空闲，未领取等待时间不计运行耗时。

- 部署健康切换后强制执行构建清理，仅保留当前与上一不同成功版本；提供 service:prune（支持 --dry-run），保护异常目录和用户改动，清理失败显式报错且不回滚健康实例。

- MiMo 派发目录支持 mimo-v2.6-pro、mimo-v2.6-flash、mimo-v2.5-pro、mimo-v2.5，补齐 CLI 入口与额度池；保留旧入口和默认路由策略，新派发读取最新配置。

- 普通 CLI 执行器并发容量调整为每个模型两个租约：K3 两个名额用尽后回退 MiMo 的两个名额，仍不自动使用 Luna；Reviewer 容量不变。

- 修复 Codex 同一输出块内 turn/start 回执与命令审批紧邻到达时的身份绑定竞态：先绑定匹配回执，再执行既有 claim、thread、turn 与 Hook 校验，避免合法请求偶发被拒绝。

- Jev 从旁路观察扩展为可启用的派发前判断：阶段类别参与集中路由、同阶段去重、失败确定性回退；主模型直接执行须说明原因并留审计，保留显式模型选择与原有授权门禁。

- Codex 受管派发改用本机 app-server：先创建真实 Session、校验型号并领取 delegation，再提交任务；启动前检查可信 TaskCenter Hook 对命令与文件修改的覆盖，缺失时提前拒绝，避免启动后才因权限失败消耗额度。Codex 仍只用于显式授权或专属验证，不进入普通自动路由。

- 普通执行默认路由切换为非 Codex 客户端：executor 角色默认 Kimi、回退 MiMo、默认并发一，能力敏感类别（security/data_migration/complex_diagnosis/high_risk）映射 MiMo 并使用 medium 档位；Luna 不进入普通自动首选或回退，仅用户显式授权或 Codex 专属实测时使用；默认路由把选中型号反解为实际 `cli_profile`/`harness` 并始终报告该 profile 实际执行的推理档位，delegation claim 随之校验客户端一致，消除路由报告与实际执行不一致的风险；默认非 Codex 选择请求 `native` 通道时推荐转换为实际 `cli` 通道，`direct` 主模型执行与显式 Codex `native` 路径不变；Reviewer 角色与 fail-closed 行为不变。

- 修复 Kimi ACP 权限请求未携带参数时的工具关联：从同一调用的完整 JSON 参数快照校验权限，保留一次授权和任务门禁。

- 受管 Claude/Kimi 派发统一接入现有 Harness 操作，保留任务领取、逐工具权限和型号回执校验；集中配置支持客户端多模型目录及四个已核实的 Kimi 型号，旧 profile 继续兼容。

- 子任务派发收敛为主窗口自主选择 Luna、MiMo、K3；关闭 Codex 自动升级和容量回退，其他既有 Codex 执行型号标记退役，主窗口模型及历史记录不变。

- 修复任务创建与幂等重放整文件拆分事件历史导致控制服务内存溢出的问题；改为倒序分块读取，保留历史数据及原有幂等校验。

- 页面新增版本徽章：/health 透出 release（package version + 部署 revision），所有工作台页面右下角展示
- 修复：模型调度页 governance 读取接入代理白名单（/governance-metrics），避免整页加载失败
- 修复：任务事件索引裁剪无消费方的大文本字段（reason/review_reason/routing_reason 等），只保留详情白名单渲染与去重字段，源事件文件完整保留；索引体积下降、128 MB 堆下增量重建稳定（全量测试恢复全绿）。
- 额度池模型：config/model-roles.json 新增 quota_pools 定义（provider/models/source/notes），model-role-config 解析并随 /routing/health 透出；实测 kimi/claude CLI 无官方余额查询接口，MiMo/K3 池按 runtime-signal 标注（余额未知、仅限流信号与本地累计），Codex 池按官方 rate_limits 标注；额度池页面显示来源、覆盖模型、主次窗口与观测时间。
- 今日用量与执行器消耗：模型调度页新增"今日用量（24 小时）"（主代理 Token 与成本估算）与"CLI 执行器消耗"（运行次数、状态分布、按模型分组、回执 Token）；任务详情 CLI 执行记录显示每次回执用量；governance-metrics 新增 cliRuns 聚合，metrics-worker 定期写入。
- 模型健康卡片补充限流恢复时间、最后错误、最后成功；试点评估口径见 docs/delegated-cli-pilot.md。

- delegation CLI 运行增加中间态与心跳：领取后上报 running，权限校验与限流中断记录 waiting_permission/waiting_quota，执行中定期 touch 更新最后观测时间。任务详情展示 CLI 运行状态（启动/执行/等待权限/等待限流/失联/终态）与最后观测，失联与失败分开，信号不足标待确认。

- 任务详情与活动随刷新更新，分别展示加载、失败与上次成功观测；失败保留同任务旧数据，切换任务和迟到响应不串用。区分路由选择与有绑定证据的客户端报告模型，活动仅展示允许字段，工具调用不再暗示执行成功。

- 任务查询支持服务端按任务与 Session 精准过滤及显式 `view=summary`；默认 full 保留完整字段、全部结果和归档可见性。单任务摘要减少不必要历史，查询失败不再伪装成空结果，完成报告预读复用精准查询。

- Context 同步超时取消传输并阻止迟到响应触发后续写入，已发送操作明确为结果未知；映射与审计文件写入统一收紧至 0600。启停锁先准备完整 owner 再原子发布，旧版无 owner 锁保守报错；内容字段保留换行缩进并兼容旧事件重放。

- 修复任务账本超过 500 条时静默丢失历史与活跃任务的问题；查询及普通事件不再因会话源缺失自动移除任务。创建事件超出去重窗口仍核对历史，缺失任务拒绝直接复活；新增[只读恢复证据预览](docs/task-retention-recovery.md)，不自动写回或推断验收状态。

- 补齐 Node、Claude、Kimi 精确版本查询的 L0 放行，复用同一版本判定供终端检测使用；携带执行参数、重定向或写入的组合仍需任务授权。

- 修复无活跃任务时 CLI 路径探测被 Hook 误拦：精确放行 which、command -v/-V 和 type 查询，保留实际执行与写入授权；拒绝提示区分未识别只读命令与已检测写入。

- 新增 Kimi／Claude 可选 CLI 执行入口及集中 profile：绑定原任务路由和 delegation，真实 Session 领取后执行、回写并释放租约；请求型号、报告型号和推理档位分开记录。保留默认 executor/reviewer，未知结果不自动重试。

- 补齐跨客户端共享任务接手：复用 resume，保留创建者、当前执行者与交接记录；有效委派未结束时拒绝换手，旧 Session 不能借手动事件前缀继续更新任务。支持已启动客户端接手，不自动启动执行器。

- Claude SessionStart 注入真实 Hook 身份与生命周期调用指引，门禁拒绝时回显真实 Session；补齐完整参数、Context 语义绑定及验收项 ID 模板，防止自拟身份的 MCP 冒烟测试被误认为真实会话验收。

- 修复治理指标刷新大体积中文任务历史索引时的堆内存溢出：减少解码副本并按任务分段原子写回，保持索引格式、历史记录与现有内存上限。

- 引入同进程静态 Harness 适配层，统一能力查询与执行回执，迁移 Codex SDK/CLI 和 Kimi 受管 ACP 调用，保留旧入口与历史数据；会话页展示真实支持范围与用量口径。未知或未适配操作不回退到 Codex，通信异常保留结果未知并阻止普通派发重复提交。

- 整理手动按钮：任务列表与详情共享状态操作，已完成任务可重新处理或归档，归档详情可取消归档；明确状态操作不会自动启动或停止 Agent。改进建议区分刷新与重新分析，试点按钮明确请求语义，补充提交防重、Bug 取消编辑与派发状态刷新入口。

- 修复 Kimi 原生 Hook 把 Claude 形态 JSON 外壳原样写入 stdout 刷进终端与上下文的问题；现仅输出 `additionalContext` 纯文本，仅在出现 `permissionDecision` 时保留 JSON，并补协议测试。

- 修复 Kimi 原生 Hook 丢失 PCA 上下文注入：Kimi 0.43 的 `UserPromptSubmit` 载荷中 `prompt` 为内容块数组，直接透传给 PCA 共享桥接会因空 prompt 静默跳过 `prepare_turn`；现归一化为文本后再桥接，并补协议测试。

- Kimi 增加 Hook + ACP 受管入口：自动登记、PCA 上下文注入与回流、同会话恢复、取消与逐次权限确认；按真实 `session_<UUID>` 绑定 MCP 身份，记录上下文用量快照，未知费用不估算，不读取历史正文或改写用户配置。

- 集中多 Agent 标识与 TaskCenter 适配能力，新增能力查询、通用宿主 Session metadata 入口和身份查询；提供 Kimi Code CLI MCP 配置及基础闭环说明，保持 Codex 兼容和身份冲突拒绝，未适配能力明确标注。

- MCP 的 Session 登记、任务开始与任务更新/报告接口支持 `agent: "kimi"`，保留 Kimi 身份，无需再登记为 `unknown`。

- 修复旧接口返回的审查原因仍可能触发任务重新处理的问题；明确验证审查过期不阻塞流程，移除重复测试断言。

- 所有任务的 Review 均改为非阻塞信息，包括 `strict` 与历史 `required` 合同；审查缺失、过期、拒绝或未解决发现不再阻断完成判断、待验收分组或自动产生返工要求。审查真实性、验证、权限和独立验收约束继续保留，不批量改写历史记录。

- 本项目协作默认由用户安排外部 Agent Review，实施 Agent 不自动派发、等待、导入或处理审查结果；补充外部审查注意事项。此调整仅影响协作规则，不修改接口或历史审查策略。

- 已完成任务支持通过 `taskcenter_task_resume` 在当前或新 Session 接续原交付，恢复执行状态且不受等待时长限制；提交后的合并、验证无需重复建任务，仍校验任务归属、工作区和单活跃任务。Hook 拦截提示优先引导接续原任务。

- 任务工作区状态标签在窄列中保持完整显示；计划、阻塞和其他需处理任务可直接开始、恢复、重新处理或返工，已取消任务可二次确认归档，活跃任务可二次确认关闭；任务状态操作继续受同源代理与 Control API 校验保护。
- 归档任务不再进入默认任务列表和看板统计；任务详情与 append-only 事件历史继续保留，避免已完成任务长期堆积为待验证、待验收。
- 普通代码审查默认改用本地 `ocr_review.ocr_auto_review` MCP，保持免费模型优先和完整费用、积分、覆盖率回报；TaskCenter 正式独立审查继续绑定集中 `reviewer`、独立 Session 与同一 Subject/OCR 证据，普通自动审查不得冒充独立验收。
- 统一版本号、更新日志、受控部署与正式发布规则：`package.json` 为版本单一来源，Changelog 只保留一个 `Unreleased`，部署继续使用 Git revision，SemVer 与 tag 仅在明确发版时更新。
- TaskCenter MCP 集成改用稳定 launcher：从受控元数据解析当前不可变 release，避免开发工作树缺少依赖或发布切换导致 Codex 工具加载失败。

- 新增只读活跃任务复用 Advisor 与独立 append-only 决策审计，返回可解释的 `reuse/create_new/uncertain` 建议并完整保留 `force_new_reason`；Session/project 身份严格绑定，审计查询受本机 MCP 令牌保护，跨进程锁与可恢复的 event-id/顺序/project/workspace 索引保持并发幂等和有界查询；首阶段不增加 Hook 提示、阻断或自动合并。
- 新增 append-only 任务阶段事件与阶段报告，分别提供并行去重的任务墙钟、各执行器累计活动时间和显式等待来源；复用 Review Cycle 作为 Review 时间权威账本，并让旧任务保持 `unknown` 而非伪造零值。
- 正式服务改为运行不可变 release worktree 与 production build，开发工作区修改不再被当前实例热加载。
- 新增隔离候选自检、失败自动回滚、发布阶段事件与 `service:history` 研发效能摘要。

- Adds incremental `review_cycle.reported` observations, Review Attestation v3 linkage, finding fingerprints, review-stage distributions, data-quality coverage, long-tail diagnostics, Completion Packet review history, and a team-level Review governance panel while preserving legacy attestations unchanged.
- Keeps wall-clock and caller-reported active Review time separate, excludes unaccepted and independent OCR tasks from implementation completion ratios, and reports missing samples as data insufficient instead of zero.
- Recommends an independent Luna reviewer after known Spark OCR unavailability while retaining the same Subject, OCR Bundle and rules references plus explicit fallback and recovery audit fields.

- 门禁豁免支持按精确 Session 一键加入与退出，操作幂等且不会覆盖其他 Session。

- Adds a fail-closed, per-Session `scheduled_readonly` Hook profile for the fixed CyberRole context automation, scoped to one workspace, one rolling report, a fixed managed-payload probe, exact read-only MCP queries, and the sole ability to patch that report without TaskCenter/PCA/task mutation authority.
- Adds L0 registered-session deterministic read-only access with aggregate-only auditing, while keeping writes, composite shell forms, interpreters, redirects, and unregistered Sessions fail-closed.
- Defines L1 `fast`, L2 `standard`, and L3 `strict` defaults: verification is required for L2/L3, independent current-Subject review for L3, and Subject changes stale prior verification and review evidence.
- Adds `response_mode: summary|full` to task mutation/report MCP calls; summary is the compact default, while routing/delegation control calls retain full operational replies for backward compatibility.

- Adds `taskcenter_routing_select` and `taskcenter_routing_result` as a local model-routing control plane with per-model concurrency leases, TTL expiry, idempotent results, and `Closed/Open/Half-Open` circuit state.
- Keeps routing advisory and recoverable: TaskCenter never launches CLI executors, Sol can record a reasoned override, external work can use static fallback while the service is unavailable, and OCR reviewer failure cannot be auto-substituted as independent approval.
- Stores mutable routing health in ignored `data/routing-control.json` under the single control-server writer while retaining append-only `routing.decision` and `routing.health` task audit events.
- Opens the circuit immediately for explicit capacity, rate-limit, or model-unavailable responses and treats Codex `Bash` and desktop `exec_command` as the same delegation tool family.
- Adds short-lived CLI delegations so ordinary executors attach their own registered Session and auditable CLI Run to one formal parent task instead of creating duplicate formal subtasks.
- Enforces delegation workspace, TTL, optional tool allowlist, and file-tool scope boundaries; Shell execution requires explicit whole-workspace scope and never gains parent-task completion or acceptance authority.
- Adds platform-neutral v2 task contracts with structured acceptance criteria, optional execution environments, verification plans, versioned Workspace Policy, and legacy migration without rewriting history.
- Adds generic SubjectReference and ActorIdentity models, append-only Requirement Results, Verification Claims, Review Attestations, Acceptance Records, derived stale events, and machine-readable completion readiness.
- Adds Session-free core events, offline evidence import with occurrence/recording timestamps, JSON/Markdown exports, and an independently token-protected generic acceptance API; Context remains a compatibility adapter and `done_claimed` never auto-promotes to `accepted`.
- Adds MCP tools for subject updates, requirement/verification/review reporting, evidence import, readiness, export, Completion Packet, and independently authorized acceptance; TaskCenter availability is not a build/test/commit/release prerequisite.
- Replaces implicit full-session scanning with a fail-closed Session allowlist that filters files before JSONL parsing.
- Migrates only explicitly listed IDs from legacy `all` / `selected` selection files and keeps unapproved message bodies, cwd values, and summaries out of dashboard data.
- Adds a local reflection loop that derives auditable improvement proposals from aggregate allowlisted data and the task ledger without copying Session text or modifying source automatically.
- Adds manual accept, reject, and re-review actions for reflection proposals plus isolated persistence and cross-platform tests.
- Turns accepted proposals into idempotent formal tasks, then dispatches them to a selected existing or newly created Codex Session while preserving the Hook gate.
- Tracks proposal, task, Session, and dispatch linkage; Agent-completed improvements resolve when a new reflection pass no longer detects the signal, otherwise they reopen for review and can be manually returned when incomplete.
- Removes the default pending-review queue and per-task approval action: `done_claimed` appears as completed, while manual reject remains available for later corrections.
- Separates delivery deadlines (`dueAt`) from estimated active effort, tracks wall/active/blocked durations and estimate revisions, and keeps `expectedAt` as a legacy compatibility alias.
- Stops promoting legacy `expectedAt` values into delivery deadlines; only an explicitly recorded `dueAt` can produce delivery-overdue status.
- Emits idempotent Agent-facing calibration feedback for schedule lateness or active-effort overruns, while legacy tasks without segment evidence report active effort as unknown instead of reusing wall-clock time.
- Adds delivery delay, active-effort variance, and blocked ratio to aggregate planning reflection evidence and turns estimation calibration into explicit improvement-task acceptance criteria.
- Separates the empty-allowlist setup prompt from Agent improvement tasks, removes review/dispatch actions from that prompt, and dismisses it immediately after a non-empty allowlist is saved.
- Recognizes RTK-wrapped read-only inspection commands in the Hook while continuing to reject wrapped writes, shell control operators, and output-producing Git options.
- Adds a separate fail-closed Hook gate-exemption allowlist so explicitly selected Sessions may work without an active task while command safety checks remain enforced.
- Adds a Codex `UserPromptSubmit` preparation hook that tells non-allowlisted Agents to create or reactivate a formal task before their first write, while keeping exact Session allowlisting as the only task-gate exemption.
- Adds a Node-based cross-platform service controller with managed heartbeats and graceful stop requests for macOS, Linux/WSL2, and native Windows.
- Removes POSIX environment assignments and shell glob expansion from build and test scripts.
- Moves Hook recovery to the Node controller and covers PowerShell and Command Prompt interactive-process forms.
- Resolves standard Windows npm `codex.cmd` shims without interpolating prompts through a command shell.
- Adds `windows-latest` CI coverage and platform-neutral Context launcher tests.

## 0.1.5 - 2026-08-14

- Automatically restarts the local control service once when a Hook request finds it offline, then retries the original governance check.
- Adds an exact, project-root-only break-glass allowlist for the fixed `start` and `status` commands while continuing to block arbitrary writes.
- Launches the managed service in a detached process group so it survives the shell session that started it.

## 0.1.4 - 2026-08-14

- Removes the vulnerable `image-size` development dependency by temporarily pinning `vinext` to the last compatible release before it was introduced.
- Overrides Drizzle Kit's deprecated loader chain to use patched `esbuild` 0.25 or newer.
- Restores a clean full `npm audit` while keeping production dependencies unchanged.

## 0.1.3 - 2026-08-14

- Rejects single `&` and the remaining shell control operators before the Hook read-only fast path.
- Blocks additional stdin/interactive interpreter forms, including `env --`, script-plus-interactive flags, and `-` stdin markers.
- Restores terminating interpreter queries such as `--version` and `--help`.
- Treats non-JSON or non-object Context MCP success responses as protocol failures so compensation remains eligible.

## 0.1.2 - 2026-08-14

- Removes `git grep` from the Hook read-only allowlist because its pager options can execute external commands.
- Uses the canonical Codex `Bash` Hook payload and rejects known stdin-driven shell/REPL launch forms while documenting the guardrail boundary.
- Retries Context observation idempotency conflicts with the exact `543cf19` payload shape and keeps tests off the runtime map.
- Reads MCP and Context client versions from the package version and reports `0.1.2` consistently.
- Compares the empty tree to `HEAD` when the CI base is zero, missing, or disconnected.

## 0.1.1 - 2026-08-14

- Withdraws the affected `0.1.0` release and publishes the reviewed open-source tree under a new version.
- Preserves the complete legacy Context idempotency request, including `reqradar-context-*` event IDs and `reqradar_task_id` observation payloads.
- Removes `sed` from the read-only Hook allowlist and rejects interactive PTY or bare shell/REPL commands that could be continued through `write_stdin`.
- Isolates unit-test dashboard output while keeping `test:integration` pointed at the real synchronized dashboard.
- Handles missing or all-zero GitHub push base SHAs and standardizes the lockfile on the official npm registry.
- Replaces project-specific test roadmap data with explicitly synthetic fixtures.

## 0.1.0 - 2026-08-13 (withdrawn)

This release was withdrawn. Do not use or republish its tag or artifacts.

### Breaking migration from ReqRadar

- MCP server name changed from `reqradar` to `taskcenter`.
- Hook and MCP entrypoints changed to `scripts/taskcenter-hook.mjs` and `scripts/taskcenter-mcp.mjs`.
- MCP tools changed from `reqradar_session_register`, `reqradar_session_status`, `reqradar_task_create`, `reqradar_task_query`, `reqradar_task_update`, and `reqradar_task_report` to their `taskcenter_*` equivalents.
- All `REQRADAR_*` environment variables were renamed to `TASKCENTER_*`. Legacy names are not read; replace them before startup, especially session filters such as `REQRADAR_THREADS`, otherwise the default scan scope is `all`.
- Remove the old `reqradar` MCP server and Hook entries, then run `npm run integrations:print` and merge the generated `taskcenter` entries with the Codex and Claude Code configuration.
- Replace old absolute paths, restart Codex and Claude Code, verify `/mcp` and `/hooks`, and confirm the Session selection in the local dashboard before scanning.
- Remove the old ReqRadar desktop shortcut and run `npm run desktop:install` again. Runtime files remain local under the clone's `data/` directory and are not migrated automatically between clone locations.
- Context bridge external idempotency keys intentionally retain the legacy `reqradar-context-*` prefix so upgrades and compensation retries do not duplicate downstream effects.

- Initial open-source source release.
- Local task dashboard and Codex session discovery.
- TaskCenter MCP task protocol and task ledger.
- Codex and Claude Code Hook/MCP configuration templates.
- macOS desktop launcher.
- Local-only privacy and acceptance boundaries.
