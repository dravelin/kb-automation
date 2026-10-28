import fs from 'node:fs/promises'
import path from 'node:path'

export async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export async function readText(file) {
  return await fs.readFile(file, 'utf8')
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file))
  await fs.writeFile(file, text, 'utf8')
}

/** Remove one file; a missing target is not an error. */
export async function deleteFile(file) {
  await fs.rm(file, { force: true })
}

export async function listDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** Every *.md file below `dir`, recursively, in stable order. */
export async function listMarkdownDeep(dir) {
  const out = []
  const walk = async (current) => {
    const entries = await listDir(current)
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full)
    }
  }
  await walk(dir)
  return out
}

export function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Modification date of `file` as YYYY-MM-DD. */
export async function mtimeDate(file) {
  const stat = await fs.stat(file)
  return isoDate(stat.mtime)
}

export function daysAgo(count, from = new Date()) {
  const date = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  date.setDate(date.getDate() - count)
  return date
}

export function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

const INVALID_FILE_CHARS = /[\\/:*?"<>|]/g

/** Spec §5: spaces become hyphens, path-hostile characters are dropped. */
export function sanitizeTitle(title) {
  return String(title ?? '')
    .replace(INVALID_FILE_CHARS, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function noteFileName(date, title) {
  const safe = sanitizeTitle(title) || '未命名'
  return `${date}-${safe}.md`
}

export function basenameNoExt(file) {
  return path.basename(file).replace(/\.md$/i, '')
}

/** Title part of a `YYYY-MM-DD-标题.md` file name. */
export function titleFromFileName(file) {
  const base = basenameNoExt(file)
  return base.replace(/^\d{4}-\d{2}-\d{2}-/, '')
}

export function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return value.slice(0, max)
}

export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Collapse a paragraph block into one line, keeping sentence punctuation. */
export function toSentence(text, max = 110) {
  const flat = oneLine(text)
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('；'))
  return lastStop >= max * 0.5 ? cut.slice(0, lastStop + 1) : cut
}

/** Character bigrams; CJK friendly similarity input. */
export function bigrams(text) {
  const clean = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
  const set = new Set()
  if (clean.length < 2) {
    if (clean) set.add(clean)
    return set
  }
  for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2))
  return set
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared += 1
  return shared / (a.size + b.size - shared)
}

export function uniqueList(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const key = String(value ?? '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export function stripCodeFence(text) {
  return String(text ?? '').replace(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/m, '$1')
}

export function markdownEscapeLink(text) {
  return oneLine(text).replace(/[[\]]/g, '')
}

/** Strip tags/script/style from an HTML page and flatten it to plain text. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
