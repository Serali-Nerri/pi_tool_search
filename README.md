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

### 与其他工具集管理扩展共存

tool-search 通过调整 Pi 的 active 工具集合实现按需加载：工具保持注册，未加载时不激活，加载后重新激活。

如果其他扩展也通过 `setActiveTools()` 或 `systemPromptOptions.selectedTools` 修改工具集合，例如计划模式、工具开关或另一个按需加载器，双方的修改可能相互覆盖。**这属于运行时行为冲突，不一定产生启动错误或冲突提示。**

- **不自动协调工具集合控制权。** 其他扩展临时隐藏的工具，可能被 tool-search 按自身策略重新激活；反过来，其他扩展也可能隐藏已加载工具或提前激活 deferred 工具。
- **尊重 Pi 注册表级限制。** 原生 `--tools` / `--exclude-tools`，以及 SDK 的 `tools` / `excludeTools` 所排除的工具，不能由 tool-search 重新激活。仅从 active 列表移除工具不等同于这种限制。

上述限制针对工具集合管理，不代表普通工具扩展无法共存。工具自身的执行逻辑和执行前检查不会被 tool-search 替换或绕过。

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

**`mode: "auto"` 自动支持自定义提示词，无需额外兼容开关。** Pi 0.86 将 `customPrompt` 原文作为 `preamble`，工具元数据仍独立可用。本扩展按**结构化字段的归属**处理，不根据任意文本中的标签或标题猜测工具说明。

| 部分 | tool-search 的职责 |
|---|---|
| `customPrompt`、`appendSystemPrompt` | 原样保留，不扫描、解析、清理或改写其中的文字 |
| `contextFiles`、`skills`、`cwd`、其他命名 sections | 不接管，允许调用方正常更新 |
| `toolSnippets`、`toolGuidelines` | 按工具策略生成展示内容；常驻工具正常展示，deferred 指南随首次加载结果交付 |
| 通用 `promptGuidelines` | 保留；即使文字与 deferred/excluded 工具指南相同，也不按工具策略删除 |
| `selectedTools`、active 集合 | 按策略管理，遵守 Pi 注册表级白名单 |
| 显式 `sections.tools` / `sections.rules` | 保留作者段落，不覆盖；保守回退 eager |
| `forceSystemPrompt` | 尊重完整替换（包括空字符串），默认回退 eager，不偷偷追加或改写最终提示词 |

显式段落冲突按属性是否存在判断，即使值为空也不接管。工具提供者注册 `promptSnippet` / `promptGuidelines`，或像 pi-fff 一样覆盖 find/grep 实现，**不属于段落冲突**。本扩展每次在写入自己的 tools/rules sections **之前**检查；Pi 下一次 `before_agent_start` 会从基础选项重新构建输入，因此不会把本扩展上一轮生成的内容当作其他作者的覆盖。

`customPrompt` 或 append 文本里写了 `<tools>`、`<rules>`、`Available tools:`、`Guidelines:` 等内容，仍只是作者文本，**不会触发 eager**。这些文字即使包含旧工具说明或被排除工具的名字，也不会被擦除或获得执行权限；本扩展只保证自己的工具目录、元数据与实际工具集合遵循策略，不保证自由文本与当前工具集一致。

首条模型请求后，按需管理自定义前缀时 `/tool-search status` 会标明 `custom prefix`。`mode: "eager"` 和 `/tool-search off` 继续固定展示允许工具，不被自定义前缀改变。强制提示和显式段落覆盖的回退也只启用策略允许、已注册的工具，白名单与 excluded 仍生效。

**行为变化：** 旧版对所有 `customPrompt` 都回退 eager；现在仅因其存在或文本内容不会回退。需要固定工具集时，使用已有的 `mode: "eager"`。角色、append、项目上下文、自定义规则及其他命名 sections 不被冻结。

#### 子代理集成验证

这是通用提示词行为，不依赖 pi-subagents-lite。已通过 `pi-subagents-lite 1.14.0` 的 **replace + 显式 `tools` 白名单** 路径验证，无需修改该扩展或增加 tool-search 设置。也覆盖 `inherit` 路径：父提示文本原样保留，不因其中的工具标签回退；复制来的父工具说明不被清理或同步，仍由调用方负责其一致性。

子代理的 `extensions` 必须包含 `pi-tool-search` 和工具提供者；`tools` 白名单必须包含 `tool_search` **以及待加载工具名**。仅列出 loader 不会使白名单外工具可用。未启用这些扩展的 worker/reviewer 等代理不受影响。

后于本扩展运行的其他事件处理器仍可修改提示词、强制替换提示词或改写请求；这些修改不属于本扩展的稳定性保证。

### pi-subagents-lite 的工具限制说明

以下针对 Pi 0.86.1 与 pi-subagents-lite 1.14.0：

- **`tools` 白名单**：明确列出允许使用的工具。白名单外工具不会进入子会话注册表，tool-search 无法加载它们。
- **`exclude_tools` 黑名单**：用于从默认工具集合中排除少数工具，避免维护完整白名单。它与白名单是两种配置方式，并非必须同时使用。

当前 pi-subagents-lite 的 `exclude_tools` 仅在初始化后过滤一次 **active 工具集合**，没有将排除名单传给 Pi SDK 的 `excludeTools`。工具仍然注册，因此后续工具加载或 active 集合刷新可能重新激活它们。

这是 **pi-subagents-lite 的黑名单实现限制**，不是 tool-search 特有的问题。本扩展尊重 Pi 的注册表级限制，但不读取或补充其他扩展的黑名单约束。

**建议使用显式 `tools` 白名单；这种配置不受上述问题影响。** 如果需要可靠的黑名单语义，应在 pi-subagents-lite 创建子会话时，将解析后的排除名单传入 SDK `excludeTools`，而非仅修改一次 active 列表。

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
- 真实 pi-ai provider 序列化：默认提示与 custom prefix 下的 Responses、Codex、Anthropic、原生/普通 Chat Completions，及移除/重定义回退和审计兼容。
- 固定开发依赖 `pi-subagents-lite@1.14.0` 的真实 `runAgent` 路径：临时 frontmatter、扩展加载/过滤、SDK 白名单、首轮隐藏、加载后立即调用、重复加载与父子隔离；无配置时的默认 auto、显式 eager、继承文本保持及缺少 loader 的回退。
- 通用 custom prefix 的默认 auto、状态提示、任意前缀/append 原文保持、角色/上下文更新、工具实现覆盖与通用规则保留、精确强制提示/显式工具 sections 回退、reload/resume/tree/compaction。

SDK 和 subagents 测试使用临时 agent 目录、假凭据、fixture 工具与模拟模型响应；序列化测试在 `onPayload` 截获后终止，**不发送 HTTP、不调用真实模型、不验证服务端缓存命中**。这不是回环 HTTP 或远端端到端测试，也不验证真实 web 服务。开发依赖不随部署复制。

单独运行 subagents 集成测试：

```bash
node --import tsx --test test/subagents-lite.test.ts
```

也可指定已安装包目录和 SDK 的 `dist/index.js` 绝对路径，仍只在临时目录中运行，不改已安装文件或用户配置：

```bash
PI_TOOL_SEARCH_TEST_SUBAGENTS_DIR="$HOME/.pi/agent/npm/node_modules/pi-subagents-lite" \
PI_TOOL_SEARCH_TEST_SDK_ENTRY="$(npm root -g)/@earendil-works/pi-coding-agent/dist/index.js" \
node --import tsx --test test/subagents-lite.test.ts
```

该集成用例针对 1.14.0，其他版本显式报错，不静默跳过。

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
