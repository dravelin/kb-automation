import path from 'node:path'
import { exists, bigrams, clip, daysAgo, htmlToText, isoDate, jaccard, noteFileName, oneLine, parseIsoDate, toSentence, writeText } from './util.js'
import { normalizeTags, orderFields, stringifyFrontmatter } from './frontmatter.js'
import { ALLOWED_TYPE_TAGS, FOLDERS, Vault } from './vault.js'
import { asString, asStringArray, complete, extractJson, llmReady } from './llm.js'

export const DEFAULT_TOPICS = [
  'AI Agent 最新进展 产品 发布',
  'AI 模型 降价 免费额度 优惠 最新',
  'AI 落地 生产 案例 应用',
]

const PREFETCH_LIMIT = 14
const MIN_TEXT = 400

const SYSTEM_PROMPT = `你是个人知识库的资料收集助手，只做筛选与摘要，不编造事实。
判断标准：
- 与「AI Agent / AI 最新突破与价格优惠 / AI 生产落地案例」明确相关；
- 有具体信息（产品、数字、时间、做法），不是空泛观点；
- 同一事件只留一条，优先信息最全的那篇；
- 优先中文来源；非中文内容只有在信息独特时才收，且摘要必须用中文写。
不知道的字段留空字符串，不要猜测作者或日期。`

function buildSelectionPrompt(candidates, existingTitles, topicList, maxCollect) {
  const listing = candidates
    .map((item, index) => {
      const bits = [`[${index}] ${item.title || '(无标题)'}`, `链接：${item.url}`]
      if (item.publishedAt) bits.push(`时间：${item.publishedAt}`)
      if (item.text) bits.push(`正文片段：${clip(oneLine(item.text), 700)}`)
      else if (item.snippet) bits.push(`摘要：${clip(oneLine(item.snippet), 200)}`)
      return bits.join('\n')
    })
    .join('\n\n')

  return `今天是 ${isoDate()}。主题：${topicList.join(' / ')}。

候选内容（已抓取正文片段）：
${listing}

知识库已有标题（避免重复收录）：
${[...existingTitles].slice(0, 80).map((title) => `- ${title}`).join('\n') || '- （空）'}

请挑出最有价值、与主题明确相关、且互不重复的 ${maxCollect} 篇以内（宁少勿多）。只输出 JSON：
{"picks":[{"index":候选序号,"title":"中文标题，不超过 30 字","author":"作者或媒体名，不知道留空","published":"YYYY-MM-DD 或空","summary":"200 字以内中文摘要，基于正文片段写，不要照抄标题","keywords":["关键词"],"keyPoints":["3~5 条关键要点，每条 15~40 字，要有具体信息"],"quote":"正文里最有信息量的一两句原文，不超过 120 字","tags":["主题/模型价格","类型/观点"],"reason":"一句话说明为什么值得收录"}]}
要求：summary 必须是有信息量的中文，不能等于标题；keyPoints 恰好 3~5 条。`
}

function buildEnrichPrompt(item, pageText) {
  return `请为知识库写一条收录卡片，只输出 JSON：
{"title":"中文标题，不超过 30 字","author":"作者或媒体名，不知道留空","published":"YYYY-MM-DD 或空","summary":"200 字以内中文摘要","keywords":["关键词 3~5 个"],"keyPoints":["3~5 条关键要点，每条 15~40 字"],"quote":"原文中最有信息量的一两句直接引用，不超过 120 字","tags":["主题/模型价格","类型/观点"]}

标题：${item.title || ''}
链接：${item.url}

正文：
${clip(pageText, 6000)}`
}

export function guessTheme(text, knownThemes) {
  const source = String(text ?? '')
  const hits = []
  for (const theme of knownThemes) {
    const core = String(theme).split('/').pop()
    if (core && source.includes(core)) hits.push({ theme, size: core.length })
  }
  hits.sort((a, b) => b.size - a.size)
  return hits[0]?.theme ?? ''
}

