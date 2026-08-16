# dsh-subagent-rules（子代理模型与思考强度规定）

一个 DeepSeek Harness 插件：在**输入框模型选择旁边**增加一个子代理选择器，让你手动选择子代理模型与思考强度，并把对应的分发提示词插入对话框。**默认不再自动注入任何规则消息**，因此 anchored 等严格首轮机制不会被污染。

## 设计定位

本插件是为了**配合 pro / flash 模型增强类插件使用**而设计的：

- 上层增强插件（例如 pro 负责高质量复杂任务、flash 负责低成本快速任务的组合）负责主会话的模型路由与增强能力；
- 本插件补上“派生子代理时精确选择模型与思考强度”的能力：
  - `subagent`：继承当前会话（通常 pro）
  - `subagent_flash`：快速锁定 flash 模型
  - `subagent_model`：从所有提供商模型中任选
- 同时把思考强度做成可选的二级选项，并在需要时让子代理先 `effort_set` 再开始工作。

## 它做什么

1. **模型规定**
   - 注册 `subagent_flash` 工具：子代理**锁定 flash 模型路由**（默认 `opencode-go` / `deepseek-v4-flash`），不受父会话模型影响
   - 普通 `subagent` 工具照旧继承父会话路由（通常是 pro）
2. **思考强度规定**
   - 每个请求缺省 `reasoningEffort` 时自动补 `max`（子代理路由不继承会话选择器的 effort——这是本插件要补的缺口）
   - `effort_set` 工具：任意会话（主对话或子代理）自定义自己的强度 `max | high | medium | low | minimal`，`auto` 恢复默认
3. **手动规则选择器（0.2.0 新增，替代自动注入）**
   - 在聊天输入框的模型选择器旁显示一个带子代理图标的按钮
   - 打开后**读取 `session.models` 的所有提供商与模型**，不只是 flash
   - 先选模型，再在**二级菜单**里选该模型的思考强度
   - 点击“插入子代理提示词”后，对应的分发提示词会写进输入框草稿，由你确认后发送
   - 不再每次对话自动塞入 `Subagent dispatch rules` 消息
4. **任意模型派发工具**
   - 注册 `subagent_model`：可把子代理固定到任意 `provider/model`，并可选指定思考强度
   - `subagent_flash` 仍保留，作为快速选择 flash 的快捷方式

## 安装

手写 ESM 插件（无需 tsc / npm install）：

```sh
# 通过 dsh-super-injector 构建（校验 lib/）并运行时注入
dev_build_plugin {"dir": "F:/dsh-subagent-rules"}
dev_inject_plugin {"dir": "F:/dsh-subagent-rules"}
```

重启 DSH 后对所有会话生效（注入器也可运行时注入，免重启）；发布后用 `dsh plugin add <tgz>` 常规安装亦可。

## 配置（profile / patch）

```yaml
- id: subagent-rules
  name: '@dsh-external/dsh-subagent-rules'
  config:
    provider: spawn            # 子代理 provider：spawn / fork
    flashProvider: opencode-go # flash 模型所在 provider（须在部署目录中）
    flashModel: deepseek-v4-flash
    defaultEffort: max         # 默认思考强度
    injectRules: false         # 默认关闭自动注入；true 恢复旧版每次注入
    toolName: subagent_flash   # flash 子代理工具名
```

## 用法

### 用户视角（UI 选择器）

1. 在输入框右下角、模型选择器旁边找到带子代理图标的小按钮
2. 点击后选择：
   - **子代理模型**：从所有提供商的模型列表中选择
   - **思考强度**：选中模型后，在二级菜单里选择（max / high / medium / low / minimal / auto，或该模型适配器公布的强度）
3. 点击“插入子代理提示词”
4. 提示词出现在输入框里，随消息一起发送

### 模型视角

- 派普通子代理 → `subagent`（继承父路由）
- 派 flash 子代理 → `subagent_flash`
- 派任意提供商/模型子代理 → `subagent_model`（参数：provider / model / reasoningEffort）
- 想让子代理用非默认强度 → 任务提示里写"先调用 `effort_set <level>` 再开始工作"
- 会话自己调强度 → `effort_set medium` / `effort_set auto`

## 注意与适配性

- **依赖**：`@deepseek-ai/dsh-subagent`（`subagents` 服务）——标准 Harness 组合自带；缺它插件会启动失败（响亮失败，按设计）
- `flashProvider`/`flashModel` 必须是部署环境**真实注册**的模型 id（检查 `~/.dsh/settings.yaml` 的 llm 目录；不存在的 id 会导致子代理拉起失败返回 null）
- 思考强度兜底只补"缺省"情况：显式设置的 effort 永不覆盖
- 与 anchored-standard preset 的 `subagentCatalog: flash` / 内置 `max-effort` / `tool-subagent-flash` 行可共存：**最近作用域优先**（preset 层同名工具遮蔽插件层），插件注册遇同名自动跳过；其他部署只需本插件
- 0.2.0 默认 `injectRules: false`，不会自动注入规则段；若你确实需要旧版自动注入行为，可显式设回 `true`（注意这会重新影响 anchored 首轮）
- 通过 dsh-super-injector 运行时注入时，需要在其 `KNOWN_SLOTS` 白名单中加入 `conversation.input.right`（否则重启后自动恢复会跳过本插件）；本地已改，克隆到其他环境时请同步该 patch

## 标签（GitHub）

官方生态指引（deepseek-harness CONTRIBUTING.md）：插件仓库必须关联 **`dsh-plugin`** topic。生态常用组合：`dsh-plugin` + `deepseek-harness` + `dsh`。

## 许可

BSD-3-Clause
