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
 *
 * 0.2.1 (session-default dispatch):
 * - NEW: per-session DEFAULT dispatch. Set it once from the composer selector
 *   ("设为该会话默认"), and afterwards every plain `subagent` delegation in that
 *   session is routed to the chosen provider/model/effort at the
 *   `agent/request` layer — silent, no rule text needed, and it applies to
 *   every child shape (spawn / fork / workflow). Root agents are untouched.
 * - Explicitly pinned delegations (our own `subagent_flash` / `subagent_model`
 *   tools) are NEVER rewritten — per-call choice wins over the session default.
 * - Defaults persist to $DSH_HOME/storages/subagent-rules-defaults.json, so a
 *   session keeps its default across DSH restarts (persisted sessions only).
 * - The manual composer selector and the old insert-prompt flow stay intact.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

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

/** Read a bounded JSON request body (64 KiB cap). */
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        rejectBody(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks)
        resolveBody(raw.length === 0 ? {} : JSON.parse(raw.toString('utf8')))
      } catch (error) {
        rejectBody(error)
      }
    })
    req.on('error', rejectBody)
  })
}

/** Send a JSON response with an explicit content-length. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config !== null && typeof config === 'object' ? config : {}) }
  const defaultEffort = cfg.defaultEffort
  /** session id -> explicit effort override (in-process, per session). */
  const overrides = new Map()

  // ── 0.2.1 session-default dispatch store (persisted, per parent session) ──
  // Defaults live under the DELEGATING (parent) session id. A plain `subagent`
  // delegation of that session is rewritten to the stored provider/model/effort.
  const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  const defaultsDir = join(dshHome, 'storages')
  const defaultsFile = join(defaultsDir, 'subagent-rules-defaults.json')
  /** parent session id -> { provider, model, effort? } */
  const sessionDefaults = new Map()
  try {
    if (existsSync(defaultsFile)) {
      const raw = JSON.parse(readFileSync(defaultsFile, 'utf8'))
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [sid, entry] of Object.entries(raw)) {
          if (typeof sid !== 'string' || sid === '') continue
          if (entry === null || typeof entry !== 'object') continue
          const clean = {}
          if (typeof entry.provider === 'string' && entry.provider !== '') clean.provider = entry.provider
          if (typeof entry.model === 'string' && entry.model !== '') clean.model = entry.model
          if (typeof entry.effort === 'string' && EFFORT_VALUES.includes(entry.effort)) clean.effort = entry.effort
          if (clean.provider !== undefined || clean.model !== undefined) sessionDefaults.set(sid, clean)
        }
      }
    }
  } catch { /* corrupt or missing defaults file: start empty */ }

  const persistDefaults = () => {
    try {
      if (!existsSync(defaultsDir)) mkdirSync(defaultsDir, { recursive: true })
      const payload = {}
      for (const [sid, entry] of sessionDefaults) payload[sid] = entry
      const tmp = `${defaultsFile}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, defaultsFile)
    } catch { /* persistence is best-effort */ }
  }

  // ── request transform (OUTERMOST, prepend): subagent default routing + effort floor ──
  // 1. A subagent request (session.header.origin === 'subagent') whose parent
  //    session has a stored default is rewritten to that provider/model/effort —
  //    UNLESS the delegation is explicitly pinned by our own tools
  //    (options.xSubagentPinned), in which case per-call choice wins.
  // 2. Any request still lacking reasoningEffort gets the effort floor
  //    (effort_set override ?? defaultEffort); explicit efforts are untouched.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (resolved === undefined || resolved === null || typeof resolved !== 'object') return resolved
    const agent = payload?.agent
    const session = agent?.session
    const header = session?.header
    if (header?.origin === 'subagent' && !(agent.options && agent.options.xSubagentPinned)) {
      const parentId = header.parentSession
      const def = parentId !== undefined ? sessionDefaults.get(parentId) : undefined
      if (def !== undefined) {
        const routed = { ...resolved }
        if (def.provider !== undefined) routed.provider = def.provider
        if (def.model !== undefined) routed.model = def.model
        if (def.effort !== undefined) routed.reasoningEffort = def.effort
        return routed
      }
    }
    if (resolved.reasoningEffort !== undefined) return resolved
    const sessionId = session?.id
    const override = sessionId !== undefined ? overrides.get(sessionId) : undefined
    return {
      ...resolved,
      reasoningEffort: override ?? defaultEffort,
    }
  }, { prepend: true })

  // ── 0.2.1 config routes for the composer selector (set/clear/read default) ──
  // The webServer service may mount after this plugin's apply (load order), so
  // register lazily when it appears; headless profiles never mount it.
  let routesRegistered = false
  const registerRoutes = (webserver) => {
    if (routesRegistered) return
    routesRegistered = true
    ctx.effect(() => webserver.register({
      kind: 'exact',
      path: '/subagent-rules/default',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId')
          const entry = typeof sessionId === 'string' && sessionId !== '' ? sessionDefaults.get(sessionId) : undefined
          sendJson(res, 200, entry ?? {})
          return
        }
        if (req.method === 'POST') {
          try {
            const body = await readBody(req)
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
            if (sessionId === '') {
              sendJson(res, 400, { ok: false, error: 'missing sessionId' })
              return
            }
            const clear = body?.clear === true
            const provider = typeof body?.provider === 'string' && body.provider !== '' ? body.provider : undefined
            const model = typeof body?.model === 'string' && body.model !== '' ? body.model : undefined
            const effort = typeof body?.effort === 'string' && EFFORT_VALUES.includes(body.effort) ? body.effort : undefined
            if (clear || (provider === undefined && model === undefined)) {
              sessionDefaults.delete(sessionId)
              persistDefaults()
              sendJson(res, 200, { ok: true, config: {} })
              return
            }
            if (provider === undefined || model === undefined) {
              sendJson(res, 400, { ok: false, error: 'provider and model are required together' })
              return
            }
            const entry = { provider, model, ...(effort !== undefined ? { effort } : {}) }
            sessionDefaults.set(sessionId, entry)
            persistDefaults()
            sendJson(res, 200, { ok: true, config: entry })
            return
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid request body' })
            return
          }
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    }), 'dsh-subagent-rules: session-default config route')
  }
  const webserver = ctx.get('webServer')
  if (webserver !== undefined) {
    registerRoutes(webserver)
  } else {
    ctx.on('internal/service', (serviceName) => {
      if (serviceName !== 'webServer') return
      const ws = ctx.get('webServer')
      if (ws !== undefined) registerRoutes(ws)
    }, { global: true })
  }

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
              // xSubagentPinned: this delegation was explicitly pinned by our
              // own tool — the session-default router must NOT rewrite it.
              agentOptions: { provider: cfg.flashProvider, model: cfg.flashModel, xSubagentPinned: true },
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
              // xSubagentPinned: explicit per-call route — never rewritten by
              // the session-default router.
              agentOptions: { provider: args.provider, model: args.model, xSubagentPinned: true },
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
