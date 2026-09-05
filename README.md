# pi-tool-search

Pi 的按需工具加载扩展，支持主会话和 `nicobailon/pi-subagents` 的独立子会话。保留稳定的工具目录和提示指南，按需向支持原生增量工具协议的模型提供完整工具定义。

验证基线：Pi **0.85.0**、`pi-subagents` **0.65.1**、`@ff-labs/pi-fff` **0.10.6**、`pi-web-access` **0.28.0**。不需要修改这些已安装包的源码。

## 工作方式

- `tool_search` 按精确名称加载 1–5 个允许的 deferred 工具。
- manifest 保留完整的允许延迟加载目录，已加载工具不从目录删除。普通加载不重新 `registerTool()`，不会因重新注册 loader 而触发 Pi 的白名单全量激活。
- manifest 最多 8 KiB；单项短描述最多 160 UTF-8 bytes，不包含完整 JSON Schema。超过预算的条目会标明省略数量，知道精确名称时仍可加载。
- FFF 等常驻工具的 `promptGuidelines` 保留。deferred 工具的指南预先以 `After loading <name> with tool_search: …` 注入，总预算 8 KiB；预算外的指南不额外注入。
- 只规范化可识别的 Pi 默认 `Available tools` 和 `Guidelines` 块；角色、项目、安全指令及其他上下文正常更新，不冻结整个系统提示。
- 在 `turn_end` 重申 active 子集，并校正附带激活的历史记录，避免其他扩展注册工具时把未请求工具泄漏到后续请求。
- 每个会话独立维护 loaded 状态。恢复时优先使用成功加载结果中的提供者身份，兼容旧会话记录；策略读写使用 `ctx.cwd`，适配 child cwd 和 worktree。

调用示例：

```json
{ "tool_names": ["web_search", "fetch_content"] }
```

策略分为 `always`、`deferred`、`excluded`：

