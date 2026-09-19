# pi-tool-search

Pi 的按需工具加载扩展，支持主会话和子会话。保留稳定的工具目录和提示指南，使用 Pi 的原生增量协议或通用 active-tools 回退按需提供完整工具定义。

验证基线：Pi **0.85.1**、`@ff-labs/pi-fff` **0.10.6**、`pi-web-access` **0.29.0**。不需要修改这些已安装包的源码。

## 工作方式

- `tool_search` 按精确名称加载 1–5 个允许的 deferred 工具；目标已经在当前工具列表中时直接调用，无需再次搜索。
- manifest 保留完整的允许延迟加载目录，已加载工具不从目录删除。普通加载不重新 `registerTool()`，不会因重新注册 loader 而触发 Pi 的白名单全量激活。
- manifest 最多 8 KiB；单项短描述最多 160 UTF-8 bytes，不包含完整 JSON Schema。超过预算的条目会标明省略数量，知道精确名称时仍可加载。
- FFF 等默认 `always` 的工具（如 grep/find）的 `promptGuidelines` 保留。deferred 工具的 snippet 与 guidelines 都不进入系统提示：激活时随 `tool_search` 的结果文本返回（预算 8 KiB），因此系统提示在激活前后保持字节不变；归属与迁移细节见下文《工具元数据的归属与迁移》。
- 只规范化可识别的 Pi 默认 `Available tools` 和 `Guidelines` 块；角色、项目、安全指令及其他上下文正常更新，不冻结整个系统提示。
- 在全部 `session_start` 回调结束后的 `resources_discover` 阶段同步工具目录、恢复已加载状态并应用策略。像 `@mjakl/pi-processes` 这样在启动回调里注册的工具，首条消息前就按策略进入 manifest，未激活时隐藏完整定义；`/reload` 采用相同处理。
- 在 `turn_end` 重申 active 子集，并校正附带激活的历史记录，避免其他扩展注册工具时把未请求工具泄漏到后续请求。
- 每个会话独立维护 loaded 状态。恢复时优先使用成功加载结果中的提供者身份，兼容旧会话记录；策略读写使用 `ctx.cwd`，适配 child cwd 和 worktree。

调用示例：

```json
{ "tool_names": ["web_search", "fetch_content"] }
```

策略分为 `always`、`deferred`、`excluded`：

- `read`、`bash`、`edit`、`write` 与 `tool_search` 锁定为 `always`：不可在配置面板或 JSON 中更改，旧配置中它们的 `excluded/deferred` 值不生效。这是本扩展唯一的不可更改项。固定展示模式不暴露 loader。
- `grep`、`find`、`ls` 默认 `always`，但可自行改为 `deferred` 或 `excluded`。
- `powershell` 默认 `excluded`，可自行调整。
- 其他原本 active 的工具默认 `deferred`，需要时通过 `tool_search` 激活；原本 inactive 的工具默认 `excluded`，都可通过策略调整。
- 子代理只处理它的白名单内、实际已注册工具：锁定工具不会给缺少它们的会话补上，也不会加载未列入白名单的目标。
- 除五个锁定工具外，本扩展不对任何工具名做特殊处理：是否可用只看注册、白名单与策略。工具选择不是操作系统权限沙箱。

迁移说明：按角色固定的 `src/profiles/bg-wait-always.ts` 入口与 `registerToolSearch(pi, cwd, entryPath, { alwaysTools })` 参数已移除（`ToolCatalog.refresh` 的 `alwaysTools` 参数同样取消）。需要常驻某个 deferred 工具时，在全局 `~/.pi/agent/pi-tool-search.json` 或受信任项目的 `.pi/pi-tool-search.json` 里将其设为 `always`（或用 `/tool-search config` 修改）；旧配置中指向该 profile 的 `extensions` 条目请换回默认入口 `.../pi-tool-search/index.ts`。

## 工具元数据的归属与迁移

