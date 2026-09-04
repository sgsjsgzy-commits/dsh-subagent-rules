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

1. **模型路由**
   - 普通 `subagent` 继承会话主模型（默认行为）
   - 可在输入框旁选择器为本会话设置子代理默认 provider/model/effort（见 5），普通 `subagent` 派发即静默使用该默认
   - （0.2.6 起不再提供 `subagent_flash` / `subagent_model` 固定路由工具）
2. **思考强度规定**
   - 每个请求缺省 `reasoningEffort` 时，仅在目标模型**接受**该强度时补默认（避免对不支持 effort 的模型报错）；`effort_set` 工具可自定义 `max | high | medium | low | minimal`，`auto` 恢复默认
3. **手动规则选择器（0.2.0 新增，替代自动注入）**
   - 在聊天输入框的模型选择器旁显示一个带子代理图标的按钮
   - 打开后**读取 `session.models` 的所有提供商与模型**，不只是 flash
   - 先选模型，再在**二级菜单**里选该模型的思考强度（用于设置会话默认）
   - 不再每次对话自动塞入 `Subagent dispatch rules` 消息
4. **会话默认派发（0.2.2 新增，替代手动"插入提示词"）**
   - 选择器仅保留「会话默认派发」：选模型 + 强度后点「设为该会话默认」，之后本会话的普通 `subagent` 派发被**静默路由**到该默认（`agent/request` 层改写 provider/model/reasoningEffort），无需再插入任何提示词
   - 保持"会话内"语义：按父会话存储，默认持久化到 `$DSH_HOME/storages/subagent-rules-defaults.json`
   - 未设默认的会话：`subagent` 继承会话主模型（原样）

## 安装

手写 ESM 插件（无需 tsc / npm install 本插件）。常规安装流程（在本机 `dsh` profile 内，以 `web` 为例）：

1. 打包安装包
   ```sh
   cd dsh-subagent-rules
   bash scripts/build.sh                      # 校验 lib/index.js 与 lib/client.js
   npm pack --pack-destination /tmp           # 产物 /tmp/dsh-external-dsh-subagent-rules-<ver>.tgz
   mkdir -p ~/.dsh/vendor
   cp /tmp/dsh-external-dsh-subagent-rules-<ver>.tgz ~/.dsh/vendor/   # 放到持久目录，勿留 /tmp
   ```
2. 安装到 profile
   ```sh
   cd ~/.dsh/profiles/<profile>               # 例如 web
   dsh plugin add --profile <profile> ~/.dsh/vendor/dsh-external-dsh-subagent-rules-<ver>.tgz
   # 或把 package.json 依赖指向 file:../../vendor/dsh-external-dsh-subagent-rules-<ver>.tgz 后执行 pnpm install
   ```
3. 在 profile 的 `cordis.patch.yml` 注册插件与配置（见下节），然后**重启 DSH** 生效
4. 浏览器**硬刷新**（`Cmd+Shift+R`）加载新版 client

> 若部署内含 dsh-super-injector，也可用其 `dev_build_plugin` / `dev_inject_plugin` 运行时注入（免重启），效果相同。`dsh plugin add` 若提示 "no dsh.bundle — installed as a plain dependency" 为预期警告，本插件靠 patch 注册，忽略即可。

## 配置（profile / patch）

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: subagent-rules
      name: '@dsh-external/dsh-subagent-rules'
      config:
        provider: spawn            # 子代理 provider：spawn / fork
        flashProvider: <provider>  # 改成你环境真实注册的 provider id（见 ~/.dsh/settings.yaml）
        flashModel: <model-id>     # 改成真实 model id；指向不存在的模型会导致子代理拉起失败
        defaultEffort: max         # 请求缺省思考强度时的兜底（仅模型接受时补）
        injectRules: false         # 默认关闭自动注入；true 恢复旧版每次注入
```

- （0.2.6 起 `flashProvider` / `flashModel` / `toolName` 配置仍被接受但**不再使用**——`subagent_flash`/`subagent_model` 工具已移除）
- v0.2.2 的会话默认派发不开配置项：由输入框旁选择器按会话设置，持久化到 `$DSH_HOME/storages/subagent-rules-defaults.json`

## 用法

### 用户视角（UI 选择器）

1. 在输入框右下角、模型选择器旁边找到带子代理图标的小按钮（未设默认时显示"子代理默认"；已设时显示当前默认模型与强度）
2. 点击后选择：
   - **子代理模型**：从所有提供商的模型列表中选择
   - **思考强度**：选中模型后，在二级菜单里选择（max / high / medium / low / minimal / auto，或该模型适配器公布的强度）
3. 点击「设为该会话默认」（或「清除本会话默认」）
4. 设置后直接对话发起派发即可：普通 `subagent` 会静默使用该默认，无需插入任何提示词；要临时换模型就用 `subagent_model` / `subagent_flash` 显式指定

### 模型视角

- 派子代理 → `subagent`（本会话若设了默认则走默认模型/强度，否则继承会话主模型）
- 想让子代理用非默认强度 → 任务提示里写"先调用 `effort_set <level>` 再开始工作"
- 会话自己调强度 → `effort_set medium` / `effort_set auto`
- （0.2.6 起不再有 `subagent_flash` / `subagent_model` 固定路由工具；如需不同模型请为本会话设置默认）

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