- `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 默认锁定为 `always`。
- `tool_search` 以及已获准注册的 `contact_supervisor`、`structured_output`、`bg_wait` 为协议控制工具；启用 deferred 时保持可用。固定展示模式不暴露 loader。
- 其他原本 active 的工具默认 `deferred`；原本 inactive 的工具及 `powershell` 默认 `excluded`，可通过策略调整。
- 子代理只处理它的白名单内、实际已注册工具。七工具默认不会给 reviewer 补上 bash/edit/write，也不会加载未列入白名单的目标。
- 旧配置中七类基本工具或上述控制工具的 `excluded/deferred` 值不再生效；它们在配置面板中显示为锁定的 `always`。其他工具的排除策略仍保留。工具选择不是操作系统权限沙箱。

## 模型和缓存边界

默认 `mode: "auto"` 检查当前 **resolved model**，不猜模型名称。对于 `openai-responses` 或 `openai-codex-responses`，只有模型声明 `compat.supportsAdditionalTools: true` 或 `compat.supportsToolSearch: true` 时才启用原生延迟加载。

未声明能力的端点采用 **eager：固定展示当前角色允许、且未被排除的工具**。自定义/无法识别的系统提示模板也采用此模式，原提示保持不变。可在配置中显式设 `mode: "eager"`；没有强行绕过能力检查的开关。

本机模型配置对应关系（保留原 model/thinking）：

| 角色 | 现有模型 | 默认行为 |
|---|---|---|
| scout、delegate | `openai-codex/gpt-5.6-luna` | 原生延迟加载 |
| oracle | `openai-codex/gpt-6-astra` | 原生延迟加载 |
| worker、reviewer、researcher | `ark2/kimi-k3` | 固定展示允许工具 |

GPT 的能力取自本机动态模型目录。当前 `ark2/kimi-k3` 没有声明这两个增量工具能力；仅使用 Responses API 不等于支持它们。本项目不修改 `models.json`，也不向未验证的端点强加兼容标记。角色换成支持的模型后，`auto` 会随模型能力调整。

在工具目录、策略、模型和其他提示内容不变时，目标是保持顶层 tools、系统提示及既有内联工具定义的位置和内容稳定。实际注册/删除工具、schema 或指南更新、修改策略、换模型、切换模式、压缩历史等都是允许改变缓存前缀的边界。其他扩展直接改写系统提示或请求的行为也不在本扩展的稳定性保证内。

请求结构稳定只是缓存的客户端条件，**不保证服务端真实命中**。真实收益应检查正常模型响应的缓存用量，例如 Pi 的 `usage.cacheRead`。

## nicobailon/pi-subagents 配置

配置文件：`~/.pi/agent/settings.json`，本机完整路径 `/home/thelya/.pi/agent/settings.json`。

将 [完整六角色配置](docs/subagents-settings.example.json) 合并到 `subagents.agentOverrides`，保留已有 `model`、`thinking`、其他角色字段和整个 `packages` 数组。配置脚本会完成该合并。

具体改动：

1. 六个角色均设置 `systemPromptMode: "append"`，保留 Pi 自动工具提示和 FFF 指南。
2. 六个角色的 `tools` 都包含 `tool_search` 和 Web 三工具：`web_search`、`fetch_content`、`get_search_content`。`tools` 是**允许集合**，不是强制每轮全部 active；loader 和将来可能加载的目标必须同时列入。
3. 通过角色级 `extensions` 显式加载提供者扩展，再加载 tool-search。这样前台和后台都不依赖 ambient 扩展发现，也不加载无关 footer/主题扩展。
4. scout、reviewer、oracle 设置 `completionGuard: false`。这些角色负责侦察/审阅/建议，避免 `tool_search` 被保守的工具分类当作写入能力后产生实现任务的完成检查干扰；这不会增加工具权限。
5. `subagents.defaultExtensions: []` 关闭其他未单独配置角色的常规扩展自动发现。子代理名单不包含 `pi-freeflow`、`doompi-autocompact`；主会话继续保留这两个包。
6. delegate、reviewer、researcher 增加 Docparser 扩展及文档三工具，按全局策略设为 deferred；scout、worker、oracle 保持代码侦察、实现、决策建议的工具范围。

各角色的基础工具和原有 supervisor 范围保持如下；每行再加上上述 loader 和 Web 三工具：

| 角色 | 基础/控制工具 |
|---|---|
| worker、delegate | `read, bash, edit, write, grep, find, ls, contact_supervisor` |
| scout | `read, grep, find, ls, bash, write, contact_supervisor` |
| reviewer | `read, grep, find, ls, contact_supervisor` |
| oracle | `read, grep, find, ls, bash` |
| researcher | `read, write` |

worker / scout / oracle 的 `extensions`：

```json
[
  "/home/thelya/.pi/agent/npm/node_modules/@ff-labs/pi-fff/src/index.ts",
  "/home/thelya/.pi/agent/npm/node_modules/pi-web-access/index.ts",
  "/home/thelya/.pi/agent/extensions/rtk.ts",
  "/home/thelya/.pi/agent/extensions/pi-tool-search/index.ts"
]
```

delegate 在上述列表的 tool-search 之前再加入 Docparser；reviewer 加载 FFF/Web/Docparser/tool-search；researcher 加载 Web/Docparser/tool-search。后两个角色没有 bash，不加载 RTK。完整示例包含每个角色的全部字段，不要用示例直接覆盖整个 settings 文件。

RTK 在有 bash 的四个角色启动时加载，通过 `tool_call` 钩子调用 `rtk rewrite` 改写 bash 命令；它不注册名为 `rtk` 的模型工具，不需要加入 `tools` 或由 tool-search 激活。本机验证为 `rtk 0.46.0`，扩展要求 PATH 中有 `rtk >= 0.23.0`。主会话的 RTK 配置不受影响。实际命令是否重写取决于 RTK 规则及 `RTK_DISABLED` 等设置。

这些角色没有设置 `tools: "inherit"`，不会取消各自白名单。自定义角色及显式覆盖本配置的任务启动参数需单独配置。

### 默认不加载扩展

显式 `extensions` 对前台和后台 child 都生效：启动时加载列表中的扩展，并禁用常规扩展自动发现。因此，不需要某个普通扩展时，从该角色列表中省略它即可。还需确认它没有通过 `subagentOnlyExtensions` 或路径形式的 `tools` 另外引入；pi-subagents 必需的运行时钩子不受普通列表省略影响。

配置脚本在 `~/.pi/agent/settings.json` 中合并以下默认列表：

```json
{
  "subagents": {
    "defaultExtensions": []
  }
}
```

它让没有单独声明 `extensions` 的角色默认关闭常规扩展自动发现；显式角色配置仍覆盖这个默认值。角色的 `extensions: []` 可用于单独关闭该角色的常规扩展发现。空数组不意味着禁用子代理内部运行时钩子，`subagentOnlyExtensions` 和路径形式 `tools` 仍需分别考虑。

当前子代理统一不加载 `pi-freeflow`、`doompi-autocompact`，也不加载 pi-btw、claude-style-tools、pi-transcribe、pi-footer。主会话的安装列表不变。这个默认值不是不可覆盖的安全拒绝规则：以后新增项目/角色或单次启动配置时，不应显式引入这些包；选择 `freeflow/...` 子模型也会产生提供者依赖，应改用已配置的模型来源。

如果 `extensions` 和 `defaultExtensions` 都未指定，前台 child 不加载 ambient 扩展；后台 child 默认会自动发现 ambient 扩展，除非能力上限禁止。不要把“删除整个 extensions 字段”当成“关闭扩展”，也不要把 Pi 包过滤器的 `-路径` 语法放进这个路径列表。

扩展不加载和工具 schema 延迟加载是两回事：从 `extensions` 中去掉 Web 扩展后，tool-search 不能凭空加载它的工具；如果 `tools` 仍要求这些未注册工具，子代理可能在启动检查时失败。要保留按需使用能力，应加载提供者扩展，再把它的工具设为 deferred。

### Docparser 按角色配置

扩展路径：`/home/thelya/.pi/agent/npm/node_modules/pi-docparser/extensions/docparser/index.ts`。

三个工具为 `document_parse`、`document_search`、`document_screenshot`，只加入以下角色的 `tools` 和扩展列表：

- researcher：读取研究资料、报告、PDF 和 Office 文档。
- reviewer：审阅文档、核对原文和页面证据。
- delegate：处理包括文档输入在内的通用委托任务。

这些工具的全局策略为 deferred。当前 delegate 使用支持原生增量工具的 GPT，因此按需加载；reviewer/researcher 使用未声明增量能力的 Kimi，`auto` 会固定展示允许工具。换成支持的模型后自动采用延迟加载。

scout、worker、oracle 没有加载 Docparser，其 manifest 不会因为全局策略中有文档工具记录就出现这些工具。联测覆盖了未加载提供者时的未知名称拒绝，以及实际单页 PDF 解析。扩展路径加载不等于加载其附带 skill；此配置不改变角色的 skills 设置。

## FFF 全局配置

文件：`~/.pi/agent/pi-fff.json`，本机为 `/home/thelya/.pi/agent/pi-fff.json`。设置：

```json
{ "mode": "override" }
```

这让 fresh child 从全局配置获得 override，不依赖主会话先执行 `/fff-mode override`。FFF 提供的 grep/find 沿用常驻策略和完整指南。配置脚本保留已有 FFF 其他字段，只覆盖 `mode`。

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

优先级为：受信任项目的 `<ctx.cwd>/.pi/pi-tool-search.json` > 全局配置 > 默认策略；基本/协议控制工具的锁定规则最后生效。未受信任项目不读取项目策略。设置 `PI_CODING_AGENT_DIR` 的 Pi 使用其指定 agent 目录。

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

`on` 启用能力感知模式；不支持的模型仍显示 `eager` 及原因。`off` 固定恢复允许的 deferred 工具、隐藏 loader，`excluded` 工具仍不启用。非空闲时拒绝修改工具策略。

审计默认关闭。开启后，在 `before_provider_request` 检查顶层工具、系统内容、既有内联工具定义及其位置，向 stderr 输出序号和 hash，不输出提示原文、工具结果或凭据；`audit status` 显示本会话最新结果。也可设置 `PI_TOOL_SEARCH_AUDIT=1` 或配置中的 `audit: true`，后者在 reload/新会话读取。

审计不发送额外模型请求、不启动子代理、不重复加载扩展。开启时会扫描请求的相关部分并计算 hash；关闭时不读取请求 payload。正常运行仍需要工具目录检查和历史消息引用遍历，不应理解为零 CPU 成本。每个 fresh child 本来就要初始化其显式扩展，tool-search 延迟的是**模型可见 schema**，不是扩展模块或 FFF 索引的初始化。

该钩子之后的其他扩展仍可能修改请求。严格回归测试以下述回环 HTTP 服务收到的最终请求体为准，不能只凭运行时 active 列表判断缓存条件。

## 开发、测试与部署

Node.js 22.19+（本机验证为 24.12.0）：

```bash
npm install
npm run verify
npm run test:subagents
```

- `verify`：严格 TypeScript 检查及 50 项单元/集成测试。
- `test:subagents`：实际 Pi child factory + 实际 FFF/Web/RTK/Docparser 扩展 + 本机 Responses SSE 服务。28 个场景、153 次 mock 请求、364 项断言，另检查六角色的 12 个前台/后台启动计划、8 个扩展加载策略计划，以及发现的全部角色的扩展选择。RTK 验证调用实际 `rtk rewrite`，末端 bash 使用记录命令的测试桩。Docparser 使用本地生成的单页 PDF、关闭 OCR，不需要外网或真实模型请求。
- 请求联测需本机已安装对应包和 RTK；其他机器可设置 `PROBE_PI_ROOT`、`PROBE_SUBAGENTS_ROOT`、`PROBE_FFF_ROOT`、`PROBE_WEB_ROOT`、`PROBE_RTK_ENTRY`、`PROBE_DOCPARSER_ROOT`，或用 `PROBE_TOOL_SEARCH_ENTRY` 指向待验证部署。脚本输出 `/tmp/pi-subagents-tool-search-*/report.json` 和逐场景请求记录。
- 开发依赖包含 `@earendil-works/pi-server@0.85.0`，用于 Pi 0.85 顶层 SDK 导出的直接 Node 导入；不会部署它或修改全局 npm 包。

部署与配置：

```bash
npm run deploy
npm run configure:subagents -- --dry-run
npm run configure:subagents
```

`deploy` 先验证，再将 `src/` 部署到 `~/.pi/agent/extensions/pi-tool-search/`。先暂存完整新版本，用 rename 切换；失败尝试恢复旧版本。每次旧版本保留在 `~/.pi/agent/extension-backups/pi-tool-search-<时间>-<UUID>/`，不覆盖既有备份。

配置脚本合并上述三个 JSON 文件，变更前备份已有文件到 `~/.pi/agent/config-backups/tool-search-<时间>-<UUID>/`；原本不存在的文件没有旧副本。它拒绝非法 JSON 和符号链接配置目标，重复执行无变化时不再写入。脚本会设置 `defaultExtensions: []`，按示例重新设置六角色的 `tools/extensions/systemPromptMode` 和指定的 `completionGuard` 字段，并重设全局 `mode: auto, audit: false` 及 Web/文档工具的 deferred 策略；如果以后自行调整这些字段，先用 dry-run 检查，或同步修改示例。

两个脚本均接受 `--agent-dir PATH`，配置脚本会将示例中的 agent 路径重定位到该目录。配置完成后**重启 Pi 或执行 `/reload`，再新建子代理**；已运行中的 child 不会被原地改配置。

回滚时先停用相关会话：用备份的目录恢复原 tool-search，用配置备份恢复原 settings/已有 JSON；本次新建的配置如不再需要，可移到备份目录。不要覆盖后来新增的配置变更。

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
scripts/               部署、配置合并、真实 child 请求联测
```

验证方法及适用边界见 [联合验证说明](docs/subagents-compatibility.md)。