模型能看到工具元数据的四条途径，以及本扩展在 `mode: "auto"` 下的控制方式：

| 途径 | 内容 | 位置 | 时机 |
|---|---|---|---|
| manifest | 每个 deferred 工具的 `名字 — 短描述`（单项 ≤160 B，总量 ≤8 KiB） | `tool_search` 的 description | 每轮请求 |
| 参数 schema | 该工具的 `description` + `parameters` | provider `tools` 数组；`native` 路径下激活后为 `input` 里的内联定义 | 仅在该工具 active 时 |
| 系统提示块 | `Available tools:` 的一行（来源 `promptSnippet`）与 `Guidelines:` 条目（来源 `promptGuidelines`） | 系统提示词 | 每轮请求，只列出策略允许且确有 snippet 的工具 |
| 执行结果 | 本次激活工具的 snippet + 全部 `promptGuidelines`（总量 ≤8 KiB，去重、空白折叠） | `tool_search` 的返回文本 | 仅在调用 `tool_search` 之后 |

按策略的三条结果：

- `always`：schema 与两块元数据照常进入请求。本扩展只重建这两个块的内容，不冻结角色/安全/项目文本；没有 `promptSnippet` 的常驻工具不会出现在 `Available tools:`，但 schema 照常发送。
- `deferred`：从 active 集合移除，schema 不进请求、只留 manifest；snippet 与 guidelines 也不写回系统提示。激活时才随 `tool_search` 结果交付。
- `excluded`：schema、manifest、提示词三处都不出现。

因此激活不会改写系统提示词：真实会话实测 `4393 → 4393` bytes（`process` 场景 `4390 → 4390`），`Available tools:` 与 `Guidelines:` 两块在激活前后完全一致。

**snippet 的来源。** Pi 只为 active 工具渲染 snippet，`getAllTools()` 返回的 `ToolInfo` 不含 `promptSnippet`，`ExtensionAPI` 也没有 `getToolDefinition()`。本扩展在工具被延迟之前捕获：

- `session_start`、`resources_discover`、`session_tree`：解析 `ctx.getSystemPrompt()` 的 `Available tools:` 块（发生在 `applyMode()` 之前，此时全部工具仍是 active）；
- `before_agent_start`：从 `event.systemPromptOptions.toolSnippets` 刷新，覆盖常驻工具与已激活工具；
- 结果文本的标题行优先使用捕获值（清洗 + 160 B 截断），缺失或空白时回退到受限 short description；捕获结果按工具名保存在会话级 map，`session_shutdown` 清空。

生命周期钩子一览：

| 钩子 | 作用 |
|---|---|
| `session_start` / `resources_discover` / `session_tree` | 同步目录、恢复 loaded、捕获 snippet、应用策略 |
| `before_agent_start` | 刷新 snippet；只规范化可识别的 Pi 元数据块（无该块时安全回退 eager） |
| `turn_end` | 重申 active 子集、校正附带激活的历史记录 |
| `context` | 按真实加载结果校正历史消息引用 |
| `before_provider_request` | 可选请求审计 |

不受控制或需要留意的边界：

- 判定标准只有那四个标记块（`Available tools:`、`In addition to the tools above,`、`Guidelines:`、`Pi documentation (`），不区分 `customPrompt`。子代理会话（如 `pi-subagents-lite` 的 inherit 模式）用父会话提示词覆盖系统提示，同时继承了整段 Pi 提示词，那两个块描述的是父会话的工具；本扩展同样会按子会话自己的目录与策略重建它们，否则子会话会把父会话的工具当成自己的。子会话自己重建过的块同样满足该判定。
- 重建只认识有归属的行：父会话遗留且在本会话没有对应工具的 `Guidelines:` 条目不会被删除（`pi-subagents-lite` 重建后会消失，因为整块被替换）。

