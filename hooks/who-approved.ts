import type { EngineInterface, Register } from 'claude-code'
import { configOf, logRoot, NAME, optionsOf, SOURCES } from './config'

// Appends one line per tool call to <root>/<project>/approvals.jsonl,
// saying who let it through: a hook, a settings rule, the auto-mode
// classifier, or a person.

type Check = {
  verdict: string
  rule?: string
  hook?: string
  plugin?: string
  setting?: string
  reason?: string
}

// 'ask' is settled after tool.check by the mode's decider. PermissionDenied
// (classifier deny) and PermissionRequest (dialog shown) make it exact;
// otherwise the permission mode decides.
export function decidedBy(
  c: Check | undefined,
  mode: string | undefined,
  personAsked: boolean,
  classifierDenied: boolean,
): string {
  if (classifierDenied) return 'classifier'
  if (!c) return 'unknown'
  if (c.verdict !== 'ask') return c.rule ? 'settings_rule' : c.hook ? 'hook' : 'core'
  // A hook's or plugin's ask always goes to a person, even in auto mode.
  if (personAsked || c.hook || c.plugin) return 'user'
  if (mode === 'auto') return 'classifier'
  return mode ? 'user' : 'user_or_classifier'
}

// The transcript's project dir name, which Claude Code derives from cwd by
// turning every non-alphanumeric into '-'. Classic events (our transcript_path
// source) can be skipped by a higher-tier plugin, so derive it from cwd then.
export function logSlug(transcriptPath: string | undefined, cwd: string): string {
  if (transcriptPath) {
    const dir = transcriptPath.slice(0, transcriptPath.lastIndexOf('/'))
    return dir.slice(dir.lastIndexOf('/') + 1)
  }
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

type Resolved = { root: string; inputMax: number }

async function resolve($: EngineInterface): Promise<Resolved | undefined> {
  const env = await $.process.run([
    '/bin/sh', '-c',
    'printf "%s\\n%s\\n" "$CLAUDE_CONFIG_DIR" "$HOME"',
  ])
  const [claudeConfigDir, home = ''] = env.stdout.split('\n')
  const sources = await Promise.all(SOURCES.map(source => $.settings.read({ source }).catch(() => undefined)))
  const cfg = configOf(optionsOf(sources), home)
  for (const err of cfg.errors) $.ui.toast(`${NAME}: config: ${err}`)
  const root = logRoot(cfg.logDir, { claudeConfigDir, home })
  return root ? { root, inputMax: cfg.inputMax } : undefined
}

const WRITE_DELAY_MS = 200

// $.fs.write overwrites; tee -a appends (O_APPEND).
async function appendLine($: EngineInterface, dir: string, text: string): Promise<void> {
  try {
    await $.process.run(['mkdir', '-p', dir])
    const res = await $.process.run(['tee', '-a', `${dir}/approvals.jsonl`], { stdin: text })
    if (res.exitCode !== 0) $.ui.toast(`${NAME}: tee exit ${res.exitCode}: ${res.stderr.slice(0, 120)}`)
  } catch (err) {
    $.ui.toast(`${NAME}: write failed: ${String(err).slice(0, 160)}`)
  }
}

export const register: Register = on => {
  const checks = new Map<string, Check>()
  const asked = new Set<string>() // tool names a dialog was opened for
  const denied = new Set<string>() // tool_use_ids the classifier denied
  let mode: string | undefined
  let transcriptPath: string | undefined
  let cwd = ''
  let resolved: Resolved | undefined
  let sessionId = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd
    sessionId = await $.session.id()
    resolved = await resolve($)
    const perms = (await $.settings.read({ key: 'permissions' })) as { defaultMode?: string } | undefined
    mode ||= perms?.defaultMode
    return started
  })

  // Mode fallback when classic events are skipped: the engine's auto-mode reminders.
  on('prompt.attachment', ($, e, next) => {
    if (e.type === 'auto_mode') mode = 'auto'
    else if (e.type === 'auto_mode_exit' && mode === 'auto') mode = 'default'
    return next(e)
  })

  // Only the classic events the plugin reads. A wildcard would also hook
  // Stop, Notification, etc., and on managed orgs each skipped one shows a notice.
  type Classic = { permission_mode?: string; transcript_path?: string; tool_name?: string; tool_use_id?: string }
  const seen = (c: Classic) => {
    if (c.permission_mode) mode = c.permission_mode
    if (c.transcript_path) transcriptPath = c.transcript_path
  }
  on('classic.UserPromptSubmit', ($, e, next) => {
    seen(e as Classic)
    return next(e)
  })
  on('classic.PermissionRequest', ($, e, next) => {
    const c = e as Classic
    seen(c)
    if (c.tool_name) asked.add(c.tool_name)
    return next(e)
  })
  on('classic.PermissionDenied', ($, e, next) => {
    const c = e as Classic
    seen(c)
    if (c.tool_use_id) denied.add(c.tool_use_id)
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const v = await next(e)
    if (e.tool_use_id) {
      checks.set(e.tool_use_id, {
        verdict: v.decision, rule: v.rule, hook: v.hook,
        plugin: v.plugin, setting: v.setting, reason: v.reason,
      })
    }
    return v
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const id = e.tool_use_id
    const c = id ? checks.get(id) : undefined
    const personAsked = c?.verdict === 'ask' && asked.delete(e.tool)
    const classifierDenied = !!id && denied.delete(id)
    if (id) checks.delete(id)
    // A mod loaded mid-session may never see session.start.
    if (!resolved) {
      cwd ||= await $.session.cwd()
      sessionId ||= await $.session.id()
      resolved = await resolve($).catch(() => undefined)
    }
    if (!resolved) {
      $.ui.toast(`${NAME}: log dir unknown (no HOME, no logDir set)`)
      return r
    }

    // inputMax 0 keeps no command text at all.
    const max = resolved.inputMax
    const clip = (s: string | undefined) => (s && max ? s.slice(0, max) : undefined)
    const { tool, tool_use_id, consent, ...args } = e as Record<string, unknown>
    const by = decidedBy(c, mode, personAsked, classifierDenied)
    // A permission refusal reaches tool.call hooks as isError (reason in
    // text), not as deny. A user's "no" in the dialog looks like a tool error.
    const outcome = r.deny !== undefined || c?.verdict === 'deny' || classifierDenied ||
      (r.isError && r.text?.startsWith("The user doesn't want to proceed"))
      ? 'denied' : r.isError ? 'error' : 'ran'
    const line = {
      ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), // RFC3339, no millis
      event: `approval:${by}:${outcome}`,
      source: NAME,
      session: sessionId,
      tool: e.tool,
      tool_use_id: id,
      normalized_command: typeof args.command === 'string' ? clip(args.command) : undefined,
      input: typeof args.command === 'string' ? undefined : clip(JSON.stringify(args)),
      permission_mode: mode,
      rule: c?.rule,
      hook: c?.hook,
      plugin: c?.plugin,
      setting: c?.setting,
      reason: c?.reason,
      deny: clip(r.deny ?? (r.isError ? r.text : undefined)),
    }
    const dir = `${resolved.root}/${logSlug(transcriptPath, cwd)}`
    // A denied or interrupted call aborts this dispatch and any $.process.run
    // started in it. A 0ms timer still fires inside that window (mkdir was
    // aborted in the log), so wait until the dispatch has settled.
    const text = JSON.stringify(line) + '\n'
    $.clock.after(WRITE_DELAY_MS, () => { void appendLine($, dir, text) })
    return r
  })
}
