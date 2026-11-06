// Settings → where to log and how much command text to keep.
//
// Gotcha: project and local are read too, so a cloned repo's .claude/settings.json
// can move the log or blank the command text (inputMax: 0).

export const NAME = 'who-approved'
export const SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const
export const INPUT_MAX = 400

type Options = Readonly<Record<string, unknown>>

export type Tools = { includeTools?: string[]; excludeTools?: string[] }
export type Config = Tools & { logDir?: string; inputMax: number; errors: string[] }

// Keys under pluginConfigs: "who-approved" or "who-approved@<marketplace>".
// The last source setting a key wins.
export function optionsOf(sources: readonly unknown[]): Options {
  const out: Record<string, unknown> = {}
  for (const s of sources) {
    const configs = (s as { pluginConfigs?: Record<string, { options?: unknown }> } | undefined)?.pluginConfigs ?? {}
    for (const [key, v] of Object.entries(configs)) {
      if (key !== NAME && !key.startsWith(`${NAME}@`)) continue
      const opts = v?.options
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) Object.assign(out, opts)
    }
  }
  return out
}

export function configOf(options: Options, home: string): Config {
  const errors: string[] = []
  let logDir: string | undefined
  if (options.logDir !== undefined) {
    const raw = options.logDir
    const expanded = typeof raw === 'string' && home ? raw.replace(/^~(?=\/|$)/, home) : raw
    if (typeof expanded === 'string' && expanded.startsWith('/')) logDir = expanded.replace(/\/+$/, '')
    else errors.push(`logDir: needs an absolute path or ~/..., got ${JSON.stringify(raw)}`)
  }
  let inputMax = INPUT_MAX
  if (options.inputMax !== undefined) {
    const n = options.inputMax
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) inputMax = n
    else errors.push(`inputMax: needs a whole number >= 0, got ${JSON.stringify(n)}`)
  }
  const tools = (key: 'includeTools' | 'excludeTools') => {
    const v = options[key]
    if (v === undefined) return undefined
    if (Array.isArray(v) && v.every(t => typeof t === 'string')) return v as string[]
    errors.push(`${key}: needs a list of tool names, got ${JSON.stringify(v)}`)
    return undefined
  }
  return { logDir, inputMax, includeTools: tools('includeTools'), excludeTools: tools('excludeTools'), errors }
}

// A name with `*` matches any run of characters (`mcp__*`); else exact.
function matches(patterns: readonly string[], tool: string): boolean {
  return patterns.some(p => p.includes('*')
    ? new RegExp(`^${p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(tool)
    : p === tool)
}

// includeTools set: only those. excludeTools then drops from what is left.
export function logsTool(t: Tools, tool: string): boolean {
  if (t.includeTools && !matches(t.includeTools, tool)) return false
  return !(t.excludeTools && matches(t.excludeTools, tool))
}

export type Env = { claudeConfigDir?: string; home?: string }

// The folder that holds <project>/approvals.jsonl: logDir if set, else
// <claude config dir>/.log/who-approved.
export function logRoot(logDir: string | undefined, env: Env): string | undefined {
  if (logDir) return logDir
  const claude = env.claudeConfigDir || (env.home ? `${env.home}/.claude` : '')
  return claude ? `${claude}/.log/${NAME}` : undefined
}
