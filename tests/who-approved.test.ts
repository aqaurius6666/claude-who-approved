import { expect, mock, test } from 'claude-code/testing'
import { decidedBy, logSlug } from '../hooks/who-approved'

const TRANSCRIPT = '/h/.claude/projects/-Users-me-codes-x/s1.jsonl'

test('decided_by attribution', async () => {
  expect(decidedBy(undefined, 'auto', false, false)).toBe('unknown')
  expect(decidedBy({ verdict: 'allow', rule: 'Bash(rg *)' }, 'auto', false, false)).toBe('settings_rule')
  expect(decidedBy({ verdict: 'allow', hook: 'PreToolUse' }, 'auto', false, false)).toBe('hook')
  expect(decidedBy({ verdict: 'deny', hook: 'PreToolUse' }, 'default', false, false)).toBe('hook')
  expect(decidedBy({ verdict: 'allow' }, 'auto', false, false)).toBe('core')
  expect(decidedBy({ verdict: 'ask' }, 'auto', false, false)).toBe('classifier')
  expect(decidedBy({ verdict: 'ask' }, 'auto', false, true)).toBe('classifier')
  expect(decidedBy({ verdict: 'ask' }, 'auto', true, false)).toBe('user')
  expect(decidedBy({ verdict: 'ask' }, 'default', false, false)).toBe('user')
  expect(decidedBy({ verdict: 'ask' }, undefined, false, false)).toBe('user_or_classifier')
  expect(decidedBy({ verdict: 'ask', hook: 'PreToolUse' }, 'auto', false, false)).toBe('user')
})

test('slug is the transcript project dir, or cwd with non-alphanumerics as -', async () => {
  expect(logSlug('/Users/me/.claude/projects/-Users-me-codes-x/abc.jsonl', '/x')).toBe('-Users-me-codes-x')
  expect(logSlug(undefined, '/Users/a.b/codes/personal/ai-space')).toBe('-Users-a-b-codes-personal-ai-space')
})

// sh stdout: CLAUDE_CONFIG_DIR, HOME.
type Setup = { sh?: string; settings?: Record<string, unknown> }

async function run($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], s: Setup = {}) {
  const clock = mock.clock(on)
  const tees: { path: string; line: Record<string, unknown> }[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('settings.read', (_, e) => ({ value: (e.source && s.settings?.[e.source]) ?? {} }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'tee') tees.push({ path: e.argv[2]!, line: JSON.parse(e.init!.stdin!) })
    const stdout = e.argv[0] === '/bin/sh' ? (s.sh ?? '\n/h\n') : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('classic.UserPromptSubmit', () => ({}) as never)
  return { clock, tees }
}

test('writes one approval line per call', async ($, on) => {
  const { clock, tees } = await run($, on)
  // Stand-in for the engine's verdicts.
  on('tool.check', (_, e) => {
    const cmd = (e.input as { command?: string }).command ?? ''
    if (e.tool === 'Read') return { decision: 'allow', rule: 'Read(*)' }
    if (cmd.startsWith('rg')) return { decision: 'allow', hook: 'PreToolUse' }
    return { decision: 'ask' }
  })
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/Users/me/codes/x', surface: 'desktop', isInteractive: true })
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'auto', transcript_path: TRANSCRIPT } as never)
  await $.tool.call({ tool: 'Bash', command: 'rg -l x docs' })
  await $.tool.call({ tool: 'Read', file_path: 'README.md' })
  await $.tool.call({ tool: 'Bash', command: 'ls $(echo docs)' })
  await clock.advance(200) // writes run from a timer

  expect(tees[0]!.path).toBe('/h/.claude/.log/who-approved/-Users-me-codes-x/approvals.jsonl')
  expect(tees.map(t => t.line.event)).toEqual([
    'approval:hook:ran',
    'approval:settings_rule:ran',
    'approval:user:ran', // dialog (PermissionRequest) opened → a person decided
  ])
  expect(tees[0]!.line.source).toBe('who-approved')
})

test('classifier deny is attributed by tool_use_id', async ($, on) => {
  const { clock, tees } = await run($, on)
  on('classic.PermissionDenied', () => ({}) as never)
  // Engine stand-in: the classifier refuses, raising PermissionDenied first.
  on('tool.check', async () => {
    await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu1', reason: 'classifier' } as never)
    return { decision: 'deny' }
  })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/Users/me/codes/x', surface: 'desktop', isInteractive: true })
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'auto', transcript_path: TRANSCRIPT } as never)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'tu1' } as never)
  await clock.advance(200)

  expect(tees.map(t => t.line.event)).toEqual(['approval:classifier:denied'])
})

test('follows CLAUDE_CONFIG_DIR', async ($, on) => {
  const { clock, tees } = await run($, on, { sh: '/h/.claude-personal\n/h\n' })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/Users/me/codes/x', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'a' })
  await clock.advance(200)

  expect(tees[0]!.path).toBe('/h/.claude-personal/.log/who-approved/-Users-me-codes-x/approvals.jsonl')
})

test('later sources win: local over project over user', async ($, on) => {
  const { clock, tees } = await run($, on, {
    sh: '\n/h\n',
    settings: {
      user: { pluginConfigs: { 'who-approved': { options: { logDir: '/user', inputMax: 400 } } } },
      project: { pluginConfigs: { 'who-approved': { options: { logDir: '~/audit' } } } },
      local: { pluginConfigs: { 'who-approved@who-approved': { options: { inputMax: 0 } } } },
    },
  })
  on('tool.check', () => ({ decision: 'allow', hook: 'PreToolUse' }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/Users/me/codes/x', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'echo $SECRET' })
  await clock.advance(200)

  expect(tees[0]!.path).toBe('/h/audit/-Users-me-codes-x/approvals.jsonl')
  expect(tees[0]!.line.normalized_command).toBeUndefined()
  expect(tees[0]!.line.input).toBeUndefined()
})
