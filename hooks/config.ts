// Settings → where to log and how much command text to keep.
//
// Read only the user's own sources: this is an audit log, so a cloned repo's
// .claude/settings.json (project) or a file the agent can write (local) must not
// move the log or blank the command text.

export const NAME = 'who-approved'
export const SOURCES = ['user', 'flag', 'policy'] as const
export const INPUT_MAX = 400

type Options = Readonly<Record<string, unknown>>

export type Config = { dir?: string; inputMax: number; errors: string[] }

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
  let dir: string | undefined
  if (options.dir !== undefined) {
    const raw = options.dir
    const expanded = typeof raw === 'string' && home ? raw.replace(/^~(?=\/|$)/, home) : raw
    if (typeof expanded === 'string' && expanded.startsWith('/')) dir = expanded.replace(/\/+$/, '')
    else errors.push(`dir: needs an absolute path or ~/..., got ${JSON.stringify(raw)}`)
  }
  let inputMax = INPUT_MAX
  if (options.inputMax !== undefined) {
    const n = options.inputMax
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) inputMax = n
    else errors.push(`inputMax: needs a whole number >= 0, got ${JSON.stringify(n)}`)
  }
  return { dir, inputMax, errors }
}

export type Env = { claudeConfigDir?: string; home?: string }

// The folder that holds <project>/approvals.jsonl: dir if set, else
// <claude config dir>/.log/who-approved.
export function logRoot(dir: string | undefined, env: Env): string | undefined {
  if (dir) return dir
  const claude = env.claudeConfigDir || (env.home ? `${env.home}/.claude` : '')
  return claude ? `${claude}/.log/${NAME}` : undefined
}
