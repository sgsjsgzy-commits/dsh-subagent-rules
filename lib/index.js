/**
 * @dsh-external/dsh-subagent-rules — 子代理模型与思考强度规定
 * (subagent model & thinking-effort rules)
 *
 * Host-plane zero-dependency plugin: install it, restart, and every
 * conversation gets the subagent dispatch controls WITHOUT polluting the
 * conversation with automatic rule messages —
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
 *   3. MANUAL RULES: instead of auto-injecting a per-step message, the
 *      client adds a small "subagent" selector next to the model selector.
 *      Choosing a subagent model and thinking effort inserts the matching
 *      dispatch prompt into the composer, so the rules appear only when the
 *      user asks for them — anchored first requests stay completely clean.
 *      (A system-prompt section would be invisible to complete-persona
 *      presets, and per-step injection pollutes anchored; the manual prompt
 *      is the non-invasive path.)
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
  injectRules: false,
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

  // ── subagent_model: subagent tool pinned to ANY provider/model route ────
  // The client selector reads session.models and offers every provider/model;
  // this tool is what makes a non-flash selection actually dispatchable.
  ctx.effect(() => {
    try {
      ctx.tools.register({
        name: 'subagent_model',
        description: [
          'Start a subagent pinned to an explicit provider/model route, regardless of this session\'s own model.',
          'Optionally include reasoningEffort to ask the child to call effort_set before working.',
          'This tool runs in the background by default and immediately returns a durable subagent id; the child keeps its conversation for later turns (send_message continues it).',
        ].join('\n'),
        parameters: toJsonSchema({
          description: { type: 'string', required: true, description: 'A short (3-5 word) description of the delegated task.' },
          prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the subagent.' },
          provider: { type: 'string', required: true, description: 'Provider id (from session.models groups).' },
          model: { type: 'string', required: true, description: 'Model id under the selected provider.' },
          reasoningEffort: { type: 'string', required: false, description: 'Optional effort for the child (max | high | medium | low | minimal | auto).' },
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
          render: (_a, v) => [{ type: 'text', text: `started subagent ${v.subagentId}` }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec?.agent
          if (parent === undefined) throw new Error('subagent_model requires a calling agent (exec.agent was undefined)')
          let prompt = args.prompt
          if (args.reasoningEffort && args.reasoningEffort !== 'auto') {
            prompt = `${prompt}\n\n[subagent effort] First call effort_set ${args.reasoningEffort} in your session, then start working.`
          }
          const result = await ctx.subagents.startContinuable({
            provider: cfg.provider,
            label: args.description,
            request: {
              label: args.description,
              prompt: [{ type: 'text', text: prompt }],
              parent,
              agentOptions: { provider: args.provider, model: args.model },
            },
            signal: exec?.signal,
          })
          return { kind: 'continuable', subagentId: result.childId }
        },
      })
    } catch {
      // Same-name tool from a nearer scope wins; skip silently.
    }
  }, 'dsh-subagent-rules: subagent_model')


  // ── rules injection: OPT-IN, OFF by default (0.2.0) ─────────────────────
  // The client selector is the primary path: it inserts the same dispatch
  // prompt into the composer only when the user picks a subagent model/effort.
  // This block remains only for deployments that explicitly set
  // `injectRules: true`; anchored-standard first requests are no longer
  // touched unless the operator opts back into the old behavior.
  if (cfg.injectRules) {
    const text = rulesText(cfg)
    const injected = new Set()
    const isPromoted = (session) => {
      if (session === undefined || !Array.isArray(session.events)) return false
      return session.events.some((event) => event.type === 'tool/call' || event.type === 'assistant/message')
    }
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
      const session = agent?.session
      const sessionId = session?.id
      if (sessionId !== undefined && injected.has(sessionId)) return decision
      if (!isPromoted(session)) return decision
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
