# pi-tool-search

Pi 的按需工具加载扩展，支持主会话与子会话。保留稳定、有界的工具目录，通过精确名称加载完整工具定义；工具传输和增量历史由 Pi 原生处理。

**运行及验证基线：Pi 0.86.x（开发依赖锁定 0.86.0）、Node.js 22.19+。** 可以恢复旧版 tool-search 会话，但不再支持 Pi 0.85 运行时；版本不匹配时在注册工具前明确报错。无需修改其他已安装扩展。

## 工作方式

```json
{ "tool_names": ["web_search", "fetch_content"] }
```

- `tool_search` 按精确名称加载 1–5 个允许的 deferred 工具。目标已在当前工具列表中时直接调用，无需再次加载。
- manifest 保留完整的允许延迟加载目录，已加载工具不从目录删除。普通加载不重新 `registerTool()`，不改变 loader 的定义。
- manifest ≤8 KiB，单项短描述 ≤160 UTF-8 bytes，不包含完整参数 schema。描述清洗后按字节截断，不猜测缩写或版本号中的句号是否为句末。超过预算的条目标明省略数量，知道精确名称时仍可加载。
- 每个会话独立维护 loaded 状态；激活结果用提供者身份记录，替换同名工具的提供者不会继承原提供者的激活。
- 指南交付依据本扩展的首次授权加载状态，而不是 Pi 瞬时的 active 列表：即使同批其他工具注册时附带激活了目标，首次加载仍会返回指南；重复加载不重复返回。结果中的 `added` 表示首次授权加载或重新激活，provider 的工具差量仍由 Pi 独立计算。
- 延迟的是模型可见 schema，不是扩展模块初始化；fresh child 仍需初始化其显式扩展。
- 在全部 `session_start` 回调完成后的 `resources_discover` 阶段同步目录、恢复状态并应用策略。启动时动态注册的工具首条消息前即可进入 manifest；`/reload` 同样处理。
- `turn_end` 重申 active 子集，防止其他扩展注册工具时，Pi 的显式白名单刷新附带激活未请求的工具。

策略分为 `always`、`deferred`、`excluded`：

- `read`、`bash`、`edit`、`write`、`tool_search` 锁定为 `always`，JSON 和配置面板均不能改变。固定展示模式不暴露 loader。
- `grep`、`find`、`ls` 默认 `always`，但可以修改；`powershell` 默认 `excluded`，同样可以修改。
- 其他原本 active 的工具默认 `deferred`；原本 inactive 的工具默认 `excluded`。
- 子会话只处理其白名单内实际注册的工具，锁定策略不会凭空补齐缺少的工具。
- 工具选择不是操作系统权限沙箱，不对其他工具名作特殊处理。

## Pi 0.86：结构化提示词与工具历史

本扩展不再解析 `Available tools:` / `Guidelines:` 标记，也不返回整段 `{ systemPrompt }`。

`before_agent_start` 的 `systemPromptOptions.toolSnippets` 和 `toolGuidelines` 已包含未激活工具的元数据。扩展直接读取这些结构化输入（也保留此前处理器对单个工具指南的覆盖），通过 `sections.tools`、`sections.rules` 生成稳定的展示内容：

| 策略 | 工具定义 | 提示元数据 |
|---|---|---|
| `always` | 正常发送 | snippet 和指南正常展示 |
| `deferred`，未加载 | 仅 manifest 中的名字和短描述 | 不写入系统提示 |
| `deferred`，已加载 | Pi 在下一次模型请求中提供 schema | 首次加载结果中交付 snippet 与指南，总量 ≤8 KiB |
| `excluded` | 不加入当前可调用工具集 | 不出现在当前 manifest 和本扩展生成的提示元数据中 |

`selectedTools` 始终表示**实际可执行工具集**，不会为了隐藏说明而禁用已加载工具。展示集合单独计算，连激活 grep/find/ls 时的默认 shell 探索指南也保持稳定。常驻工具指南、自定义 `promptGuidelines`、其他命名 sections、项目文件、角色和安全上下文不被冻结。

