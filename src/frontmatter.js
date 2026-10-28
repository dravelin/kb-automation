/**
 * Minimal YAML frontmatter reader/writer for this vault.
 * The vault uses only flat scalars and string lists, so no full YAML parser is needed;
 * keeping it in-house makes field order and quoting fully deterministic.
 */

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/

function unquote(value) {
  const raw = String(value ?? '').trim()
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw.slice(1, -1)
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  return raw
}

function parseScalar(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (value === '[]') return []
  return unquote(value)
}

export function splitFrontmatter(text) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { has: false, fields: [], body: source }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return { has: false, fields: [], body: source }

  const fields = []
  let current = null
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem && current) {
      if (!Array.isArray(current.value)) current.value = current.value ? [current.value] : []
      current.value.push(unquote(listItem[1]))
      continue
    }
    const match = KEY_LINE.exec(line)
    if (match && !/^\s/.test(line)) {
      current = { key: match[1], value: parseScalar(match[2]) }
      fields.push(current)
    }
  }
  return { has: true, fields, body: lines.slice(end + 1).join('\n') }
}

export function getField(fields, key) {
  const found = fields.find((field) => field.key === key)
  return found ? found.value : undefined
}

export function setField(fields, key, value) {
  const found = fields.find((field) => field.key === key)
  if (found) found.value = value
  else fields.push({ key, value })
  return fields
}

function needsQuote(value) {
  const text = String(value)
  if (!text) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true
  if (/:\s|\s#|[\n\r\t]/.test(text)) return true
  if (/\s$/.test(text) || /^\s/.test(text)) return true
  return false
}

export function yamlScalar(value) {
  const text = String(value ?? '')
  if (Array.isArray(value)) return '[]'
  if (!text) return '""'
  return needsQuote(text) ? JSON.stringify(text) : text
}

export function stringifyFrontmatter(fields) {
  const lines = ['---']
  for (const field of fields) {
    if (Array.isArray(field.value)) {
      if (!field.value.length) {
        lines.push(`${field.key}: []`)
        continue
      }
      lines.push(`${field.key}:`)
      for (const item of field.value) lines.push(`  - ${yamlScalar(item)}`)
      continue
    }
    lines.push(`${field.key}: ${yamlScalar(field.value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

export const FIELD_ORDER = ['title', 'type', 'source', 'author', 'created', 'tags', 'status']

/** Spec §3: never add, drop, or reorder the seven mandatory fields. */
export function orderFields(fields) {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const ordered = []
  for (const key of FIELD_ORDER) {
    const field = byKey.get(key)
    ordered.push(field ?? { key, value: key === 'tags' ? [] : '' })
    byKey.delete(key)
  }
  for (const field of fields) if (byKey.has(field.key)) ordered.push(byKey.get(field.key))
  return ordered
}

export function tagList(fields) {
  const value = getField(fields, 'tags')
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
  return []
}

export function normalizeTags(tags) {
  return [...new Set((tags ?? []).map((tag) => String(tag).trim().replace(/^#/, '')).filter(Boolean))]
}

export function hasTagPrefix(tags, prefix) {
  return tags.some((tag) => tag.startsWith(prefix))
}

/** Extract one `## 摘要` style section body from markdown. */
export function sectionBody(body, heading) {
  const lines = String(body ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (start < 0) return ''
  const collected = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) break
    collected.push(lines[i])
  }
  return collected.join('\n').trim()
}

export function replaceSection(body, heading, content) {
  const lines = String(body ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  const block = String(content ?? '').trim()
  if (start < 0) {
    const trimmed = body.trimEnd()
    return `${trimmed}${trimmed ? '\n\n' : ''}## ${heading}\n\n${block}\n`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i
      break
    }
  }
  const nextHeading = end < lines.length ? lines[end] : null
  const rebuilt = [...lines.slice(0, start + 1), '', block, '']
  if (nextHeading) rebuilt.push(nextHeading, ...lines.slice(end + 1))
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** Insert one bullet under `### heading`, creating the heading when absent. */
export function insertUnderHeading(body, heading, line) {
  const lines = String(body ?? '').split(/\r?\n/)
  const target = lines.findIndex((item) => item.trim() === heading)
  const bullet = line.trim()
  if (target < 0) {
    const trimmed = body.trimEnd()
    return `${trimmed}${trimmed ? '\n\n' : ''}${heading}\n\n${bullet}\n`
  }
  let end = lines.length
  for (let i = target + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s/.test(lines[i])) {
      end = i
      break
    }
  }
  const sectionLines = lines.slice(target + 1, end)
  if (sectionLines.some((item) => item.trim() === bullet)) return body
  let insertAt = end
  for (let i = end - 1; i > target; i -= 1) {
    if (lines[i].trim()) {
      insertAt = i + 1
      break
    }
  }
  if (insertAt === target + 1) {
    lines.splice(target + 1, 0, '', bullet)
  } else {
    lines.splice(insertAt, 0, bullet)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}
