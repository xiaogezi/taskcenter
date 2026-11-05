# 2026-11-05 依赖审计与门禁阻塞修复

## 结果与边界

对锁文件执行 `npm audit fix --ignore-scripts`（无 `--force`），并提高 SDK、Zod、Vite 的直接依赖最低版本。生产依赖告警从 **17（9 moderate / 7 high / 1 critical）降至 3 moderate**；包含开发依赖的完整审计从 26 降至 10 moderate。告警数量包含同一漏洞向父包传播的记录，不等于独立漏洞数量。保留 vinext 0.0.45，不进行框架主版本迁移。

以下影响判断基于当前入口：MCP 使用 `StdioServerTransport`，控制面使用 Node `createServer`；未发现项目使用 SDK 的 HTTP/OAuth 服务、Express trust proxy、`ImageResponse`、`next/og` 或 `@vercel/og` 入口。未使用当前路径不等于包没有漏洞；未来新增入口需重新评估。

## 原生产审计的 17 个包

| 包 | 原级别 | 本项目路径与实际影响 | 处理结果 |
| --- | --- | --- | --- |
| @hono/node-server | moderate | SDK HTTP 适配分支；当前 stdio 不启用 | 2.1.6 |
| @modelcontextprotocol/sdk | high | 直接加载的 MCP 服务；HTTP 会话、OAuth 与输入攻击条件需按传输区分 | 1.32.2 |
| @vercel/og | moderate | vinext 的 OG 生成依赖；项目未调用 | 保留 0.8.6，受 Satori 传播影响 |
| baseline-browser-mapping | moderate | 构建目标映射，非控制面 HTTP 输入 | 2.11.35 |
| body-parser | high | SDK→Express 请求解析；当前未使用该 HTTP 分支 | 2.4.0 |
| browserslist | high | 构建目标解析；受本地构建输入影响 | 4.29.5 |
| fast-uri | high | SDK/工具链→Ajv；未发现应用用其实施 URI/IP 安全策略 | 3.1.9 |
| fflate | moderate | OG 字体/归档依赖；未提供任意 ZIP 输入入口 | 0.7.5 |
| hono | moderate | SDK HTTP 路由分支；当前 stdio 不启用 | 4.13.16 |
| ip-address | moderate | SDK 的代理连接依赖；未发现自定义 IP 信任分类 | 10.7.6 |
| proxy-addr | critical | SDK→Express；漏洞需要特定 mapped IPv6 trust proxy 配置，本项目无此配置 | 2.0.8 |
| qs | moderate | Express 请求解析分支；当前控制面不使用 | 6.17.1 |
| satori | moderate | OG SVG 转义缺陷；当前无 OG 生成入口，但未来引入不可信内容时有风险 | 保留 0.16.0 |
| source-map-js | high | 构建/样式工具链；不是当前任务协议入口 | 1.2.2 |
| vinext | moderate | 直接框架依赖，告警来自 OG→Satori 链 | 保留 0.0.45 |
| vite | high | 开发服务器/构建工具；本地开发服务暴露时仍需关注 | 8.3.5 |
| zod | high | 直接加载的协议校验路径；大集合输入可能造成资源消耗，需修补 | 4.6.7 |

版本为本次锁文件实际解析版本。生产图包含框架的构建/peer 工具链，不能把所有生产图节点都当作公网请求路径。

## 保留项及后续条件

剩余生产 3 项是 **vinext→@vercel/og→satori** 的同一条链。Satori 修复在 0.33.5，而 @vercel/og 0.8.6 固定依赖 0.16.0；npm 建议 vinext 1.4.3 主版本迁移。强制覆盖不兼容范围会改变字体/SVG 行为，本次不采用。若新增不可信 OG 内容，应先升级并验证该链，不能依赖当前未调用的结论。

完整审计另外 7 项是 minimatch 及 6 个传播该告警的 TypeScript ESLint 包。当前兼容 minimatch 10.2.6 仍受影响；检查 typescript-eslint 8.72.1 的 typescript-estree 依赖仍为 `^10.2.2`，修复版 11.0.1 超出范围。攻击涉及不可信 glob 模式与 `optimizationLevel >= 2`，当前 ESLint 模式由仓库固定配置提供，未作为外部 HTTP 参数接收。不强制跨主版本 override；待上游兼容升级或独立验证后处理。完整审计仍返回非零，不能宣称全部清零。

一手说明：[proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)、[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)、[Satori](https://github.com/advisories/GHSA-wx4j-mvgx-mqwp)、[SDK HTTP 输入](https://github.com/advisories/GHSA-46jr-4wx8-v453)、[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249)。SDK HTTP 输入公告明确 stdio-only 不受该项影响；未来 HTTP 接入还需显式设置元素/请求大小限制，不能仅升级版本。

## 持续阻塞的已证实贡献因素

生产事件日志约 605MB；对已结束任务追加工具事件时，原代码反复同步扫描历史以确认前序任务是否已封存，会占用控制面事件循环。`/task-events` 还曾为一个目标任务投影整个账本。

本次使用文件 dev/ino/size/mtime/ctime 验证的进程内切换事件 memo；仅本进程确认的追加推进 memo。外部追加、原地改写、替换或截断会失效并重新扫描。首次扫描仍保留；不缓存授权结论、不降低前序任务封存规则。单任务查询改用既有 `loadTaskById`。服务自动恢复和 POST 结果未知时不重放的规则保持不变。

同一 256MB 日志、同一已登记 owner 与已结束任务、三次工具事件的隔离对照：原版 233/195/192ms，修复版 194/2/2ms。首扫开销仍存在，证明的是重复扫描贡献，不能据此认定所有超时都由此引起。早先缺少登记条件的样本混入了 registry fallback 扫描，不用于该因果对照。

可观测信号：扫描 >=1MiB 输出脱敏 stderr JSON `task_history_scan`，包含 bytes、elapsed_ms、switch_count；控制面继续记录 `control_request_slow` 的 endpoint/request_id/耗时与客户端放弃状态。生产日志查询 `.local/logs/web.log`。memo 命中不逐次记录，避免放大日志。当前 gate-denials 历史位于运行 release 内；根目录同名文件混有隔离测试记录，不能作为真实用户故障计数。

## 验证证据

本机忽略目录 `.local/diagnostics/security-gate/` 保存审计前后 JSON、依赖链、兼容更新输出、受控历史扫描对照、回归测试及部署/运行探针结果。相关测试覆盖 own append、外部 seal、恢复 mtime 的改写、原子替换、截断及现有 Session switch。最终以同一提交的完整检查与受控部署结果为准；本报告不声明外部独立验收通过，也不声明所有偶发阻塞已消除。
