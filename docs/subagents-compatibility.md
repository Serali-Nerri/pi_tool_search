# nicobailon/pi-subagents 联合验证

验证日期：2026-09-05。Pi 0.85.0、nicobailon `pi-subagents` 0.65.1、FFF 0.10.6、pi-web-access 0.28.0、pi-docparser 4.0.0。

## 结论

本项目可用于 nicobailon 的主/子代理工作流，不需要修改已安装的 pi-subagents、FFF 或 Pi 核心源码。使用 [README 中的配置](../README.md#nicobailonpi-subagents-配置) 和 [完整六角色示例](subagents-settings.example.json)。`auto` 使用原生或通用路径按需加载；显式 `eager` 固定展示允许工具。

## 验证依据

`npm run verify` 通过严格 TypeScript 检查及 57 项单元/集成测试。包括：稳定 manifest、白名单刷新、七工具/控制工具策略、bg_wait 默认延迟与角色固定、通用加载和模型切换、显式 eager、源身份、元数据变更、受信任项目优先级、child cwd、恢复、提供者替换、缺少提供者时的目录过滤、碰撞、审计默认关闭、有界渲染，以及配置合并/备份和部署失败保护。

`npm run test:subagents` 运行真实安装包的 `createDefaultChildSessionFactory()`、`createChildHooks()` 和 Pi agent loop。使用回环 HTTP 服务接收最终序列化请求，返回确定性的 Responses / Chat Completions SSE；支持 Codex zstd 请求体。mock 会检查被调用工具实际 active 且存在于请求定义中。源代码没有被测试内的替代实现或提示稳定化补丁替换。

当前矩阵：44 个场景、236 次 mock 请求、695 项结果断言，另验证六角色的 12 个前台/后台启动计划、8 个扩展加载策略计划及 2 个角色常驻入口计划，并检查所有发现的角色均不选择 Freeflow/Autocompact。

| 范围 | 检查 |
|---|---|
| 原生协议 | `additional_tools` 与 `tool_search_output` 两条路径，以及 `openai-codex-responses` |
| 通用协议 | 无原生能力声明的 Responses 和 Chat Completions：仅首轮常驻工具；激活后普通 tools 与 active 集合一致；无原生内联定义；重复加载不改变工具列表 |
| 加载和继续 | 仅请求 A 时 B 隐藏；重复请求 A 不改变 manifest；跨用户提示、关闭后重新打开会话的工具定义稳定 |
| 提示元数据 | deferred 指南首次请求就带加载条件；FFF 指南保留；普通加载不改变系统提示 |
| FFF | 仅全局 override 的 fresh child；执行真实 grep/find；旧 grep/find/ls excluded 策略迁移 |
| 范围和隔离 | 缺 loader、缺目标、只读子集、supervisor 常驻、不同 cwd、六个并发 child 的 native/portable loaded 状态和角色 pin 相互独立 |
| 动态目录 | 其他扩展运行期注册新工具后重申子集；历史内联定义不夹带未批准工具；目录改变允许顶层 manifest 改变 |
| 六角色最终配置 | 加载实际 FFF/Web 扩展；所有角色按需暴露 web_search，其余 Web 工具保持隐藏；GPT 使用原生路径，Kimi 配置使用通用路径 |
| RTK | 有 bash 的四角色加载实际 RTK 扩展和 `rtk rewrite`，验证 `git status --short` 被改写；末端 bash 使用测试桩，不执行实际 shell 命令 |
| Docparser | delegate/reviewer/researcher 实际解析本地单页 PDF（OCR 关闭）；两种延迟模式都只激活请求的 document_parse；未加载的角色不会因全局策略出现文档工具，未知请求被拒绝 |
| bg_wait | 真实 child runtime 注册的工具默认延迟、加载后可调用；可选 profile 从首轮常驻且不影响其他 child；白名单未允许时 profile 不能授予该工具 |
| 扩展默认策略 | 前台/后台的省略、空列表、显式列表；实际配置解析器应用 `defaultExtensions: []`，显式角色配置保留优先级 |
| 固定展示 | 显式 eager 在原生和通用端点都展示全部允许工具；custom/replace 提示安全回退为 eager，提示内容不被猜测性重写 |

每轮报告包含安装版本、全部扩展源文件 hash、配置启动计划、逐请求检查与失败信息。输出目录由脚本打印，位于 `/tmp/pi-subagents-tool-search-*/`；临时目录不是长期结果存档。可用 `PROBE_TOOL_SEARCH_ENTRY` 指向全局部署再跑相同断言。

## Pi 生命周期的关键约束

Pi 0.85 的 `_refreshToolRegistry()` 在显式 `allowedToolNames` 下会重新激活所有白名单内已注册工具。nicobailon 的 child factory 本身没有每轮全量激活工具的 listener。

原生和通用路径共用同一套激活、会话恢复和白名单逻辑，均在加载后的下一次模型请求中提供新定义。两者的区别由 Pi 的提供者适配器序列化请求时产生；状态中的 `native` / `portable` 是基于能力声明的说明，协议验证以回环服务收到的实际请求为准。

因此本扩展采用：

1. 完整、稳定的 loader manifest；普通激活只调用 `setActiveTools`，不重新注册 loader。
2. `turn_end` 时重申 active 子集；该时间点早于 Pi 对下一轮工具列表的快照。
3. `context` 阶段按真实加载结果校正 `addedToolNames`，保持原消息不可变。非 loader 附带激活的修正结果用自定义会话记录保留，不依据未来策略重新猜测历史决定。
4. `before_agent_start` 只规范化已识别的工具元数据块，解决后续用户提示重新组装时出现的 metadata 漂移。

`tools` 白名单仍约束所有激活；提供者 `extensions` 则决定目标是否实际注册。这两个配置各司其职，缺一不可。没有通过全局 `tools: "inherit"` 放开子代理范围。

## 测试没有证明什么

- 没有使用真实模型、付费 API、用户凭据或外网搜索；实际 Web 扩展仅注册/暴露 schema，没有执行搜索服务请求。
- 确定性模型响应不能衡量 LLM 自主发现工具的准确率。mock 的缓存用量固定为 0，不用于估算收益。
- Anthropic/Google 等其他 API 的生命周期选择有单元覆盖；本次请求级联测覆盖 Responses 和 Chat Completions，没有验证它们的真实服务端或 Anthropic 的原生 wire 格式。
- 通用路径激活时允许顶层工具列表变化；系统指南稳定不等于缓存仍然命中。原生路径的前缀稳定断言不套用于通用加载的新增定义。
- 后台 runner 的启动计划和前后台共用 child-session 路径已检查；未端到端验证独立 runner 进程回收、工作流 UI 或任意第三方扩展组合。
- 压缩、fork、变更角色/模型、schema 或指南更新等会改变历史/前缀；不承诺跨这些边界缓存不变。
- 请求级审计默认关闭，不增加模型请求或子代理数量。开启时计算结构 hash；真实服务端命中仍需观察正常响应 usage。

上游参考：[Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[nicobailon agent 配置](https://github.com/nicobailon/pi-subagents/blob/34997e2f9b7149cfb5c6897d3093707d4f942196/docs/agents.md#tool-and-extension-selection)、[OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search#advanced-usage)。版本相关结论以本次本地源码和请求实测为准。