- 固定展示（`/tool-search off` 或 `mode: "eager"`）不做迁移：允许工具的 snippet 与 guidelines 照常出现在系统提示，`tool_search` 本身不展示；这是"显式固定"的语义。
- 三个已知块之外的自由文本不在本扩展控制内。例如 `@mjakl/pi-processes` 早期版本在 `before_agent_start` 里追加的 `Background processes:` 段既不会被删除、也不属于本扩展的稳定性保证（本机已改用删除该钩子的本地 fork，不再出现该段）。
- schema 内容不改写：不修改其他扩展的 `description` / `parameters`，只控制"何时发送、是否发送"。
- 启动窗口之后才注册、且在首次捕获前就被延迟的工具，标题回退到 short description；`promptGuidelines` 不受影响（`ToolInfo` 一直提供）。
- `ToolInfo` 不含 `promptSnippet` 是 Pi 当前接口限制；若上游补上，捕获逻辑可以退化为直接读取。

## 模型和缓存边界

默认 `mode: "auto"` 对所有模型按需激活工具，具体传输由 Pi 根据当前 **resolved model** 处理，不猜模型名称。两种延迟路径都只增添请求的工具，并在当前会话中保持已加载状态，不会每轮重新加载或自动卸载。

`native` 和 `portable` 复用同一套 loader：模型调用 `tool_search`，扩展通过 `pi.setActiveTools()` 增添工具，Pi 在**下一次模型请求**中提供新定义。两条路径的激活时机和调用方式相同，差异在 Pi 的请求序列化方式及缓存特性。

| 有效行为 | 初始工具定义 | 激活后的请求 | 缓存边界 |
|---|---|---|---|
| `auto` → `native` | 常驻工具和 loader | 原生协议引入新定义 | 可维持工具前缀稳定 |
| `auto` → `portable` | 常驻工具和 loader | 普通 `tools` 列表增添完整定义 | 激活时列表变化，可能影响前缀缓存 |
| 显式 `eager` | 全部允许且未排除的工具，不展示 loader | 固定允许工具集 | 从首轮携带全部定义 |

表中的原生请求结构以已联测的 OpenAI Responses 路径为例：新定义放在 `input` 的原生加载结构中，初始顶层 `tools` 可保持不变；通用路径则扩大普通 `tools` 列表。其他提供者采用各自的原生表示。

`native` / `portable` 是 `/tool-search status` 根据模型能力声明标识的预期传输路径，不是额外 JSON 配置值，也不是请求抓包结果；配置仍为 `"mode": "auto"` 或 `"mode": "eager"`。原生能力声明包括 OpenAI Responses 的 `compat.supportsAdditionalTools` / `compat.supportsToolSearch`，以及 `anthropic-messages` 的 `compat.supportsToolReferences`。无声明时状态标为 `portable`。这些标记只用于状态说明，最终协议选择由 Pi 的提供者适配器完成；本扩展不修改模型兼容标记或请求协议。

自定义/无法识别的系统提示模板使用 **eager** 安全回退，原提示保持不变；需要延迟元数据时使用 Pi 默认提示并追加角色指令（`systemPromptMode: "append"`）。

本机模型配置对应关系（保留原 model/thinking）：

| 角色 | 现有模型 | 默认行为 |
|---|---|---|
| scout、delegate | `openai-codex/gpt-5.6-luna` | 原生延迟加载 |
| oracle | `openai-codex/gpt-6-astra` | 原生延迟加载 |
| worker、reviewer、researcher | `ark2/kimi-k3` | 通用延迟加载 |

GPT 的能力取自本机动态模型目录。当前 `ark2/kimi-k3` 没有声明增量工具能力，仍可通过普通工具列表按需加载。角色切换模型时保留当前会话已加载的工具，不会因为变成通用路径就启用所有 deferred 工具；换模型本身不属于缓存稳定性保证。

