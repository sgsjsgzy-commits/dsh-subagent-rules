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

  /** session id -> { provider, model } of the last TOP-LEVEL request in that
      session, recorded so a child delegation can tell whether it still inherits
      the parent's route (rewrite to the session default) or was pinned to an
      explicit different route (leave untouched). This is the reliable signal —
      it does not depend on a custom field surviving the agentOptions pipeline. */
  const parentModelBySession = new Map()

  // Effort-floor guard: only materialize a default/override effort when the
  // exact provider/model route actually ACCEPTS it (reasoning.efforts). This
  // avoids "does not support reasoning effort X" for models that declare no
  // reasoning levels (e.g. a plain ollama model) or that don't accept the
  // default value. Capability is cached per provider/model; a failed resolve
  // is treated as "no reasoning" (safe: simply don't inject an effort).
  const effortSupportCache = new Map() // 'provider/model' -> { hasReasoning, efforts }
  const llmService = ctx.get('llm')
  const modelAcceptsEffort = async (provider, model, effort) => {
    if (llmService === undefined) return true
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return false
    const key = `${provider}/${model}`
    let info = effortSupportCache.get(key)
    if (info === undefined) {
      try {
        const m = await llmService.resolveModelInfo(provider, model)
        const efforts = (m && m.reasoning && Array.isArray(m.reasoning.efforts) ? m.reasoning.efforts : [])
          .map((entry) => entry?.id).filter(Boolean)
        info = { hasReasoning: Boolean(m && m.reasoning), efforts: new Set(efforts) }
      } catch {
        info = { hasReasoning: false, efforts: new Set() }
      }
      effortSupportCache.set(key, info)
    }
    if (!info.hasReasoning) return false
    return info.efforts.has(effort)
  }

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
  // 1. Record each TOP-LEVEL request's provider/model so a child delegation can
  //    be compared against its parent's route.
  // 2. A subagent request (session.header.origin === 'subagent') is rewritten to
  //    its parent session's stored default ONLY when it still INHERITS the parent
  //    route (resolved provider/model === parent's last top-level provider/model).
  //    Explicitly pinned delegations (subagent_flash / subagent_model) are skipped:
  //      - primarily by comparing to the parent route (robust, no extra field),
  //      - and additionally by the xSubagentPinned marker if the runtime keeps it.
  // 3. Any request still lacking reasoningEffort gets the effort floor
  //    (effort_set override ?? defaultEffort); explicit efforts are untouched.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (resolved === undefined || resolved === null || typeof resolved !== 'object') return resolved
    const agent = payload?.agent
    const session = agent?.session
    const header = session?.header
    const isSubagent = header?.origin === 'subagent'

    // Record top-level route so this session's children can be compared.
    if (!isSubagent) {
      const sid = session?.id
      if (sid !== undefined && resolved.provider !== undefined && resolved.model !== undefined) {
        parentModelBySession.set(sid, { provider: resolved.provider, model: resolved.model })
      }
      if (resolved.reasoningEffort !== undefined) return resolved
      const override = sid !== undefined ? overrides.get(sid) : undefined
      const targetEffort = override ?? defaultEffort
      if (targetEffort !== undefined && await modelAcceptsEffort(resolved.provider, resolved.model, targetEffort)) {
        return { ...resolved, reasoningEffort: targetEffort }
      }
      return resolved
    }

    // Subagent: rewrite to the session default ONLY if it still inherits the
    // parent route (i.e. was NOT explicitly pinned to a different model).
    const pinnedMarker = agent?.options && agent.options.xSubagentPinned
    const parentId = header?.parentSession
    const def = parentId !== undefined ? sessionDefaults.get(parentId) : undefined
    const parentModel = parentId !== undefined ? parentModelBySession.get(parentId) : undefined
    const inheritsParent = parentModel !== undefined
      && resolved.provider === parentModel.provider
      && resolved.model === parentModel.model
    if (def !== undefined && !pinnedMarker && inheritsParent) {
      const routed = { ...resolved }
      if (def.provider !== undefined) routed.provider = def.provider
      if (def.model !== undefined) routed.model = def.model
      if (def.effort !== undefined) routed.reasoningEffort = def.effort
      return routed
    }

    // Effort floor for any remaining request (top-level handled above; subagent
    // that was pinned or inherited but has no default still gets a floor) —
    // only materialize when the target route accepts the effort.
    if (resolved.reasoningEffort !== undefined) return resolved
    const sessionId = session?.id
    const override = sessionId !== undefined ? overrides.get(sessionId) : undefined
    const targetEffort = override ?? defaultEffort
    if (targetEffort !== undefined && await modelAcceptsEffort(resolved.provider, resolved.model, targetEffort)) {
      return { ...resolved, reasoningEffort: targetEffort }
    }
    return resolved
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

  // ── NOTE (0.2.6): the `subagent_flash` and `subagent_model` fixed-route
  // tools were REMOVED. The plugin now keeps only:
  //   - plain `subagent` (inherits the session's own model), and
  //   - the per-session default set via the composer selector, which the
  //     session-default router applies to plain subagent delegations.
  // No per-call model pinning tools remain.



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
