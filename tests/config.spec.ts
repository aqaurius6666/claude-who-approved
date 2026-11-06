import { describe, expect, test } from 'bun:test'

import { configOf, logRoot, logsTool, optionsOf } from '../hooks/config'

describe('optionsOf', () => {
  test('reads both key forms, last source wins, ignores other plugins', () => {
    const opts = optionsOf([
      { pluginConfigs: { 'who-approved': { options: { logDir: '/a', inputMax: 10 } } } },
      { pluginConfigs: { 'who-approved@who-approved': { options: { logDir: '/b' } }, other: { options: { logDir: '/x' } } } },
      undefined,
    ])
    expect(opts).toEqual({ logDir: '/b', inputMax: 10 })
  })
})

describe('configOf', () => {
  test('defaults', () => {
    expect(configOf({}, '/h')).toEqual({ logDir: undefined, inputMax: 400, includeTools: undefined, excludeTools: undefined, errors: [] })
  })
  test('expands ~ and drops a trailing slash', () => {
    expect(configOf({ logDir: '~/logs/' }, '/h').logDir).toBe('/h/logs')
    expect(configOf({ logDir: '~' }, '/h').logDir).toBe('/h')
  })
  test('inputMax 0 is allowed', () => {
    expect(configOf({ inputMax: 0 }, '/h').inputMax).toBe(0)
  })
  test('bad values fall back and are reported', () => {
    const c = configOf({ logDir: 'rel/path', inputMax: -1 }, '/h')
    expect(c.logDir).toBeUndefined()
    expect(c.inputMax).toBe(400)
    expect(c.errors).toHaveLength(2)
  })
})

describe('tool filter', () => {
  test('no lists logs every tool', () => {
    expect(logsTool({}, 'Read')).toBe(true)
  })
  test('includeTools keeps only those; excludeTools drops', () => {
    const c = configOf({ includeTools: ['Bash', 'Read'], excludeTools: ['Read'] }, '/h')
    expect(logsTool(c, 'Bash')).toBe(true)
    expect(logsTool(c, 'Read')).toBe(false)
    expect(logsTool(c, 'Edit')).toBe(false)
  })
  test('* matches any run of characters; other regex chars are literal', () => {
    const c = { includeTools: ['mcp__github__*', 'Bash'], excludeTools: ['*__delete_*'] }
    expect(logsTool(c, 'mcp__github__get_pr')).toBe(true)
    expect(logsTool(c, 'mcp__github__delete_repo')).toBe(false)
    expect(logsTool(c, 'mcp__slack__post')).toBe(false)
    expect(logsTool({ includeTools: ['Ba.h'] }, 'Bash')).toBe(false)
    expect(logsTool({ excludeTools: ['*'] }, 'Read')).toBe(false)
  })
  test('a non-list is reported and ignored', () => {
    const c = configOf({ includeTools: 'Bash' }, '/h')
    expect(c.includeTools).toBeUndefined()
    expect(c.errors).toHaveLength(1)
  })
})

describe('logRoot', () => {
  test('logDir wins', () => {
    expect(logRoot('/d', { claudeConfigDir: '/c', home: '/h' })).toBe('/d')
  })
  test('else under the claude config dir', () => {
    expect(logRoot(undefined, { home: '/h', claudeConfigDir: '/h/.claude-personal' })).toBe('/h/.claude-personal/.log/who-approved')
    expect(logRoot(undefined, { home: '/h' })).toBe('/h/.claude/.log/who-approved')
    expect(logRoot(undefined, {})).toBeUndefined()
  })
})
