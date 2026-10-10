# dsh-skill-toggles

DeepSeek Harness 技能开关插件：**黑名单语义 + 分组**的 skill 启用/禁用管理。

- 默认语义：**默认全放行**。所有技能默认可用，仅被"启用中的分组"显式关闭的才被过滤；全新安装、状态文件缺失或损坏都等于"全部启用"，永不出现"装上即全消失"。
- 分组（v0.2.0）：内置**默认分组**（初始全开，可编辑、不可删除）；可创建任意自定义分组，每组维护自己的黑名单与"启用/停用"开关。**生效黑名单 = 所有启用分组黑名单的并集**；切换分组启用状态即整组生效/失效。
- UI：聊天输入框工具条按钮（"技能"，`conversation.input.left`）+ 左侧悬浮面板（分组管理：启用开关/选择编辑/重命名/新建/删除；技能列表 + 开关 + 搜索 + 清空该组 + 全部启用）。
- Agent 工具：`skill_toggles_list` / `skill_toggles_disable` / `skill_toggles_enable` / `skill_toggles_enable_all`（均带可选 `group` 参数，缺省为默认分组）+ `skill_toggles_group_create` / `skill_toggles_group_delete` / `skill_toggles_group_set_active`。
- 只管 skills，不做 MCP 开关。

## 安装

```
dsh plugin --profile desktop add file:D:/Work/Deepseek/dsh-Plugins/dsh-skill-toggles
```

安装后重启 DSH（或重载 profile）。浏览器半需要页面重新加载（F5）才会注入。

## 卸载

```
dsh plugin --profile desktop remove dsh-skill-toggles
```

包内 `postuninstall`（`scripts/cleanup.mjs`）会删除状态目录；若该生命周期脚本未被包管理器执行，手动删除即可：

```
# Windows PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsh-skill-toggles"
```

卸载后影子 provider 随插件 fiber 释放自动注销，全部技能恢复默认可用。

## 生效语义

| 路径 | 生效时机 |
|---|---|
| 输入框 `/` 技能菜单 | **下一次打开菜单即生效**（任何切换/分组变更后宿主向所有活动会话广播 `agent-preset/selected` 使客户端目录缓存失效，下一次 `/` 重新拉取，亚秒级） |
| 模型 `<available_skills>` 目录 | **下一条消息生效**（宿主机制为"持久投影"，对话中途不能热替换模型已见的目录，任何插件都如此） |
| `skill` 工具 | 立即拒绝被禁用的技能（`isModelInvocable` 门） |

面板中每行的开关作用于**当前选中的分组**；若某技能被其它启用分组禁用（本组开着），行上会显示"被「××」禁用"徽标；若本组禁用了它但本组未启用，显示"本组未启用"。

已知限制：Agent 未激活的冷会话由 preset 常驻 scope 供数，本插件的影子 provider 不覆盖该 scope，其 `/` 菜单可能仍显示已禁用技能，直到会话被激活（模型目录与 `skill` 工具不受影响，它们总是经过活动 Agent）。

## 实现要点

- 状态（v2）：`<DSH_HOME>/dsh-skill-toggles/state.json`，形如 `{ version:2, groups:[{id,name,disabled[]}], activeGroups[] }`；v1 扁平 `{disabled[]}` 文档加载时自动迁移进默认分组。原子写；损坏回退为"全部启用"；卸载时 `postuninstall` 删除该目录。
- 过滤机制：per-agent 影子 skill provider（`skill-toggles-filter`，注册在 agent 层）。`list()` 只发射"**生效**黑名单（启用分组并集）∧ 真实存在"的条目，invocation 改写为 `{modelInvocable:false, userInvocable:false}`，`rank:0` 在同层内直接胜出（文件系统根 rank 100..500）；最近层胜出保证 agent 层技能（user-dsh/project）同样被过滤。启用的技能不重发，保留原 provider 的 `path` 预览与正文加载。
- 变更后 `control.invalidate()` 清空 skill registry 的 collect 缓存（同时派发宿主本地 `skills/change`），再对每个活动会话 `ctx.emit('agent-preset/selected', sessionId, preset)` 使浏览器半缓存失效。
- 宿主半 `apply()` 保持同步（Cordis 对 prototype-bearing 函数的处理决定，异步 apply 会导致进程崩溃）。
- 与旧插件 `dsh-skills-mcp-group-manager` **互斥**（两个影子 provider 叠加语义不可控）；启动时检测到旧插件会打警告，不会自动卸载对方。

## 升级注意（宿主半热替换）

dsh-hmr 默认不监视已安装包的源码；**重装/升级已安装 bundle 后宿主半需要重启进程才换代码**（Node 模块缓存按解析结果缓存，bundle 重挂载不会重新 import）。浏览器半无此问题（每次页面加载重新拉取）。

本次 0.1.0→0.2.0 热替换采用的临时手段（仅存在于已安装副本，源码树无此内容）：安装目录内新增 `lib/index.v2.js`/`state.v2.js`/`store.v2.js` 重命名副本，`package.json` 的 `.` 导出与 `main` 指向 `index.v2.js`，`cordis.patch.yml` 行 `name` 改为该文件的绝对路径（新 specifier 强制重新解析）。下次从源码干净重装（remove + install）即恢复标准布局；重启进程后两种方式都走标准解析。

## 开发

```
node test/state.test.mjs   # 纯逻辑 + 存储往返测试（沙箱内 node --test 会 EPERM）
```

结构：

```
dsh-skill-toggles/
├── lib/index.js      宿主半（影子 provider、RPC、7 个工具、事件广播）
├── lib/client.js     浏览器半（输入框按钮 + 分组管理悬浮面板）
├── lib/state.js      纯状态逻辑（分组黑名单语义 + v1 迁移，单测覆盖）
├── lib/store.js      原子写状态存储
├── scripts/cleanup.mjs  postuninstall 清理
├── cordis.patch.yml  安装到 profile 的配置补丁片段
├── test/state.test.mjs
└── _verify/          宿主调研用一次性脚本（不发布）
```