在工具目录、策略、模型和其他提示内容不变时，两种延迟路径都保持 manifest 稳定，系统提示在激活前后字节不变（deferred 指南随 `tool_search` 结果交付，不写回提示词）。原生路径还以保持顶层 tools 及既有内联工具定义的位置和内容稳定为目标；通用路径允许顶层 tools 在首次激活时扩大，重复加载同一工具不会重复增加定义。实际注册/删除工具、schema 或指南更新、修改策略、换模型、切换模式、压缩历史等都是允许改变缓存前缀的边界。其他扩展直接改写系统提示或请求的行为也不在本扩展的稳定性保证内。

请求结构稳定只是缓存的客户端条件，**不保证服务端真实命中**。真实收益应检查正常模型响应的缓存用量，例如 Pi 的 `usage.cacheRead`。

## 子代理会话

子代理框架的白名单与扩展加载决定 child 能看到什么；本扩展只处理已注册且在白名单内的工具：

- 每个会话独立维护 loaded 状态。恢复已有会话时从成功加载记录恢复；策略读写使用 `ctx.cwd`，适配 child cwd 和 worktree。
- 不会给缺少某工具的会话补上它，也不会加载未列入白名单的目标：`tool_search` 只能加载已注册的 deferred 工具。
- 需要常驻某个 deferred 工具时，在全局 `~/.pi/agent/pi-tool-search.json` 或受信任项目的 `.pi/pi-tool-search.json` 里显式设为 `always`。

## FFF 全局配置

文件：`~/.pi/agent/pi-fff.json`，本机为 `/home/thelya/.pi/agent/pi-fff.json`。设置：

```json
{ "mode": "override" }
```

这让 fresh child 从全局配置获得 override，不依赖主会话先执行 `/fff-mode override`。FFF 提供的 grep/find 沿用默认 `always` 策略（可在配置面板或 JSON 中更改）和完整指南。

`multi_grep` 保持默认关闭，角色白名单也不包含它；不要额外设置 `PI_FFF_MULTIGREP=1`。启动 flag、`PI_FFF_MODE` 等更高优先级来源仍可能覆盖全局文件，排查时应同时检查。

## tool-search 全局与项目策略

全局文件：`~/.pi/agent/pi-tool-search.json`，本机为 `/home/thelya/.pi/agent/pi-tool-search.json`：

```json
{
  "version": 1,
  "mode": "auto",
  "audit": false,
  "tools": [
    { "name": "web_search", "source": "npm:pi-web-access", "policy": "deferred" },
    { "name": "fetch_content", "source": "npm:pi-web-access", "policy": "deferred" },
    { "name": "get_search_content", "source": "npm:pi-web-access", "policy": "deferred" },
    { "name": "document_parse", "source": "npm:pi-docparser", "policy": "deferred" },
    { "name": "document_search", "source": "npm:pi-docparser", "policy": "deferred" },
    { "name": "document_screenshot", "source": "npm:pi-docparser", "policy": "deferred" }
  ]
}
```

优先级为：受信任项目的 `<ctx.cwd>/.pi/pi-tool-search.json` > 全局配置 > 默认策略；五个锁定工具（read、bash、edit、write、tool_search）的规则最后生效。未受信任项目不读取项目策略。设置 `PI_CODING_AGENT_DIR` 的 Pi 使用其指定 agent 目录。

主会话中的 npm 来源和 child 显式路径产生的 `source: "cli"` 会规范化到同一 npm 提供者身份；新的策略保存规范化身份，旧 source 标签仍可读取。全局策略不能使缺少提供者扩展、或不在 child 白名单内的工具凭空可用。

项目文件缺失时兼容 `.pi/claude-style-tools.json`；保存写入新文件。配置文件限制 64 KiB。`/tool-search config` 只保存当前受信任项目，不修改全局 settings。

## 命令与请求审计

```text
/tool-search status
/tool-search config
/tool-search on
/tool-search off
/tool-search audit on
/tool-search audit status
/tool-search audit off
```

