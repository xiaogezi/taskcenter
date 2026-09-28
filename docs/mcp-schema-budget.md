# MCP schema 压缩与预算

## 已选方案（2026-09-28）

保留全部 48 个工具、参数、必填约束和原始 Zod 运行时校验。
仅在 `tools/list` 中将同一工具内部重复的 schema 节点替换成 draft-07
`$defs` / `$ref`。不跨工具引用，不隐藏工具，不改业务处理函数。
保留 draft-07 契约；`$defs` 用作本地 JSON Pointer 的存储容器，由 SDK Ajv
验证可解析。引用节点不带兄弟关键字，避免 Kimi Router 将其再次展开。
引用已有作用域的 schema 保持原样；不能节省体积的 schema 也保持原样。
默认值、示例和属性名称不参与 schema 节点替换。

原生 Zod `reused: ref` 只识别相同实例，试测收益约 3%；本实现基于生成后的
完整结构相等进行去重。引用展开后必须与 SDK 原始目录完全相等。

## 实测与边界

| 紧凑 JSON | 原始 SDK | 压缩目录 |
| --- | ---: | ---: |
| UTF-8 字节 | 100139 | 87880 |
| o200k_base tokens | 30723 | 25069 |

字节下降约 12.2%，tokens 下降约 18.4%。这是工具目录的编码结果，
不等于宿主实际模型请求或计费收益；宿主可能展开引用或按需加载工具。
当前验证覆盖真实 stdio MCP Client、SDK Ajv schema 编译、全部工具展开等价、
成功调用与非法参数拒绝，以及既有业务集成测试。其他宿主的引用展示和实际
请求行为需要在对应宿主核验，不能从协议测试推断。

### 本机 Router 离线兼容核验

直接调用已安装 Codex Router 的 `namespace-relay.mjs / repairToolSchemaRoots`
（`inlineForeignRefs: true, declareTypes: true`，对应 Kimi 路由）。以同一
48 工具的 Responses function 包装对照，未发送上游请求、未读取认证数据：

| Kimi 转换后 | 字节 | o200k_base tokens |
| --- | ---: | ---: |
| 原始 inline | 97533 | 30114 |
| 首版 definitions 引用 | 104874 | 33499 |
| 修正为纯 $defs 引用 | 85220 | 24448 |

首版引用被 Router 展开且保留定义，导致反向增长。改为纯 `#/$defs/` 后，
这一步转换的 tokens 比 inline 减少约 18.8%。测试锁定所有生成引用都是
纯 `$defs` 指针，同时继续验证全部 schema 展开等价。Router 升级时应重新
核验转换；上述结果不证明实际会话已加载新版 MCP，也不代表线上计费。
预算维持首版固定基线，不因修复自动上调。

若客户端不能解析引用，在该 MCP 进程环境设置
`TASKCENTER_MCP_SCHEMA_MODE=inline` 并重新连接，即恢复原始 SDK 目录。
此回退不改变工具调用、数据或业务权限；不需要数据迁移。

## 防止增长失控

运行 `npm run mcp:budget`。`tests/mcp-schema.test.mjs` 也会执行同一检查，
因此现有 `npm test` 与受控部署的完整测试阶段都会覆盖它。
字节数与固定版本 js-tiktoken / o200k_base 的 token 数分别比较预算。
固定基线存于 `config/mcp-schema-budget.json`，初始预算为增长 2% 预警、
5% 失败。这是项目初始防回退策略，不是模型上下文容量上限。

输出包括总量、累计增量、最大工具、增长最大的工具，以及超标处理步骤。
先检查这些工具的重复 schema 和冗余说明，保留校验语义与调用契约。
确需增长时，应在同一变更记录必要性、前后实测和兼容证据，再显式调整预算；
禁止自动刷新基线来消除失败。升级 tokenizer 也应单独核验基线差异。

负例测试会人为膨胀目录并验证报错与定位，也覆盖 token 单项超限。
不会新增定时任务、后台轮询或远程内容上传。