function normalizeThemeTags(tags, vocabulary, hint) {
  const out = []
  for (const tag of tags ?? []) {
    const clean = String(tag).trim().replace(/^#/, '')
    if (!/^(主题|类型|状态)\/.+/.test(clean)) continue
    if (clean.startsWith('类型/') && !ALLOWED_TYPE_TAGS.has(clean)) {
      out.push('类型/观点')
      continue
    }
    out.push(clean)
  }
  if (!out.some((tag) => tag.startsWith('主题/'))) {
    const guessed = guessTheme(hint, [...vocabulary.主题])
    out.push(guessed || '主题/未分类')
  }
  if (!out.some((tag) => tag.startsWith('类型/'))) out.push('类型/观点')
  if (!out.some((tag) => tag.startsWith('状态/'))) out.push('状态/待消化')
  return normalizeTags(out)
}

const TRACKING_PARAMS = /^(spm|spss|trackid|track_id|from_spmid|request_id|caid|resource_id|source_id|creative_id|linked_creative_id|scm|utm_\w+|wfr|clickfrom|share_\w+)$/i

function canonicalUrl(raw) {
  try {
    const url = new URL(String(raw))
    const keep = []
    for (const [key, value] of url.searchParams) {
      if (!TRACKING_PARAMS.test(key)) keep.push([key, value])
    }
    if (!keep.length) url.search = ''
    else url.search = `?${keep.map(([key, value]) => `${key}=${value}`).join('&')}`
    return url.toString()
  } catch {
    return String(raw)
  }
}

/** First date-like token in the page head, used to reject stale search hits. */
function firstDateIn(text) {
  const head = String(text ?? '').slice(0, 4000)
  for (const match of head.matchAll(/(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/g)) {
    const date = parseIsoDate(`${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`)
    if (date) return date
  }
  return null
}

function isStale(date, maxAgeDays) {
  if (!date) return false
  const cutoff = daysAgo(maxAgeDays)
  const tomorrow = new Date(Date.now() + 86400000)
  return date < cutoff && date <= tomorrow
}

function isForeignTitle(title) {
  return /[\u3040-\u30ff\uac00-\ud7af]/.test(String(title ?? ''))
}

function sentences(text, count = 4) {
  return String(text ?? '')
    .split(/(?<=[。！？；])|\n+/)
    .map((item) => oneLine(item))
    .filter((item) => item.length >= 12)
    .slice(0, count)
}

function fallbackPick(candidate) {
  const text = candidate.text || candidate.snippet || ''
  return {
    url: candidate.url,
    title: clip(oneLine(candidate.title), 40),
    author: '',
    published: candidate.publishedAt ?? '',
    summary: toSentence(text, 190) || toSentence(candidate.title, 190),
    keywords: [],
    keyPoints: sentences(text, 4),
    quote: '',
    tags: [],
    reason: '',
  }
}

async function fetchDirect(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.6',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!response.ok) return { text: '', error: `HTTP ${response.status}` }
    const type = response.headers.get('content-type') ?? ''
    const raw = await response.text()
    const text = /html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw
    return { text, error: text ? '' : '正文为空' }
  } catch (error) {
    return { text: '', error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchPageText(ctx, url, mode) {
  const web = ctx.get('web')
  const useDirect = mode === 'direct' || !web
  if (useDirect) {
    const direct = await fetchDirect(url)
    return { ...direct, via: 'direct' }
  }
  const viaWeb = await (async () => {
    try {
      const result = await web.fetch({ url })
      if (!result) return { text: '', error: '空响应' }
      if (result.statusCode < 200 || result.statusCode >= 300) return { text: '', error: `HTTP ${result.statusCode}` }
      const body = result.body
      if (!body?.content) return { text: '', error: '响应没有正文' }
      const text = body.kind === 'html' ? htmlToText(body.content) : String(body.content)
      return { text, error: text ? '' : '正文为空' }
    } catch (error) {
      return { text: '', error: error.message }
    }
  })()
  if (viaWeb.text || mode === 'web') return { ...viaWeb, via: 'web' }
  const direct = await fetchDirect(url)
  return { ...direct, via: 'direct', webError: viaWeb.error }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return out
}

function normalizeUrl(value) {
  return String(value ?? '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()
}

export async function runCollect({ ctx, vaultRoot, config, signal, limit, topics, maxAgeDays: maxAgeDaysArg, topicList }) {
  const vault = new Vault(vaultRoot)
  const warnings = []
  const usedTopics = topics?.length ? topics : topicList?.length ? topicList : config?.topics?.length ? config.topics : DEFAULT_TOPICS
  const maxCollect = Math.max(1, Math.min(Math.trunc(Number(limit ?? config?.maxCollect ?? 6) || 6), 7))
  const maxAgeDays = Math.max(1, Math.trunc(Number(maxAgeDaysArg ?? config?.maxAgeDays ?? 2) || 2))
  const used = { topics: usedTopics, limit: maxCollect, maxAgeDays }

  const web = ctx.get('web')
  if (!web) {
    return { ok: false, stage: 'collect', summary: 'web 服务不可用，跳过收集。', warnings: ['当前 profile 没有可用的 web 检索服务。'], created: [], ...used }
  }

  const raw = []
  for (const query of usedTopics) {
    try {
      const result = await web.search({ query, maxResults: 8 })
      for (const source of result.sources ?? []) {
        raw.push({
          url: String(source.url ?? '').trim(),
          title: String(source.title ?? '').trim(),
          snippet: String(source.snippet ?? '').trim(),
          publishedAt: String(source.publishedAt ?? '').trim(),
          answer: String(result.content ?? ''),
        })
      }
    } catch (error) {
      warnings.push(`检索「${query}」失败：${error.message}`)
    }
  }

  if (!raw.length) {
    return { ok: false, stage: 'collect', summary: '检索没有返回任何候选内容。', warnings, created: [], ...used }
  }

  const corpus = await vault.corpus()
  const knownUrls = new Set([...corpus.urls].map(normalizeUrl))
  const candidates = []
  const seen = new Set()
  let skippedForeign = 0
  for (const item of raw) {
    if (!item.url) continue
    const key = normalizeUrl(item.url)
    if (knownUrls.has(key) || seen.has(key)) continue
    if (isForeignTitle(item.title)) {
      skippedForeign += 1
      continue
    }
    seen.add(key)
    candidates.push(item)
  }
  if (skippedForeign) warnings.push(`跳过 ${skippedForeign} 条非中文来源（日文/韩文标题）。`)
  if (!candidates.length) {
    return { ok: true, stage: 'collect', summary: '检索到的内容都已收录过，本次没有新增。', warnings, created: [], considered: raw.length, ...used }
  }

  // Fetch page text first: the search provider returns titles and URLs only, so a pick
  // without body text cannot produce an honest summary.
  const fetchMode = String(config?.fetchMode ?? 'auto')
  const prefetch = candidates.slice(0, PREFETCH_LIMIT)
  const fetched = await mapLimit(prefetch, 4, async (item) => {
    const page = await fetchPageText(ctx, item.url, fetchMode)
    return { ...item, text: page.text, fetchError: page.error, via: page.via, pageDate: firstDateIn(page.text) }
  })
  const stale = fetched.filter((item) => isStale(item.pageDate, maxAgeDays))
  if (stale.length) {
    warnings.push(
      `丢弃 ${stale.length} 条非近期内容（超过 ${maxAgeDays} 天）：${stale
        .slice(0, 4)
        .map((item) => `${item.title.slice(0, 18)}…(${item.pageDate.toISOString().slice(0, 10)})`)
        .join('、')}`,
    )
  }
  const fresh = fetched.filter((item) => !isStale(item.pageDate, maxAgeDays))
  const rich = fresh.filter((item) => (item.text ?? '').length >= MIN_TEXT)
  const directUsed = fetched.filter((item) => item.via === 'direct' && (item.text ?? '').length >= MIN_TEXT).length
  if (directUsed) {
    const sample = fetched.find((item) => item.via === 'direct' && item.webError)?.webError
    warnings.push(
      `有 ${directUsed}/${fetched.length} 条正文改用直连抓取：harness 的抓取策略拒绝这些域名${sample ? `（${sample}）` : ''}，常见原因是本机 DNS 把公网域名解析到保留地址段。`,
    )
  }
  const pool = rich.length ? rich : fresh
  if (!rich.length) {
    const firstError = fetched.find((item) => item.fetchError && item.fetchError !== '正文为空')?.fetchError
    warnings.push(`候选页面都没能抓到正文${firstError ? `（首个错误：${firstError}）` : ''}，摘要只能依赖标题，质量受限。`)
  }
  if (!pool.length) {
    return {
      ok: true,
      stage: 'collect',
      summary: `检索到 ${raw.length} 条候选，但没有可用的近期内容（抓取 ${fetched.length} 页，日期过旧 ${stale.length} 条），本次未收录。`,
      warnings,
      considered: raw.length,
      created: [],
      rejected: [],
      ...used,
    }
  }

  const existingTitles = new Set([...corpus.titles].filter(Boolean))
  let picks = []
  let usedModel = false
  let modelNote = ''
  if (llmReady(ctx)) {
    try {
      const reply = await complete(ctx, {
        system: SYSTEM_PROMPT,
        prompt: buildSelectionPrompt(pool, existingTitles, usedTopics, maxCollect),
        signal,
        maxTokens: 2200,
      })
      const parsed = extractJson(reply)
      usedModel = true
      modelNote = parsed ? '' : `模型回复无法解析为 JSON（前 160 字：${clip(reply, 160)}）`
      for (const pick of parsed?.picks ?? []) {
        const index = Number(pick?.index)
        const candidate = Number.isInteger(index) ? pool[index] : undefined
        if (!candidate) {
          modelNote ||= `模型给出的候选序号无效：${JSON.stringify(pick?.index)}`
          continue
        }
        const title = asString(pick.title) || candidate.title
        if (existingTitles.has(title)) continue
        picks.push({
          url: candidate.url,
          title,
          author: asString(pick.author),
          published: asString(pick.published) || candidate.publishedAt,
          summary: asString(pick.summary),
          keywords: asStringArray(pick.keywords, 6),
          keyPoints: asStringArray(pick.keyPoints, 5),
          quote: asString(pick.quote),
          tags: asStringArray(pick.tags, 6),
          reason: asString(pick.reason),
          text: candidate.text ?? '',
        })
        existingTitles.add(title)
        if (picks.length >= maxCollect) break
      }
      if (!picks.length) {
        warnings.push(`模型筛选没有给出可用篇目${modelNote ? `：${modelNote}` : ''}，退回按检索顺序取前 ${maxCollect} 篇。`)
      }
    } catch (error) {
      warnings.push(`模型筛选失败，退回按检索顺序取前 ${maxCollect} 篇：${error.message}`)
    }
  }
  if (!picks.length) picks = pool.slice(0, maxCollect).map(fallbackPick)

  const created = []
  const rejected = []
  for (const pick of picks) {
    if (signal?.aborted) break
    const sourceText = pick.text || ''

    // A pick with neither body text nor a model-written summary would land as a title-only note.
    if (!sourceText && (!pick.summary || pick.summary === pick.title)) {
      rejected.push({ url: pick.url, title: pick.title, reason: '抓不到正文，模型也没给出有效摘要，没有收录。' })
      continue
    }
    if (created.some((item) => jaccard(bigrams(item.title), bigrams(pick.title)) > 0.62)) {
      rejected.push({ url: pick.url, title: pick.title, reason: '与其他收录项讲的是同一件事，跳过。' })
      continue
    }
    const nearExisting = [...corpus.titles].find((title) => title && jaccard(bigrams(title), bigrams(pick.title)) > 0.66)
    if (nearExisting) {
      rejected.push({ url: pick.url, title: pick.title, reason: `与库里已有笔记「${nearExisting}」讲的是同一件事，跳过。` })
      continue
    }

    if (!pick.summary || pick.summary.length < 40) {
      pick.summary = toSentence(sourceText || pick.title, 190)
    }
    if (!pick.keyPoints?.length) pick.keyPoints = sentences(sourceText, 4)

    if (llmReady(ctx) && sourceText.length >= MIN_TEXT) {
      try {
        const reply = await complete(ctx, {
          system: SYSTEM_PROMPT,
          prompt: buildEnrichPrompt(pick, sourceText),
          signal,
          maxTokens: 1600,
        })
        const parsed = extractJson(reply)
        if (parsed) {
          pick.title = asString(parsed.title) || pick.title
          pick.author = asString(parsed.author) || pick.author
          pick.summary = asString(parsed.summary) || pick.summary
          pick.keywords = asStringArray(parsed.keywords, 6).length ? asStringArray(parsed.keywords, 6) : pick.keywords
          pick.keyPoints = asStringArray(parsed.keyPoints, 5).length ? asStringArray(parsed.keyPoints, 5) : pick.keyPoints
          pick.quote = asString(parsed.quote) || pick.quote
          pick.tags = asStringArray(parsed.tags, 6).length ? asStringArray(parsed.tags, 6) : pick.tags
          pick.published = asString(parsed.published) || pick.published
        }
      } catch (error) {
        warnings.push(`为「${pick.title}」生成正文摘要失败，改用规则摘要：${error.message}`)
      }
    }

    const publishedDate = parseIsoDate(pick.published)
    if (isStale(publishedDate, maxAgeDays)) {
      rejected.push({ url: pick.url, title: pick.title, reason: `页面标注发布日期 ${pick.published}，超过 ${maxAgeDays} 天，不属于「今天最新」。` })
      continue
    }

    const date = isoDate()
    const title = clip(oneLine(pick.title) || '未命名资料', 40)
    const sourceUrl = canonicalUrl(pick.url)
    const hint = `${title} ${pick.summary} ${(pick.keyPoints ?? []).join(' ')}`
    const tags = normalizeTags([...normalizeThemeTags(pick.tags, vault.vocabulary(corpus.notes), hint), '状态/待消化'])
    const file = path.join(vault.dir(FOLDERS.inbox), noteFileName(date, title))
    if (await exists(file)) {
      rejected.push({ url: pick.url, title, reason: '已存在同名笔记，跳过。' })
      continue
    }

    const fields = orderFields([
      { key: 'title', value: title },
      { key: 'type', value: 'raw' },
      { key: 'source', value: sourceUrl },
      { key: 'author', value: pick.author || '未署名' },
      { key: 'created', value: date },
      { key: 'tags', value: tags },
      { key: 'status', value: 'inbox' },
    ])
    if (pick.published && /^\d{4}-\d{2}-\d{2}/.test(pick.published)) {
      fields.push({ key: 'published', value: pick.published.slice(0, 10) })
    }

    const summary = toSentence(pick.summary, 200)
    const keywords = pick.keywords.length
      ? pick.keywords
      : [...new Set(title.split(/[\s，,、：:]+/).filter((word) => word.length >= 2))].slice(0, 5)
    const keyPoints = (pick.keyPoints ?? []).filter(Boolean)
    const bodyParts = [
      '## 摘要',
      '',
      summary,
      keywords.length ? `关键词：${keywords.join('、')}` : '',
      '',
      '## 正文 / 要点',
      '',
      ...keyPoints.map((point) => `- ${oneLine(point)}`),
      '',
    ]
    if (pick.quote) bodyParts.push('## 原文摘录', '', `> ${oneLine(pick.quote)}`, '')
    bodyParts.push(
      '## 相关笔记',
      '',
      '## 待办 / 延伸问题',
      '',
      '- 待核实：原文的发布时间、作者与关键数字是否与页面一致。',
      pick.reason ? `- 收录理由：${oneLine(pick.reason)}` : '',
    )

    const content = bodyParts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    await writeText(file, `${stringifyFrontmatter(fields)}\n\n${content}\n`)
    created.push({ file: `${FOLDERS.inbox}/${path.basename(file)}`, title, url: pick.url, tags })
  }

  return {
    ok: true,
    stage: 'collect',
    summary: created.length
      ? `检索 ${raw.length} 条候选，收录 ${created.length} 篇到收件箱${usedModel ? '（模型筛选）' : '（规则筛选）'}。`
      : '没有值得收录的新内容，未新建笔记。',
    warnings,
    considered: raw.length,
    fetchedPages: rich.length,
    created,
    rejected,
    usedModel,
    ...used,
  }
}
