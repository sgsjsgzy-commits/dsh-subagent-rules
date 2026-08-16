# dsh-subagent-rules（子代理模型与思考强度规定）

一个 DeepSeek Harness host-plane 插件：装上它并重启后，**所有对话**自动具备统一的子代理分发规则——模型路由怎么选、思考强度默认多少、怎么自定义。

## 它做什么

1. **模型规定**
   - 注册 `subagent_flash` 工具：子代理**锁定 flash 模型路由**（默认 `opencode-go` / `deepseek-v4-flash`），不受父会话模型影响
   - 普通 `subagent` 工具照旧继承父会话路由（通常是 pro）
2. **思考强度规定**
   - 每个请求缺省 `reasoningEffort` 时自动补 `max`（子代理路由不继承会话选择器的 effort——这是本插件要补的缺口）
   - `effort_set` 工具：任意会话（主对话或子代理）自定义自己的强度 `max | high | medium | low | minimal`，`auto` 恢复默认
3. **规则自动注入**
   - 系统提示注入 `subagent-rules` 段：模型读到"什么时候用 subagent_flash、effort 默认多少、怎么给子代理指定 effort"——不需要每次口头教

## 安装

零依赖手写 ESM 插件（无需 tsc / npm install）：

```sh
# 通过 dsh-super-injector 构建（仅校验 lib/）并运行时注入
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
    injectRules: true          # 是否注入分发规则段
    toolName: subagent_flash   # flash 子代理工具名
```

## 用法（模型视角）

- 派普通子代理 → `subagent`（继承父路由）
- 派 flash 子代理 → `subagent_flash`
- 想让子代理用非默认强度 → 任务提示里写"先调用 `effort_set <level>` 再开始工作"
- 会话自己调强度 → `effort_set medium` / `effort_set auto`

## 注意

- `flashProvider`/`flashModel` 必须是部署环境**真实注册**的模型 id（检查 `~/.dsh/settings.yaml` 的 llm 目录；不存在的 id 会导致子代理拉起失败返回 null）
- 思考强度兜底只补"缺省"情况：显式设置的 effort 永不覆盖
- 与 anchored-standard preset 的 `subagentCatalog: flash` / 内置 `max-effort` 行可共存（最近作用域优先）；其他部署只需本插件

## 许可

BSD-3-Clause
