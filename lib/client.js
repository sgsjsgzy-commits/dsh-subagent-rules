/**
 * @dsh-external/dsh-subagent-rules — client half
 *
 * Adds a "subagent" selector next to the composer's model selector.
 * It reads every provider/model from session.models (not just flash),
 * then lets the user pick a model and a thinking effort as a second-level
 * option. Inserting writes a dispatch prompt into the composer draft.
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-subagent-rules",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    const { useEffect, useRef, useState } = react;

    const inject = ["slots", "connection"];

    // Blue filled insert button with a water-ripple animation.
    const SELECTOR_STYLE_ID = "@dsh-external/dsh-subagent-rules/selector.css";
    if (typeof document !== "undefined" && !document.querySelector(`style[data-plugin-css="${SELECTOR_STYLE_ID}"]`)) {
      const style = document.createElement("style");
      style.dataset.plugin = "@dsh-external/dsh-subagent-rules";
      style.dataset.pluginCss = SELECTOR_STYLE_ID;
      style.textContent = `
.dsr-insert-btn {
  position: relative;
  overflow: hidden;
  width: 100%;
  min-height: 32px;
  color: #fff;
  background: linear-gradient(135deg, #1e88e5 0%, #1565c0 100%);
  border: none;
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 4px;
  transition: transform .15s ease, box-shadow .2s ease;
}
.dsr-insert-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(30,136,229,.4);
}
.dsr-insert-btn::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(255,255,255,.35);
  transform: translate(-50%, -50%) scale(0);
  animation: dsr-water-ripple 2.2s ease-out infinite;
  pointer-events: none;
}
.dsr-insert-btn::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(120deg, transparent 20%, rgba(255,255,255,.25) 50%, transparent 80%);
  background-size: 200% 100%;
  animation: dsr-water-shimmer 3s linear infinite;
  pointer-events: none;
}
.dsr-insert-btn.dsr-inserted {
  box-shadow: 0 0 0 2px rgba(144,202,249,.8);
}
@keyframes dsr-water-ripple {
  0% { transform: translate(-50%, -50%) scale(0); opacity: .7; }
  100% { transform: translate(-50%, -50%) scale(8); opacity: 0; }
}
@keyframes dsr-water-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
`;
      document.head.appendChild(style);
    }

    const FALLBACK_EFFORTS = [
      { id: "max", name: "max" },
      { id: "high", name: "high" },
      { id: "medium", name: "medium" },
      { id: "low", name: "low" },
      { id: "minimal", name: "minimal" },
      { id: "auto", name: "auto（恢复默认）" },
    ];

    function findModel(catalog, providerId, modelId) {
      if (!catalog) return null;
      for (const group of catalog.groups || []) {
        if (group.id !== providerId) continue;
        const found = (group.models || []).find((m) => m.id === modelId);
        if (found) return { group, model: found };
      }
      return null;
    }

    function effortListFor(model) {
      const efforts = model?.reasoning?.efforts;
      return efforts && efforts.length ? efforts : FALLBACK_EFFORTS;
    }

    function buildPrompt(providerId, modelId, effortId, providerName, modelName, effortName) {
      const lines = [
        "[子代理分发设置]",
        "- 工具: subagent_model",
        `- 提供商: ${providerName || providerId} (${providerId})`,
        `- 模型: ${modelName || modelId} (${modelId})`,
      ];
      if (effortId && effortId !== "auto") {
        lines.push(`- 思考强度: ${effortName || effortId} (${effortId})`);
        lines.push(`- 派发时让子代理先调用 effort_set ${effortId} 再开始工作。`);
      } else {
        lines.push("- 思考强度: 默认（不额外指定）");
      }
      return lines.join("\n");
    }

    function SubagentIcon({ size = 14 }) {
      return react.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          "aria-hidden": true,
          style: { flex: "none" },
        },
        react.createElement("circle", { cx: 4.5, cy: 4, r: 1.8, fill: "none", stroke: "currentColor", strokeWidth: 1.4 }),
        react.createElement("circle", { cx: 11.5, cy: 4, r: 1.8, fill: "none", stroke: "currentColor", strokeWidth: 1.4 }),
        react.createElement("circle", { cx: 8, cy: 12, r: 1.8, fill: "none", stroke: "currentColor", strokeWidth: 1.4 }),
        react.createElement("path", { d: "M4.5 5.8v1.2a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5.8M8 9v1.2", fill: "none", stroke: "currentColor", strokeWidth: 1.4 })
      );
    }

    function SubagentRulesSelector(props) {
      const [open, setOpen] = useState(false);
      const [step, setStep] = useState("models"); // "models" | "effort"
      const [catalog, setCatalog] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [provider, setProvider] = useState(null);
      const [model, setModel] = useState(null);
      const [effort, setEffort] = useState(null);
      const [defaultCfg, setDefaultCfg] = useState(null); // 0.2.1 session default
      const [defaultLoading, setDefaultLoading] = useState(false);
      const rootRef = useRef(null);
      const { inputActions, input, loadModels, loadDefault, saveDefault, clearDefault } = props;

      useEffect(() => {
        if (!open) return;
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, [open]);

      // 0.2.1: read the session's stored default when the menu opens.
      useEffect(() => {
        if (!open || typeof loadDefault !== "function" || defaultCfg !== null) return;
        let cancelled = false;
        setDefaultLoading(true);
        loadDefault().then((value) => {
          if (cancelled) return;
          setDefaultCfg(value && (value.provider || value.model) ? value : null);
        }).catch(() => {
          if (!cancelled) setDefaultCfg(null);
        }).finally(() => {
          if (!cancelled) setDefaultLoading(false);
        });
        return () => {
          cancelled = true;
        };
      }, [open, loadDefault, defaultCfg]);

      const applyDefault = async () => {
        if (!provider || !model || typeof saveDefault !== "function") return;
        const ok = await saveDefault({ provider, model, effort });
        if (ok) setDefaultCfg({ provider, model, effort });
      };

      const removeDefault = async () => {
        if (typeof clearDefault !== "function") return;
        const ok = await clearDefault();
        if (ok) setDefaultCfg(null);
      };

      const isCurrentDefault = defaultCfg !== null
        && defaultCfg.provider === provider && defaultCfg.model === model
        && (defaultCfg.effort || null) === (effort || null);

      const load = async () => {
        if (!loadModels) return;
        setLoading(true);
        setError(null);
        try {
          const value = await loadModels();
          setCatalog(value);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      };

      const toggleOpen = () => {
        const next = !open;
        setOpen(next);
        if (next) {
          setStep("models");
          if (!catalog && !loading) load();
        }
      };

      const selectModel = (group, m) => {
        setProvider(group.id);
        setModel(m.id);
        const efforts = effortListFor(m);
        const def = m.reasoning?.defaultEffort || efforts[0]?.id || "auto";
        setEffort(def);
        setStep("effort");
      };

      const selectEffort = (e) => {
        setEffort(e.id);
      };

      const currentFound = findModel(catalog, provider, model);
      const currentModel = currentFound?.model;
      const currentEfforts = effortListFor(currentModel);
      const currentEffortName = currentEfforts.find((e) => e.id === effort)?.name || effort;

      const buttonStyle = {
        minWidth: 0,
        maxWidth: 240,
        height: 28,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        background: "transparent",
        border: "none",
        borderRadius: 24,
        outline: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "0 4px 0 8px",
        fontSize: 13,
        fontWeight: 500,
        lineHeight: "20px",
      };
      const chevronStyle = {
        color: "var(--dsw-alias-label-caption)",
        flex: "none",
        transition: "transform .12s",
        transform: open ? "rotate(180deg)" : "none",
      };
      const menuStyle = {
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        zIndex: 20,
        width: 300,
        maxHeight: "min(480px, calc(100vh - 96px))",
        overflowY: "auto",
        background: "var(--dsw-specific-menu)",
        border: "1px solid var(--dsw-alias-border-inverted)",
        borderRadius: 12,
        boxShadow: "var(--dsw-shadow-lv3)",
        color: "var(--dsw-alias-label-primary)",
        padding: 6,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      };
      const sectionLabelStyle = {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 12,
        fontWeight: 500,
        lineHeight: "18px",
        padding: "5px 8px 2px",
      };
      const optionStyle = (selected) => ({
        width: "100%",
        minHeight: 32,
        color: "var(--dsw-alias-label-primary)",
        textAlign: "left",
        cursor: "pointer",
        background: selected ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
        border: "none",
        borderRadius: 8,
        padding: "4px 8px",
        fontSize: 13,
        lineHeight: "18px",
        display: "flex",
        alignItems: "center",
        gap: 6,
      });
      const backStyle = {
        ...optionStyle(false),
        color: "var(--dsw-alias-label-secondary)",
        fontWeight: 600,
      };

      const triggerLabel = defaultCfg && defaultCfg.model
        ? `子代理默认 · ${String(defaultCfg.model).split("-")[0]} · ${defaultCfg.effort || "父级"}`
        : "子代理默认";

      return react.createElement(
        "div",
        {
          ref: rootRef,
          style: { position: "relative", display: "inline-flex", alignItems: "center", minWidth: 0 },
        },
        react.createElement(
          "button",
          {
            type: "button",
            style: buttonStyle,
            onClick: toggleOpen,
            "aria-haspopup": "menu",
            "aria-expanded": open,
            title: "子代理分发设置：选择任意提供商模型与思考强度，插入提示词",
          },
          react.createElement(SubagentIcon, { size: 14 }),
          react.createElement(
            "span",
            { style: { textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" } },
            triggerLabel
          ),
          react.createElement(
            "svg",
            { viewBox: "0 0 16 16", width: 14, height: 14, style: chevronStyle, "aria-hidden": true },
            react.createElement("path", {
              d: "M4 6l4 4 4-4",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 1.5,
              strokeLinecap: "round",
              strokeLinejoin: "round",
            })
          )
        ),
        open &&
          react.createElement(
            "div",
            { role: "menu", style: menuStyle },
            step === "models" &&
              react.createElement(
                react.Fragment,
                null,
                react.createElement("div", { style: sectionLabelStyle }, "选择子代理模型（全部提供商）"),
                loading && react.createElement("div", { style: { padding: "8px", fontSize: 12 } }, "加载模型中…"),
                error && react.createElement("div", { style: { color: "var(--dsw-alias-state-error-primary)", padding: "8px", fontSize: 12 } }, error),
                !loading && !error && catalog && (catalog.groups || []).map((group) =>
                  react.createElement(
                    react.Fragment,
                    { key: group.id },
                    react.createElement("div", { style: { ...sectionLabelStyle, marginTop: 4 } }, group.name || group.id),
                    (group.models || []).map((m) =>
                      react.createElement(
                        "button",
                        {
                          key: m.id,
                          type: "button",
                          role: "menuitem",
                          style: optionStyle(provider === group.id && model === m.id),
                          onClick: () => selectModel(group, m),
                        },
                        react.createElement(
                          "span",
                          { style: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 } },
                          react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.name || m.id),
                          m.description
                            ? react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.description)
                            : null
                        )
                      )
                    )
                  )
                )
              ),
            step === "effort" &&
              react.createElement(
                react.Fragment,
                null,
                react.createElement(
                  "button",
                  { type: "button", style: backStyle, onClick: () => setStep("models") },
                  "← 返回模型列表"
                ),
                react.createElement("div", { style: sectionLabelStyle },
                  `思考强度 · ${currentModel?.name || model}`
                ),
                currentEfforts.map((e) =>
                  react.createElement(
                    "button",
                    {
                      key: e.id,
                      type: "button",
                      role: "menuitemradio",
                      "aria-checked": effort === e.id,
                      style: optionStyle(effort === e.id),
                      onClick: () => selectEffort(e),
                    },
                    react.createElement("span", { style: { flex: 1 } }, e.name || e.id),
                    e.description
                      ? react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11 } }, e.description)
                      : null
                  )
                ),
                react.createElement("div", {
                  style: { ...sectionLabelStyle, marginTop: 10, borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8 },
                }, defaultLoading ? "会话默认派发 · 读取中…" : "会话默认派发（本会话）"),
                defaultCfg === null
                  ? react.createElement("div", {
                      style: { padding: "2px 8px 6px", fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px" },
                    }, "未设置：用 subagent 派的子代理继承父路由。")
                  : react.createElement("div", {
                      style: { padding: "2px 8px 6px", fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: "18px" },
                    }, `默认：${defaultCfg.model} · ${defaultCfg.effort || "父级强度"}`),
                react.createElement(
                  "button",
                  {
                    type: "button",
                    disabled: isCurrentDefault || !provider || !model,
                    style: {
                      width: "100%",
                      minHeight: 30,
                      marginTop: 2,
                      padding: "4px 8px",
                      fontSize: 13,
                      fontWeight: 600,
                      borderRadius: 8,
                      cursor: isCurrentDefault ? "default" : "pointer",
                      background: isCurrentDefault ? "transparent" : "transparent",
                      color: isCurrentDefault ? "var(--dsw-alias-state-success-primary, #2e7d32)" : "var(--dsw-alias-brand-primary, #1e88e5)",
                      border: isCurrentDefault ? "1px solid transparent" : "1px solid var(--dsw-alias-border-l3)",
                    },
                    onClick: applyDefault,
                  },
                  isCurrentDefault ? "✓ 已是本会话默认" : "设为该会话默认"
                ),
                defaultCfg !== null
                  ? react.createElement(
                      "button",
                      {
                        type: "button",
                        style: {
                          width: "100%",
                          marginTop: 2,
                          padding: "3px 8px",
                          fontSize: 12,
                          color: "var(--dsw-alias-label-secondary)",
                          background: "transparent",
                          border: "none",
                          borderRadius: 6,
                          cursor: "pointer",
                          textAlign: "center",
                        },
                        onClick: removeDefault,
                      },
                      "清除本会话默认"
                    )
                  : null
              )
          )
      );
    }

    function apply(ctx) {
      const connection = ctx.get("connection");
      const DEFAULT_ROUTE = "/subagent-rules/default";
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register({
          name: "conversation.input.right",
          id: "subagent-rules-selector",
          order: 5,
          inject: (sessionId) => ({
            sessionId,
            loadModels: async () => {
              const { result } = await connection.api.sessions.models({ sessionId });
              if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
              return result.value;
            },
            // 0.2.1: session-default dispatch read/write/clear (host webServer route).
            loadDefault: async () => {
              if (typeof sessionId !== "string" || sessionId === "") return {};
              try {
                const response = await fetch(`${DEFAULT_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`);
                if (!response.ok) return {};
                return await response.json();
              } catch {
                return {};
              }
            },
            saveDefault: async (entry) => {
              if (typeof sessionId !== "string" || sessionId === "") return false;
              try {
                const response = await fetch(DEFAULT_ROUTE, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ sessionId, ...entry }),
                });
                return response.ok;
              } catch {
                return false;
              }
            },
            clearDefault: async () => {
              if (typeof sessionId !== "string" || sessionId === "") return false;
              try {
                const response = await fetch(DEFAULT_ROUTE, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ sessionId, clear: true }),
                });
                return response.ok;
              } catch {
                return false;
              }
            },
          }),
        }, SubagentRulesSelector)
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