Pi 将初始提示词和工具定义记录在 transcript 的首个 system 消息中，之后追加 `sections`、`toolsAdded`、`toolsRemoved` 差量。本扩展不再生成 activation-corrections，也不在每次模型请求中遍历、改写旧的 `addedToolNames`。

仍保留本扩展自己的策略、enabled 和来源身份：Pi 的工具声明不包含策略身份，不能代替这些信息。旧会话恢复时优先使用成功 loader 结果中的 `details.loadedKeys` / `active` / `added`，只在缺少结构化记录时读取旧 `addedToolNames`。旧 corrections 条目不再需要回放，不改写原始会话文件。

### 自定义提示词与子会话

如果本扩展运行时已经存在 `customPrompt`、`forceSystemPrompt`，或其他扩展显式提供了 `sections.tools` / `sections.rules`，则保守回退 **eager**：原始内容不被解析或改写，仍遵守排除策略与白名单。

**迁移注意：** 将父会话整段渲染后的提示词复制为子会话 `customPrompt`，也属于此回退范围，即使里面有旧标记或 XML 标签。要让子会话继续按需加载，应使用 Pi 默认结构化提示词，通过 append 或非 tools/rules 的命名 section 传递额外角色和任务要求，不复制父会话的工具说明。

后于本扩展运行的其他事件处理器仍可修改提示词、强制替换提示词或改写请求；这些修改不属于本扩展的稳定性保证。

### 压缩后的指南恢复

已加载工具不因 compaction 自动卸载。但首次加载结果可能被压缩掉，因此扩展在压缩边界有界补发当前已加载、策略仍允许工具的指南：

- 空闲时压缩：在下一条用户消息的 `before_agent_start` 中交付并持久化。
- 运行中压缩：注册一次性的 `context` 处理器，为立即下一次请求补充指南，再于安全的 turn 边界持久化。不扫描历史，不改变 schema，不触发额外模型轮次；即使 Pi 已经取走其他 steering 消息也不会延迟交付。首次投影和持久化后的消息位置不同，此压缩恢复边界不保证完整消息前缀的字节稳定。
- resume/tree 恢复：只在恢复时检查压缩后的上下文，按 compaction ID 避免重复补发；中断在压缩后、补发前的会话也可恢复。

指南消息为隐藏的 `pi-tool-search.guidance` 自定义消息；只含工具说明，不含项目提示词或凭据。

## 模型、缓存与审计

配置只有 `"mode": "auto"` 或 `"mode": "eager"`。`native` / `portable` 是状态中的**预期传输能力**，不是额外配置值，更不是服务端缓存命中的证明。

`auto` 对所有模型按需加载，Pi 自行选择协议。native 状态要求当前 resolved model 明确声明 `supportsMidConvoSystemMessages: true`，以及对应能力：

| API | 工具能力 |
|---|---|
| OpenAI / Codex / Azure Responses | `supportsAdditionalTools` 或 `supportsToolSearch` |
| Anthropic Messages | `supportsMidConvoToolChanges` |
| Chat Completions | `supportsMidConvoToolAdditions` |

其他情况标为 portable。不猜模型名，不修改模型 compat 标记；旧 `supportsToolReferences` 不再作为判断依据。

- Responses 原生路径将新增定义放在 `input` 增量项中；普通路径扩大顶层工具列表。
- Anthropic 原生路径保留初始工具前缀、追加 deferred 声明，通过中途 system 消息执行工具增删，并非整个顶层 tools 永远不变。
- 工具移除、同名 schema 重定义等可能迫使 Pi 使用完整当前工具列表；能力声明不保证每种历史都能原生表达。
- 显式 eager 从首轮携带全部允许定义，不展示 loader。
- 在目录、策略和其他提示内容不变时，普通激活保持 manifest 与工具提示 sections 稳定。修改策略/目录、换模型、模式切换、压缩和分支导航都是允许改变缓存前缀的边界。