`on` 重新启用配置的加载策略并清空当前 loaded 集合；`auto` 下显示 `native` 或 `portable`，显式 `eager` 仍保持固定展示。`off` 固定恢复允许的 deferred 工具、隐藏 loader，`excluded` 工具仍不启用。非空闲时拒绝修改工具策略。

审计默认关闭。开启后，在 `before_provider_request` 检查顶层工具、系统内容、既有内联工具定义及其位置，向 stderr 输出序号和 hash，不输出提示原文、工具结果或凭据；`audit status` 显示本会话最新结果。也可设置 `PI_TOOL_SEARCH_AUDIT=1` 或配置中的 `audit: true`，后者在 reload/新会话读取。

通用延迟首次激活工具时，审计出现 `top-level tools changed` 是预期行为；随后没有新激活时应再次稳定。激活**不应**再触发 `system metadata changed`（deferred 指南已迁移到工具结果，系统提示保持字节不变）；若看到该提示，说明有其他扩展改写了系统提示。系统指南稳定不能抵消普通工具列表变化的缓存影响。当前审计 payload 解析面向 Responses 请求；不支持的格式会显示 `unsupported payload`。

审计不发送额外模型请求、不启动子代理、不重复加载扩展。开启时会扫描请求的相关部分并计算 hash；关闭时不读取请求 payload。正常运行仍需要工具目录检查和历史消息引用遍历，不应理解为零 CPU 成本。每个 fresh child 本来就要初始化其显式扩展，tool-search 延迟的是**模型可见 schema**，不是扩展模块或 FFF 索引的初始化。

该钩子之后的其他扩展仍可能修改请求。严格回归测试以下述回环 HTTP 服务收到的最终请求体为准，不能只凭运行时 active 列表判断缓存条件。

## 开发、测试与部署

Node.js 22.19+（本机验证为 24.12.0）：

```bash
npm install
npm run verify
```

- `verify`：严格 TypeScript 检查及 78 项单元/集成测试，包含真实 Pi SDK 的启动顺序、reload 和启动后注册工具的状态恢复、snippet 捕获与指南迁移的预算/回退断言、锁定集合与命名默认值、配置面板排序与保存。
- 开发依赖包含 `@earendil-works/pi-server@0.85.0`，用于 Pi 0.85 顶层 SDK 导出的直接 Node 导入；不会部署它或修改全局 npm 包。

部署：

```bash
npm run deploy
```

`deploy` 先验证，再将 `src/` 部署到 `~/.pi/agent/extensions/pi-tool-search/`。先暂存完整新版本，用 rename 切换；失败尝试恢复旧版本。每次旧版本保留在 `~/.pi/agent/extension-backups/pi-tool-search-<时间>-<UUID>/`，不覆盖既有备份。接受 `--agent-dir PATH` 指定 agent 目录。

策略直接编辑 JSON：全局 `~/.pi/agent/pi-tool-search.json`（`version`/`mode`/`audit`/`tools`），受信任项目用 `.pi/pi-tool-search.json` 覆盖。部署或改配置后**重启 Pi 或执行 `/reload`**；已运行中的会话不会被原地改配置。

回滚时先停用相关会话：用备份的目录恢复原 tool-search，手动恢复改过的 JSON；不要覆盖后来新增的配置变更。

## 项目结构

```text
src/lifecycle.ts       生命周期、模式、会话恢复和 active 子集
src/registry.ts        工具策略、提供者身份、目录变更检测
src/config.ts          全局/项目策略和旧格式兼容
src/capabilities.ts    模型增量工具能力判断
src/prompt.ts          有界且稳定的工具提示元数据
src/history.ts         激活记录校正与恢复
src/audit.ts           默认关闭的请求结构审计
src/tool.ts            精确名称 loader 和紧凑渲染
src/manifest.ts        manifest 与短描述预算
src/ui.ts              项目策略配置面板
test/                  单元、集成、配置及部署测试
scripts/               部署脚本
```
