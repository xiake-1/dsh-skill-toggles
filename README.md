# dsh-skill-toggles

DeepSeek Harness 技能开关插件：**黑名单语义**的 skill 启用/禁用管理。

- 默认语义：**默认全放行**。所有技能默认可用，仅显式关闭的被过滤；全新安装、状态文件缺失或损坏都等于"全部启用"，永不出现"装上即全消失"。
- UI：会话头部按钮（"技能开关"）+ 左侧悬浮面板（技能列表 + 开关 + 搜索 + 全部启用）。
- Agent 工具：`skill_toggles_list` / `skill_toggles_disable` / `skill_toggles_enable` / `skill_toggles_enable_all`。
- 只管 skills，不做 MCP 开关；不做分组/预设。

## 安装

```
dsh plugin --profile desktop add file:D:/Work/Deepseek/dsh-Plugins/dsh-skill-toggles
```

安装后重启 DSH（或重载 profile）。浏览器半需要页面重新加载才会注入。

## 生效语义

| 路径 | 生效时机 |
|---|---|
| 输入框 `/` 技能菜单 | **下一次打开菜单即生效**（切换后宿主向所有活动会话广播 `agent-preset/selected` 使客户端目录缓存失效，下一次 `/` 重新拉取，亚秒级） |
| 模型 `<available_skills>` 目录 | **下一条消息生效**（宿主机制为"持久投影"，对话中途不能热替换模型已见的目录，任何插件都如此） |
| `skill` 工具 | 立即拒绝被禁用的技能（`isModelInvocable` 门） |

已知限制：Agent 未激活的冷会话由 preset 常驻 scope 供数，本插件的影子 provider 不覆盖该 scope，其 `/` 菜单可能仍显示已禁用技能，直到会话被激活（模型目录与 `skill` 工具不受影响，它们总是经过活动 Agent）。

## 实现要点

- 过滤机制：per-agent 影子 skill provider（`skill-toggles-filter`，注册在 agent 层）。`list()` 只发射"已禁用 ∧ 真实存在"的条目，invocation 改写为 `{modelInvocable:false, userInvocable:false}`，`rank:0` 在同层内直接胜出（文件系统根 rank 100..500）；最近层胜出保证 agent 层技能（user-dsh/project）同样被过滤。启用的技能不重发，保留原 provider 的 `path` 预览与正文加载。
- 变更后 `control.invalidate()` 清空 skill registry 的 collect 缓存（同时派发宿主本地 `skills/change`），再对每个活动会话 `ctx.emit('agent-preset/selected', sessionId, preset)` 使浏览器半缓存失效。
- 宿主半 `apply()` 保持同步（Cordis 对 prototype-bearing 函数的处理决定，异步 apply 会导致进程崩溃）。
- 状态：`<DSH_HOME>/dsh-skill-toggles/state.json`（原子写；损坏回退为空黑名单）；卸载时 `postuninstall` 删除该目录。
- 与旧插件 `dsh-skills-mcp-group-manager` **互斥**（两个影子 provider 叠加语义不可控）；启动时检测到旧插件会打警告，不会自动卸载对方。

## 开发

```
node test/state.test.mjs   # 纯逻辑 + 存储往返测试（沙箱内 node --test 会 EPERM）
```

结构：

```
dsh-skill-toggles/
├── lib/index.js      宿主半（影子 provider、RPC、工具、事件广播）
├── lib/client.js     浏览器半（头部按钮 + 悬浮面板）
├── lib/state.js      纯状态逻辑（黑名单语义，单测覆盖）
├── lib/store.js      原子写状态存储
├── scripts/cleanup.mjs  postuninstall 清理
├── cordis.patch.yml  安装到 profile 的配置补丁片段
├── test/state.test.mjs
└── _verify/          宿主调研用一次性脚本（不发布）
```