排除/卸载是当前工具选择策略，不是擦除历史：已经发送过的定义、manifest 和指南可能仍在会话历史中。尤其 Anthropic 原生移除可保留旧顶层声明，再用 `tool_removal` 撤销当前可用性；本扩展不为隐藏历史内容而重写 transcript。

实际收益应检查正常响应的 `usage.cacheRead`，不能仅凭请求结构断言命中。

### 内置缓存保活

Pi 0.86 已内置成本感知的 `cacheWarming`，默认 `streaming`，可选 `off` / `idle`。是否保活取决于模型缓存寿命声明和成本估计，保活请求会计费。通过 Pi 的配置和 `/session` 查看即可；本扩展不添加定时器、额外保活请求或默认设置覆盖。

### 请求审计

审计默认关闭；开启后仅输出计数与 hash，不输出提示原文、工具结果或凭据。支持 Responses/Codex、Anthropic Messages、Chat Completions：

- 分别检查初始系统前缀、已有 system 补丁及已有内联工具定义和位置；合法尾部追加不视为修改历史。
- Codex 的 `instructions` 和 `input` 中的 system/developer 补丁都会检查。
- Anthropic 合法追加 deferred 声明单独标明；历史 system 补丁中的块级 `cache_control` 移动不误报为提示内容变化，文本和工具声明仍参与检查。
- portable 首次加载出现 `top-level tools changed` 是预期行为；重复加载应再次稳定。
- 不支持的格式显示 `unsupported payload` 并清除旧比较基线，不沿用陈旧成功状态。
- reload、换模型、分支导航和 compaction 重置审计基线。

审计关闭时不读取 payload；开启时的哈希计算有 CPU 成本。该钩子之后的扩展仍可能修改请求。Pi 自身的缓存保活与本扩展的被动审计是不同功能。

## 全局与项目策略

全局文件：`~/.pi/agent/pi-tool-search.json`；设置 `PI_CODING_AGENT_DIR` 时使用其指定的 agent 目录。

```json
{
  "version": 1,
  "mode": "auto",
  "audit": false,
  "tools": [
    { "name": "web_search", "source": "npm:pi-web-access", "policy": "deferred" },
    { "name": "fetch_content", "source": "npm:pi-web-access", "policy": "deferred" },
    { "name": "document_parse", "source": "npm:pi-docparser", "policy": "deferred" }
  ]
}
```

优先级：受信任项目的 `<ctx.cwd>/.pi/pi-tool-search.json` > 全局配置 > 默认策略；五个锁定工具最后强制生效。未受信任项目不读取项目策略。child cwd/worktree 使用自己的项目目录，不使用工厂的进程 cwd。

npm 来源与显式路径加载会规范化到同一提供者身份；相对路径以会话 cwd 为准，已有符号链接解析为真实路径。配置不会使缺少提供者或未在白名单中的工具凭空可用。

SDK inline 工厂按完整工厂路径区分身份，例如 `<inline:provider-A>` 保存为 `inline:<inline:provider-A>`，不再共用 `inline`。SDK 调用方应使用唯一、稳定的具名工厂；未命名工厂的自动编号不能保证重排后的身份稳定。旧通用 `inline` 加载记录因缺少来源信息而不自动恢复，也不退回按工具名恢复；重新调用 loader 后会记录新身份。旧 `source: "inline"` 的 `always/deferred` 策略不自动分配给某个工厂，需重新配置；`excluded` 则保留约束，直到同层或更高层的明确工厂策略覆盖，或手动移除旧记录。迁移不会自动改写会话或配置文件。

