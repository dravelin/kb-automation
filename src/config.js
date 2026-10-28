import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_TOPICS } from './collect.js'

export const DEFAULT_VAULT = 'F:/dataobs'
export const DEFAULT_LIMIT = 6
export const DEFAULT_MAX_AGE_DAYS = 2
export const MAX_LIMIT = 7

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/
const FILE_NAME = 'config.json'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeDeep(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? mergeDeep(base[key], value) : value
  }
  return out
}

function normalizeTopics(value) {
  if (!Array.isArray(value)) return null
  const list = value.map((item) => String(item ?? '').trim()).filter(Boolean)
  return list.length ? list : null
}

function numeric(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function vaultText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

function assertVault(value) {
  const text = vaultText(value)
  if (!text || !ABSOLUTE_PATH.test(text)) throw new Error('工作地址必须是绝对路径')
  return text.replace(/\\/g, '/')
}

/** KB_CONFIG_HOME exists only so tests can point the config outside the real home directory. */
function homeDir() {
  const override = String(process.env.KB_CONFIG_HOME ?? '').trim()
  return override ? path.resolve(override) : os.homedir()
}

export function configPath() {
  return path.join(homeDir(), '.dsh', 'kb-automation', FILE_NAME)
}

/** Re-read on every call: hand edits must take effect without a restart. */
export function loadConfig() {
  const file = configPath()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, config: {}, warnings: [] }
    return { exists: false, config: {}, warnings: [`配置文件 ${file} 读取失败（${error.message}），已按空配置处理。`] }
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('顶层不是 JSON 对象')
    return { exists: true, config: parsed, warnings: [] }
  } catch (error) {
    return { exists: true, config: {}, warnings: [`配置文件 ${file} 解析失败（${error.message}），已按空配置处理。`] }
  }
}

export function saveConfig(patch) {
  const file = configPath()
  const merged = mergeDeep(loadConfig().config, patch)
  const { version: _version, updatedAt: _updatedAt, ...rest } = merged
  const next = { version: 1, ...rest, updatedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
  return next
}

export function resolveSettings({ args = {}, pluginConfig = {} } = {}) {
  const loaded = loadConfig()
  const warnings = [...loaded.warnings]
  const file = loaded.config ?? {}
  const plugin = pluginConfig ?? {}
  const stored = isPlainObject(file.collect) ? file.collect : {}

  const argsVault = vaultText(args.vault)
  const fileVault = vaultText(file.vault)
  const pluginVault = vaultText(plugin.vault)
  const vaultFrom = argsVault ? 'args' : fileVault ? 'config' : pluginVault ? 'plugin' : 'default'

  const argsTopics = normalizeTopics(args.topics)
  const fileTopics = normalizeTopics(stored.topics)
  const pluginTopics = normalizeTopics(plugin.topics)
  const topicsFrom = argsTopics ? 'args' : fileTopics ? 'config' : pluginTopics ? 'plugin' : 'default'

  const argsLimit = numeric(args.limit)
  const fileLimit = numeric(stored.limit)
  const pluginLimit = numeric(plugin.maxCollect)
  const limitFrom = argsLimit !== null ? 'args' : fileLimit !== null ? 'config' : pluginLimit !== null ? 'plugin' : 'default'

  const argsAge = numeric(args.maxAgeDays)
  const fileAge = numeric(stored.maxAgeDays)
  const pluginAge = numeric(plugin.maxAgeDays)
  const ageFrom = argsAge !== null ? 'args' : fileAge !== null ? 'config' : pluginAge !== null ? 'plugin' : 'default'

  let limit = Math.trunc(argsLimit ?? fileLimit ?? pluginLimit ?? DEFAULT_LIMIT)
  if (!Number.isFinite(limit)) {
    warnings.push(`收录上限不是有效数字，已改用 ${DEFAULT_LIMIT}。`)
    limit = DEFAULT_LIMIT
  }
  const clamped = Math.min(MAX_LIMIT, Math.max(1, limit))
  if (clamped !== limit) warnings.push(`收录上限 ${limit} 超出 1-${MAX_LIMIT}，已夹紧为 ${clamped}。`)
  limit = clamped

  let maxAgeDays = Math.trunc(argsAge ?? fileAge ?? pluginAge ?? DEFAULT_MAX_AGE_DAYS)
  if (!Number.isFinite(maxAgeDays)) {
    warnings.push(`时效不是有效数字，已改用 ${DEFAULT_MAX_AGE_DAYS} 天。`)
    maxAgeDays = DEFAULT_MAX_AGE_DAYS
  }
  if (maxAgeDays < 1) {
    warnings.push(`时效 ${maxAgeDays} 天无效，已改为 1 天。`)
    maxAgeDays = 1
  }

  return {
    vault: assertVault(argsVault ?? fileVault ?? pluginVault ?? DEFAULT_VAULT),
    topics: argsTopics ?? fileTopics ?? pluginTopics ?? DEFAULT_TOPICS,
    limit,
    maxAgeDays,
    source: { vault: vaultFrom, topics: topicsFrom, limit: limitFrom, maxAgeDays: ageFrom },
    warnings,
    configFile: configPath(),
  }
}
