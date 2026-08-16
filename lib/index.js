/**
 * @dsh-external/dsh-subagent-rules — 子代理模型与思考强度规定
 * (subagent model & thinking-effort rules)
 *
 * Host-plane zero-dependency plugin: install it, restart, and every
 * conversation automatically knows how to dispatch subagents —
 *
 *   1. MODEL RULES: registers a `subagent_flash` tool pinned to the flash
 *      model route (children get the pinned provider/model regardless of the
 *      parent session's own route; the ordinary `subagent` tool keeps
 *      inheriting the parent route, usually pro).
 *   2. EFFORT RULES: the session selection carries `reasoningEffort` only to
 *      top-level requests — the subagent route does NOT inherit it, so
 *      children silently run at the provider default. This plugin floors
 *      every request at `defaultEffort` (max) and exposes `effort_set` for
 *      any session (top-level or subagent) to override its own effort
 *      (max|high|medium|low|minimal, auto restores the default). An explicit
 *      effort already present is never overridden.
 *   3. RULES INJECTION: a per-step message (`source.kind: subagent-rules`)
 *      tells every model which tool to use, what the effort default is, and
 *      how to ask a child for a non-default effort — no per-session coaching
 *      needed. A system-prompt SECTION would be invisible to presets whose
 *      persona is `complete: true` (e.g. anchored-standard collapses all
 *      sections to the persona), so the rules travel as a message instead;
 *      the kind is deliberately NOT in anchored's suppressedContextSources.
 *
 * Zero external imports (inline schema compiler). Follows the mode-boost
 * plugin form: hand-written ESM in lib/, `scripts/build.sh` only verifies.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = '@dsh-external/dsh-subagent-rules'

/**
 * The tools registry and the subagents service.
 * NOTE: the subagents service comes from @deepseek-ai/dsh-subagent — a
 * deployment without it cannot load this plugin (loud failure, by design).
 */
export const inject = ['tools', 'subagents']

const DEFAULT_CONFIG = {
  provider: 'spawn',
  flashProvider: 'opencode-go',
  flashModel: 'deepseek-v4-flash',
  defaultEffort: 'max',
  injectRules: true,
  toolName: 'subagent_flash',
}

/** Accepted effort values for effort_set (auto clears the override). */
const EFFORT_VALUES = ['max', 'high', 'medium', 'low', 'minimal']