文件限制 64 KiB。保存只合并实际修改的行，保留未注册提供者、其他未编辑记录及目标文件的 `mode`、`audit` 和其他字段；无修改退出不写文件。损坏、不可读、版本不支持、无效记录或符号链接配置均拒绝覆盖。同目录 `.lock` 避免并发保存丢失修改；确认没有写入者后才可手动移除异常退出遗留的锁。

## 命令

```text
/tool-search status
/tool-search config
/tool-search config project
/tool-search on
/tool-search off
/tool-search audit on
/tool-search audit status
/tool-search audit off
```

- `config` 默认写全局；`config project` 仅允许写受信任项目。面板显示生效策略，但不会将未编辑的项目覆盖值复制到全局。
- 项目策略仍优先于全局修改。如果生效策略没变，已加载工具保持可用。
- `on` 清空 loaded，重新应用配置模式；显式 eager 不会因此变为 auto。
- `off` 固定展示允许工具、隐藏 loader，excluded 仍不启用。
- 非空闲时拒绝修改模式和策略；保存前再次检查空闲状态及项目信任。
- 审计也可通过 `PI_TOOL_SEARCH_AUDIT=1` 或配置 `audit: true` 开启，配置在 reload/新会话读取。

## 开发、验证与部署

```bash
npm install --ignore-scripts
npm run verify
```

测试包括类型检查、策略和身份安全、配置持久化、窄宽度渲染，以及：

- 真实 Pi SDK 的首条 `session.prompt()`、加载后立即使用、重复加载、启动/运行中注册、显式子会话白名单。
- reload、resume、tree 分支恢复、模型切换、手动/运行中 compaction、已排队 steering 下的即时指南恢复。
- inline 工厂身份隔离及旧记录保守迁移；同批注册与首次加载时的指南交付；目录变更后的新 snippet 与结构化指南覆盖（包括显式空数组）。
- 真实 pi-ai provider 序列化：Responses、Codex、Anthropic、原生/普通 Chat Completions，及移除/重定义回退和审计兼容。

SDK 测试使用临时 agent 目录与模拟模型响应；序列化测试在 `onPayload` 截获后终止，**不发送 HTTP、不调用真实模型、不验证服务端缓存命中**。这不是回环 HTTP 或远端端到端测试。开发依赖不随部署复制。

部署前先确保目标 Pi 为 **0.86.x**；仓库测试依赖升级不会升级全局 Pi。本仓库不会替你升级全局包。

```bash
npm run deploy
```

部署先验证，再暂存 `src/` 并通过 rename 切换到 `~/.pi/agent/extensions/pi-tool-search/`；失败尝试恢复旧版本。每次旧版本保留在 `~/.pi/agent/extension-backups/pi-tool-search-<时间>-<UUID>/`，不覆盖已有备份。支持 `--agent-dir PATH`。

部署或修改配置后重启 Pi 或执行 `/reload`。回滚时先停用相关会话，用备份恢复扩展目录和相匹配的 Pi 版本；手动恢复配置时不要覆盖后续新变更。

## 项目结构

```text
src/lifecycle.ts       生命周期、模式、策略执行、指南恢复
src/registry.ts        工具策略、提供者身份、目录变更检测
src/config.ts          全局/项目策略读写与校验
src/capabilities.ts    resolved-model 传输能力判断
src/prompt.ts          结构化 tools/rules sections
src/history.ts         来源绑定状态、旧会话读取及压缩恢复判断
src/audit.ts           默认关闭的多协议请求结构审计
src/tool.ts            精确名称 loader、有界指南和紧凑渲染
src/manifest.ts        manifest 与短描述预算
src/ui.ts              策略配置面板
test/                 单元、真实 SDK 与序列化回归
scripts/              部署脚本
```

上游参考：[0.86.0 发布说明](https://github.com/earendil-works/pi/releases/tag/v0.86.0) · [transcript 协议变更 #9548](https://github.com/earendil-works/pi/pull/9548) · [结构化提示词 API](https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/docs/extensions.md#before_agent_start)
