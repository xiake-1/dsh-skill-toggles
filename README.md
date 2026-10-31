# dsh-skill-toggles

DeepSeek Harness 技能开关插件：**白名单语义 + 分组**——生效集合 = 所有"启用中分组"启用集合的并集；只管 skills，不做 MCP 开关。

![技能面板](assets/screenshots/panel.png)

## 安装

- **插件市场**：在 dshmarket 中搜索 `dsh-skill-toggles`，一键安装；
- **npm**：
  ```
  dsh plugin --profile desktop add dsh-skill-toggles
  ```
- **本地源码**：
  ```
  dsh plugin --profile desktop add file:<本仓库绝对路径>
  ```

安装后重启 DSH（浏览器半重新加载页面即可）。卸载：`dsh plugin --profile desktop remove dsh-skill-toggles`（`postuninstall` 自动删除状态目录 `<DSH_HOME>/dsh-skill-toggles/`）。

## 使用

![分组管理](assets/screenshots/groups.png)

1. **打开面板**：输入框工具条的「技能」按钮 → 左侧悬浮面板。
2. **分组**：默认分组（通配启用全部、不可删除）+ 内置「官方内置」分组（自带技能，初始停用）+ 自定义分组，整组启停或组内逐个例外。
3. **技能列表**：开关作用于当前选中分组；支持搜索、按来源分节、每节全部启用/全部禁用。
4. **目录同步**：插件装卸、bundle 启停、手改技能文件都会让面板与 `/` 菜单自动刷新。
5. **Agent 工具**：`skill_toggles_list / disable / enable / enable_all / disable_all / source_set / group_create / group_delete / group_set_active`。
6. **生效时机**：`/` 菜单下次打开、模型目录下一条消息、`skill` 工具立即。