/** Minimal spec → JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Build the auto-injected dispatch-rules section text. */
function rulesText(cfg) {
  return [
    'Subagent dispatch rules (dsh-subagent-rules):',
    `- Model route: a subagent spawned with the ordinary subagent tool inherits this session's model route (usually pro). To dispatch a FLASH-model subagent, use the ${cfg.toolName} tool (pinned to ${cfg.flashProvider}/${cfg.flashModel}).`,
    `- Thinking effort: every request of this deployment defaults to ${cfg.defaultEffort}; any session may change its own effort with effort_set (max | high | medium | low | minimal, auto restores the default).`,
    '- When a task wants a non-default effort for a subagent, say so in its prompt: "first call effort_set <level>, then work."',
    '- In minimal catalogs, discover more tools with dev_tool_search.',
  ].join('\n')
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config !== null && typeof config === 'object' ? config : {}) }
  const defaultEffort = cfg.defaultEffort
  /** session id -> explicit effort override (in-process, per session). */
  const overrides = new Map()

  // ── effort floor: every request without an explicit effort gets the
  //    default (top-level sessions usually already carry one from the session
  //    selection; subagents never do — this is the gap being closed). The
  //    listener is the OUTERMOST transform (prepend), so it sees the final
  //    state after the model selection and never overrides an explicit value.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (resolved === undefined || resolved === null || typeof resolved !== 'object') return resolved
    if (resolved.reasoningEffort !== undefined) return resolved
    const sessionId = payload?.agent?.session?.id
    const override = sessionId !== undefined ? overrides.get(sessionId) : undefined
    return {
      ...resolved,
      reasoningEffort: override ?? defaultEffort,
    }
  }, { prepend: true })

  // ── effort_set: any session overrides its own thinking effort ────────────
  ctx.effect(() => ctx.tools.register({
    name: 'effort_set',
    description: [
      `Set this session's reasoning effort (default: ${defaultEffort}).`,
      'Values: max / high / medium / low / minimal — or "auto" to restore the default. Applies from the next request on. A subagent sets its OWN session; to set a child\'s effort, instruct it in the task prompt.',
    ].join('\n'),
    parameters: toJsonSchema({
      value: { type: 'string', required: true, description: 'max | high | medium | low | minimal | auto' },
    }),
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return 'no agent session'
      const value = String(args?.value ?? '').trim().toLowerCase()
      if (value === 'auto') {
        overrides.delete(session.id)
        return `effort=${defaultEffort} (session ${String(session.id).slice(0, 8)}) — next request applies`
      }
      if (!EFFORT_VALUES.includes(value)) {
        return `invalid effort "${value}": use max | high | medium | low | minimal | auto`
      }
      overrides.set(session.id, value)
      return `effort=${value} (session ${String(session.id).slice(0, 8)}) — next request applies`
    },
  }), 'dsh-subagent-rules: effort_set')

  // ── subagent_flash: subagent tool pinned to the flash model route ────────
  ctx.effect(() => {
    try {
      ctx.tools.register({
        name: cfg.toolName,
        description: [
          `Start a subagent pinned to the ${cfg.flashProvider}/${cfg.flashModel} model route (flash), regardless of this session's own model.`,
          'This tool runs in the background by default and immediately returns a durable subagent id; the child keeps its conversation for later turns (send_message continues it).',
        ].join('\n'),
        parameters: toJsonSchema({
          description: { type: 'string', required: true, description: 'A short (3-5 word) description of the delegated task.' },
          prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the subagent. Mention "first call effort_set <level>, then work" when a non-default thinking effort is wanted.' },
        }),
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'continuable' },
              subagentId: { type: 'string' },
            },
            required: ['kind', 'subagentId'],
          },
          render: (_a, v) => [{ type: 'text', text: `started flash subagent ${v.subagentId}` }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec?.agent
          if (parent === undefined) throw new Error(`${cfg.toolName} requires a calling agent (exec.agent was undefined)`)
          const result = await ctx.subagents.startContinuable({
            provider: cfg.provider,
            label: args.description,
            request: {
              label: args.description,
              prompt: [{ type: 'text', text: args.prompt }],
              parent,
              agentOptions: { provider: cfg.flashProvider, model: cfg.flashModel },
            },
            signal: exec?.signal,
          })
          return { kind: 'continuable', subagentId: result.childId }
        },
      })
    } catch {
      // A same-name tool from a nearer scope (e.g. an anchored preset row) or
      // another router already owns this name — the nearest scope wins, so
      // this registration is intentionally skipped.
    }
  }, 'dsh-subagent-rules: subagent_flash')

  // ── rules injection: every conversation reads the dispatch rules ─────────
  // A system-prompt section would be collapsed away by presets whose persona
  // is `complete: true` (anchored-standard), so the rules are injected as a
  // per-step message with a kind that anchored's bootstrap filter does NOT
  // strip. Injected ONCE per session (in-process set); the rules also live in
  // the tool descriptions (subagent_flash, dev_tool_search index), so they
  // stay reachable even after compaction.
  if (cfg.injectRules) {
    const text = rulesText(cfg)
    const injected = new Set()
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
      const sessionId = agent?.session?.id
      if (sessionId !== undefined && injected.has(sessionId)) return decision
      if (sessionId !== undefined) injected.add(sessionId)
      return {
        ...decision,
        messages: [...decision.messages, {
          id: `subagent-rules-${String(sessionId ?? 'anon').slice(0, 16)}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'subagent-rules', form: 'hint' },
        }],
      }
    }, { prepend: true })
  }
}
