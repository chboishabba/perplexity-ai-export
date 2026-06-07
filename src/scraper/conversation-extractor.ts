import type { BrowserContext, Page, Response } from '@playwright/test'
import { waitStrategy } from '../utils/wait-strategy.js'
import { logger } from '../utils/logger.js'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

export interface ExtractedConversation {
  id: string
  title: string
  url: string
  spaceName: string
  timestamp: Date
  content: string
  messages: ExtractedConversationMessage[]
  rawApiResponse?: unknown
  rawEntries: unknown[]
  artifacts: ExtractedConversationArtifact[]
}

export interface ExtractedConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  index: number
  entryIndex: number
}

export interface ExtractedConversationArtifact {
  artifact_id: string
  kind: 'image' | 'binary'
  mime_type: string
  source_url: string
  local_path: string
  size_bytes: number
  sha256: string
}

interface CapturedApiResponse {
  data: any
  responseUrl: string
}

interface ThreadApiResponseCollector {
  captures: CapturedApiResponse[]
  waitForFirst(timeoutMs?: number): Promise<CapturedApiResponse | null>
  dispose(): void
}

interface ArtifactCollector {
  artifacts: ExtractedConversationArtifact[]
  dispose(): void
}

type ScrollMode = 'step' | 'end' | 'hybrid'

interface ThreadLoadDiagnostics {
  completed: boolean
  partial: boolean
  scrollMode: ScrollMode
  possibleGap: boolean
  gapReasons: string[]
  passes: number
  stablePasses: number
  capturedResponseCount: number
  uniqueEntryCount: number
  uniqueCursorCount: number
  lastApiHasNextPage: boolean | null
  lastScrollHeight: number
  lastBodyTextLength: number
  maxPasses: number
  requiredStablePasses: number
}

export class ConversationExtractor {
  private static readonly BlockSchema = z.object({
    intended_usage: z.string().optional(),
    markdown_block: z
      .object({
        answer: z.string().optional(),
      })
      .optional(),
  })

  private static readonly EntrySchema = z.object({
    thread_title: z.string().optional(),
    collection_info: z
      .object({
        title: z.string().optional(),
      })
      .optional(),
    updated_datetime: z.string().optional(),
    query_str: z.string().optional(),
    blocks: z.array(ConversationExtractor.BlockSchema).optional(),
  })

  private static readonly ApiResponseSchema = z.union([
    z.array(ConversationExtractor.EntrySchema),
    z.object({
      status: z.string().optional(),
      entries: z.array(ConversationExtractor.EntrySchema),
    }),
  ])

  static readonly ExtractionError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ExtractionError'
    }
  }
  static readonly NavigationError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'NavigationError'
    }
  }

  static readonly NotFoundError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'NotFoundError'
    }
  }

  static readonly AuthError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'AuthError'
    }
  }

  static readonly ServerError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ServerError'
    }
  }

  static readonly NoDataError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'NoDataError'
    }
  }

  static readonly ParsingError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ParsingError'
    }
  }

  private readonly context: BrowserContext

  constructor(context: BrowserContext) {
    this.context = context
  }

  async extract(url: string): Promise<ExtractedConversation> {
    await this.ensureContextIsAlive()

    let page: Page | null = null
    try {
      page = await this.context.newPage()
    } catch (_error) {
      throw new ConversationExtractor.ExtractionError(
        `Failed to create new page: ${_error instanceof Error ? _error.message : String(_error)}`
      )
    }

    const threadId = this.extractIdFromUrl(url)
    const apiCollector = this.createThreadApiResponseCollector(page, threadId)
    const artifactCollector = this.createArtifactCollector(page, threadId)

    try {
      await this.navigateToConversationUrl(page, url)

      const apiCapture = await apiCollector.waitForFirst()
      if (!apiCapture) {
        throw new ConversationExtractor.NoDataError('API response timeout or not found')
      }

      const loadDiagnostics = await this.driveThreadInfiniteLoader(page, apiCollector)
      const apiData = this.mergeCapturedConversationApiResponses(
        apiCollector.captures,
        loadDiagnostics
      )
      const parsed = this.parseConversationData(apiData, url)
      if (!parsed) {
        throw new ConversationExtractor.ParsingError('Failed to parse conversation data')
      }
      parsed.artifacts = artifactCollector.artifacts

      return parsed
    } catch (_error) {
      if (_error instanceof Error) throw _error
      throw new ConversationExtractor.ExtractionError(String(_error))
    } finally {
      apiCollector.dispose()
      artifactCollector.dispose()
      if (page) {
        await page.close().catch((e) => {
          logger.warn(`Failed to close page: ${e}`)
        })
      }
    }
  }

  private createArtifactCollector(page: Page, threadId: string): ArtifactCollector {
    const artifacts: ExtractedConversationArtifact[] = []
    const seen = new Set<string>()
    const artifactRoot = this.getArtifactRoot(threadId)

    const responseHandler = async (response: Response): Promise<void> => {
      const url = response.url()
      const headers = response.headers()
      const mimeType = (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      const kind = this.classifyArtifactResponse(url, mimeType)
      if (!kind) return
      if (seen.has(url)) return
      seen.add(url)

      try {
        const body = await response.body()
        if (body.length === 0) return

        const sha256 = createHash('sha256').update(body).digest('hex')
        if (artifacts.some((artifact) => artifact.sha256 === sha256)) return

        if (!existsSync(artifactRoot)) {
          mkdirSync(artifactRoot, { recursive: true })
        }

        const extension = this.artifactExtension(url, mimeType)
        const artifactId = `${String(artifacts.length + 1).padStart(4, '0')}-${sha256.slice(0, 16)}`
        const localPath = join(artifactRoot, `${artifactId}${extension}`)
        writeFileSync(localPath, body)
        artifacts.push({
          artifact_id: artifactId,
          kind,
          mime_type: mimeType || 'application/octet-stream',
          source_url: url,
          local_path: localPath,
          size_bytes: body.length,
          sha256,
        })
        logger.info(`Captured artifact ${artifactId}${extension} (${body.length} bytes)`)
      } catch (_error) {
        logger.warn(
          `Failed to capture artifact response: ${
            _error instanceof Error ? _error.message : String(_error)
          }`
        )
      }
    }

    page.on('response', responseHandler)

    return {
      artifacts,
      dispose: () => page.off('response', responseHandler),
    }
  }

  private getArtifactRoot(threadId: string): string {
    const configuredRoot =
      process.env['PERPLEXITY_ARTIFACT_DIR'] ??
      process.env['CHAT_ARCHIVE_ARTIFACT_DIR'] ??
      '/home/c/chat_archive_artifacts/perplexity'
    return join(configuredRoot, threadId)
  }

  private classifyArtifactResponse(
    url: string,
    mimeType: string
  ): ExtractedConversationArtifact['kind'] | null {
    if (mimeType.startsWith('image/')) return 'image'
    if (/\.(png|jpe?g|webp|gif|svg)(?:[?#]|$)/i.test(url)) return 'image'
    if (
      mimeType === 'application/octet-stream' &&
      /\.(png|jpe?g|webp|gif|svg|pdf|zip)(?:[?#]|$)/i.test(url)
    ) {
      return 'binary'
    }
    return null
  }

  private artifactExtension(url: string, mimeType: string): string {
    const mimeExtensions: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/avif': '.avif',
      'image/svg+xml': '.svg',
      'application/pdf': '.pdf',
      'application/zip': '.zip',
    }
    if (mimeExtensions[mimeType]) return mimeExtensions[mimeType]

    try {
      const parsed = new URL(url)
      const name = basename(parsed.pathname)
      const extension = extname(name)
      return extension && extension.length <= 12 ? extension : '.bin'
    } catch (_error) {
      return '.bin'
    }
  }

  private async ensureContextIsAlive(): Promise<void> {
    if (!this.context) {
      throw new ConversationExtractor.ExtractionError('Browser context is missing')
    }
    try {
      await this.context.pages()
    } catch (_error) {
      throw new ConversationExtractor.ExtractionError('Browser context is no longer available')
    }
  }

  private createThreadApiResponseCollector(
    page: Page,
    threadId: string
  ): ThreadApiResponseCollector {
    const captures: CapturedApiResponse[] = []
    const firstWaiters: Array<(capture: CapturedApiResponse | null) => void> = []

    const responseHandler = async (response: Response): Promise<void> => {
      const url = response.url()
      if (!this.isThreadDetailApiResponse(url, threadId)) return

      logger.info(`Captured thread API response: ${url}`)

      if (page.isClosed()) {
        logger.warn('Page is closed – cannot read response body')
        return
      }

      try {
        const json = await response.json()

        const parseResult = ConversationExtractor.ApiResponseSchema.safeParse(json)
        if (!parseResult.success) {
          logger.warn(`API response validation failed: ${parseResult.error.message}`)
          if (process.env['PERPLEXITY_DEBUG_RAW_RESPONSE'] === 'true') {
            writeFileSync(
              `/tmp/perplexity-thread-${threadId}.raw.json`,
              JSON.stringify(json, null, 2),
              'utf-8'
            )
          }
        }

        const capture = { data: json, responseUrl: url }
        captures.push(capture)
        while (firstWaiters.length > 0) {
          firstWaiters.shift()?.(capture)
        }
      } catch (_error) {
        logger.error(`Failed to parse JSON from thread API: ${_error}`)
      }
    }

    page.on('response', responseHandler)

    return {
      captures,
      waitForFirst: (timeoutMs = 30000) =>
        new Promise((resolve) => {
          if (captures.length > 0) {
            resolve(captures[0]!)
            return
          }
          const timeout = setTimeout(() => {
            logger.warn('API response timeout – resolving with null')
            const waiterIndex = firstWaiters.indexOf(resolve)
            if (waiterIndex >= 0) firstWaiters.splice(waiterIndex, 1)
            resolve(null)
          }, timeoutMs)
          firstWaiters.push((capture) => {
            clearTimeout(timeout)
            resolve(capture)
          })
        }),
      dispose: () => {
        page.off('response', responseHandler)
        while (firstWaiters.length > 0) {
          firstWaiters.shift()?.(null)
        }
      },
    }
  }

  private async driveThreadInfiniteLoader(
    page: Page,
    apiCollector: ThreadApiResponseCollector
  ): Promise<ThreadLoadDiagnostics> {
    await waitStrategy.afterScroll(page)

    const maxPasses = this.getPositiveIntegerEnv('PERPLEXITY_MAX_SCROLL_PASSES', 260)
    const requiredStablePasses = this.getPositiveIntegerEnv('PERPLEXITY_STABLE_SCROLL_PASSES', 8)
    const scrollMode = this.getScrollMode()
    let stablePasses = 0
    let previousEntryCount = -1
    let previousResponseCount = -1
    let previousScrollHeight = -1
    let previousBodyTextLength = -1
    let lastScrollHeight = 0
    let lastBodyTextLength = 0
    let completed = false
    let pass = 0

    for (pass = 1; pass <= maxPasses; pass++) {
      await this.clickShowMoreControls(page)
      const scrollState = await this.scrollThreadContainerTowardEnd(page, scrollMode, pass)
      await this.waitForApiCollectorToSettle(
        apiCollector,
        this.getPositiveIntegerEnv('PERPLEXITY_RESPONSE_QUIET_MS', 700),
        this.getPositiveIntegerEnv('PERPLEXITY_RESPONSE_MAX_WAIT_MS', 5000)
      )

      const uniqueEntryCount = this.countUniqueCapturedEntries(apiCollector.captures)
      const responseCount = apiCollector.captures.length
      lastScrollHeight = scrollState.scrollHeight
      lastBodyTextLength = scrollState.bodyTextLength

      const isStable =
        uniqueEntryCount === previousEntryCount &&
        responseCount === previousResponseCount &&
        lastScrollHeight === previousScrollHeight &&
        lastBodyTextLength === previousBodyTextLength &&
        scrollState.atEnd

      stablePasses = isStable ? stablePasses + 1 : 0

      if (pass === 1 || pass % 10 === 0 || !isStable) {
        logger.info(
          `Perplexity loader pass ${pass}: entries=${uniqueEntryCount}, responses=${responseCount}, scroll=${scrollState.scrollTop}/${scrollState.scrollHeight}, stable=${stablePasses}/${requiredStablePasses}`
        )
      }

      if (stablePasses >= requiredStablePasses) {
        completed = true
        break
      }

      previousEntryCount = uniqueEntryCount
      previousResponseCount = responseCount
      previousScrollHeight = lastScrollHeight
      previousBodyTextLength = lastBodyTextLength
    }

    const uniqueEntryCount = this.countUniqueCapturedEntries(apiCollector.captures)
    const lastApiData = apiCollector.captures.at(-1)?.data
    const lastApiHasNextPage =
      typeof lastApiData?.has_next_page === 'boolean' ? lastApiData.has_next_page : null
    const coverage = this.assessCapturedPageContinuity(apiCollector.captures, scrollMode)
    completed = completed && lastApiHasNextPage !== true
    const partial = !completed || coverage.possibleGap

    return {
      completed: !partial,
      partial,
      scrollMode,
      possibleGap: coverage.possibleGap,
      gapReasons: coverage.gapReasons,
      passes: pass,
      stablePasses,
      capturedResponseCount: apiCollector.captures.length,
      uniqueEntryCount,
      uniqueCursorCount: this.countUniqueCapturedCursors(apiCollector.captures),
      lastApiHasNextPage,
      lastScrollHeight,
      lastBodyTextLength,
      maxPasses,
      requiredStablePasses,
    }
  }

  private async clickShowMoreControls(page: Page): Promise<void> {
    const showMore = page.getByRole('button', { name: /show more/i }).first()
    if ((await showMore.count().catch(() => 0)) === 0) return
    await showMore.click({ timeout: 1000 }).catch(() => {})
  }

  private async scrollThreadContainerTowardEnd(
    page: Page,
    scrollMode: ScrollMode,
    pass: number
  ): Promise<{
    found: boolean
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    atEnd: boolean
    bodyTextLength: number
  }> {
    return await page.evaluate(
      ({ scrollMode, pass }) => {
        const explicit = document.querySelector<HTMLElement>('.scrollable-container')
        const scrollables = Array.from(document.querySelectorAll<HTMLElement>('body, main, div'))
          .filter((element) => element.scrollHeight > element.clientHeight + 40)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)
        const target = explicit ?? scrollables[0] ?? document.scrollingElement

        if (!target) {
          return {
            found: false,
            scrollTop: 0,
            scrollHeight: 0,
            clientHeight: 0,
            atEnd: true,
            bodyTextLength: document.body?.innerText?.length ?? 0,
          }
        }

        const before = target.scrollTop
        const step = Math.max(target.clientHeight * 6, 4800)
        const effectiveMode = scrollMode === 'hybrid' && pass % 6 === 0 ? 'end' : 'step'
        target.scrollTop =
          effectiveMode === 'step'
            ? Math.min(target.scrollHeight, before + step)
            : target.scrollHeight
        target.dispatchEvent(new Event('scroll', { bubbles: true }))
        window.dispatchEvent(new Event('scroll'))

        const atEnd = target.scrollTop + target.clientHeight >= target.scrollHeight - 16
        return {
          found: true,
          scrollTop: target.scrollTop,
          scrollHeight: target.scrollHeight,
          clientHeight: target.clientHeight,
          atEnd,
          bodyTextLength: document.body?.innerText?.length ?? 0,
        }
      },
      { scrollMode, pass }
    )
  }

  private async waitForApiCollectorToSettle(
    apiCollector: ThreadApiResponseCollector,
    quietMs: number,
    maxMs: number
  ): Promise<void> {
    const startedAt = Date.now()
    let lastCount = apiCollector.captures.length
    let stableSince = Date.now()

    while (Date.now() - startedAt < maxMs) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const currentCount = apiCollector.captures.length
      if (currentCount !== lastCount) {
        lastCount = currentCount
        stableSince = Date.now()
      }
      if (Date.now() - stableSince >= quietMs) {
        return
      }
    }
  }

  private mergeCapturedConversationApiResponses(
    captures: CapturedApiResponse[],
    diagnostics: ThreadLoadDiagnostics
  ): any {
    const firstData = captures[0]?.data
    const lastData = captures.at(-1)?.data
    const base = firstData && !Array.isArray(firstData) ? { ...firstData } : {}
    const entries: any[] = []
    const seen = new Set<string>()

    for (const capture of captures) {
      for (const entry of this.ensureEntriesFormat(capture.data)) {
        const key = this.getEntryIdentity(entry)
        if (seen.has(key)) continue
        seen.add(key)
        entries.push(entry)
      }
    }

    return {
      ...base,
      entries,
      has_next_page: diagnostics.partial,
      source_has_next_page:
        typeof lastData?.has_next_page === 'boolean' ? lastData.has_next_page : undefined,
      next_cursor: diagnostics.partial ? lastData?.next_cursor : null,
      captured_response_urls: captures.map((capture) => capture.responseUrl),
      extraction: diagnostics,
    }
  }

  private getPositiveIntegerEnv(name: string, fallback: number): number {
    const rawValue = process.env[name]
    if (!rawValue) return fallback

    const parsed = Number.parseInt(rawValue, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  private getScrollMode(): ScrollMode {
    const rawValue = (process.env['PERPLEXITY_SCROLL_MODE'] ?? 'step').toLowerCase()
    return rawValue === 'end' || rawValue === 'hybrid' || rawValue === 'step' ? rawValue : 'step'
  }

  private assessCapturedPageContinuity(
    captures: CapturedApiResponse[],
    scrollMode: ScrollMode
  ): { possibleGap: boolean; gapReasons: string[] } {
    const gapReasons: string[] = []

    if (scrollMode === 'end' && captures.length > 1) {
      gapReasons.push('end-scroll mode can jump across virtual-scroll loader boundaries')
    }

    const offsetPages = captures
      .map((capture) => {
        try {
          const parsedUrl = new URL(capture.responseUrl)
          const offset = parsedUrl.searchParams.get('offset')
          return offset === null
            ? null
            : {
                offset: Number.parseInt(offset, 10),
                entryCount: this.ensureEntriesFormat(capture.data).length,
              }
        } catch (_error) {
          return null
        }
      })
      .filter(
        (page): page is { offset: number; entryCount: number } =>
          page !== null && Number.isFinite(page.offset) && page.offset >= 0
      )
      .sort((a, b) => a.offset - b.offset)

    for (let index = 1; index < offsetPages.length; index++) {
      const previous = offsetPages[index - 1]!
      const current = offsetPages[index]!
      if (current.offset > previous.offset + previous.entryCount) {
        gapReasons.push(
          `offset gap between ${previous.offset} and ${current.offset}; middle API page may be missing`
        )
        break
      }
    }

    return { possibleGap: gapReasons.length > 0, gapReasons }
  }

  private countUniqueCapturedEntries(captures: CapturedApiResponse[]): number {
    const seen = new Set<string>()
    for (const capture of captures) {
      for (const entry of this.ensureEntriesFormat(capture.data)) {
        seen.add(this.getEntryIdentity(entry))
      }
    }
    return seen.size
  }

  private countUniqueCapturedCursors(captures: CapturedApiResponse[]): number {
    const cursors = new Set<string>()
    for (const capture of captures) {
      try {
        const parsedUrl = new URL(capture.responseUrl)
        const cursor = parsedUrl.searchParams.get('cursor')
        if (cursor) cursors.add(cursor)
      } catch (_error) {
        // Ignore malformed diagnostic URLs.
      }
    }
    return cursors.size
  }

  async fetchAllConversationPages(
    page: Page,
    firstPageData: any,
    firstPageUrl: string
  ): Promise<any> {
    if (!this.shouldFetchNextPage(firstPageData)) {
      return firstPageData
    }

    const firstEntries = this.ensureEntriesFormat(firstPageData)
    const allEntries = [...firstEntries]
    let currentPageData = firstPageData
    const maxPages = 100
    const seenEntryKeys = new Set(firstEntries.map((entry) => this.getEntryIdentity(entry)))

    for (
      let pageIndex = 1;
      pageIndex < maxPages && this.shouldFetchNextPage(currentPageData);
      pageIndex++
    ) {
      const nextCursor = this.getNextCursor(currentPageData)
      if (!nextCursor) {
        logger.warn('Thread API reported another page but did not provide a next_cursor')
        break
      }

      let nextPageData = await this.fetchConversationPageAfterCursor(page, firstPageUrl, nextCursor)
      if (!nextPageData) {
        nextPageData = await this.fetchConversationPageAtOffset(
          page,
          firstPageUrl,
          allEntries.length
        )
        if (!nextPageData) {
          logger.warn('Could not fetch additional conversation page; using partial thread data')
          break
        }
      }

      const nextEntries = this.ensureEntriesFormat(nextPageData)
      if (nextEntries.length === 0) {
        break
      }

      const newEntries = nextEntries.filter((entry) => {
        const key = this.getEntryIdentity(entry)
        if (seenEntryKeys.has(key)) return false
        seenEntryKeys.add(key)
        return true
      })
      if (newEntries.length === 0) {
        nextPageData = await this.fetchConversationPageAtOffset(
          page,
          firstPageUrl,
          allEntries.length
        )
        if (!nextPageData) {
          logger.warn(
            'Conversation pagination returned only duplicate entries; stopping pagination'
          )
          break
        }
        const offsetEntries = this.ensureEntriesFormat(nextPageData)
        const offsetNewEntries = offsetEntries.filter((entry) => {
          const key = this.getEntryIdentity(entry)
          if (seenEntryKeys.has(key)) return false
          seenEntryKeys.add(key)
          return true
        })
        if (offsetNewEntries.length === 0) {
          logger.warn(
            'Conversation pagination returned only duplicate entries; stopping pagination'
          )
          break
        }
        allEntries.push(...offsetNewEntries)
        currentPageData = nextPageData
        continue
      }

      allEntries.push(...newEntries)
      currentPageData = nextPageData
    }

    if (allEntries.length === firstEntries.length) {
      return firstPageData
    }

    logger.info(`Fetched ${allEntries.length} thread entries across paginated API responses`)
    return {
      ...firstPageData,
      entries: allEntries,
      has_next_page: this.shouldFetchNextPage(currentPageData),
      next_cursor: currentPageData?.next_cursor,
    }
  }

  private shouldFetchNextPage(data: any): boolean {
    return !!(
      data &&
      typeof data === 'object' &&
      data.has_next_page === true &&
      Array.isArray(data.entries) &&
      data.entries.length > 0
    )
  }

  private getNextCursor(data: any): string | null {
    return typeof data?.next_cursor === 'string' && data.next_cursor.length > 0
      ? data.next_cursor
      : null
  }

  private getEntryIdentity(entry: any): string {
    for (const key of ['uuid', 'frontend_uuid', 'entry_uuid']) {
      const value = entry?.[key]
      if (typeof value === 'string' && value.length > 0) {
        return `${key}:${value}`
      }
    }

    const createdAt = entry?.entry_created_datetime ?? entry?.created_at ?? entry?.updated_datetime
    const query = typeof entry?.query_str === 'string' ? entry.query_str : ''
    return `fallback:${createdAt ?? ''}:${query}`
  }

  private async fetchConversationPageAfterCursor(
    page: Page,
    firstPageUrl: string,
    cursor: string
  ): Promise<any | null> {
    try {
      return await page.evaluate(
        async ({ firstPageUrl, cursor }) => {
          const nextUrl = new URL(firstPageUrl)
          nextUrl.searchParams.delete('offset')
          nextUrl.searchParams.set('from_first', 'false')
          nextUrl.searchParams.set('cursor', cursor)
          const response = await fetch(nextUrl.toString(), {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' },
          })
          if (!response.ok) {
            return null
          }
          return response.json()
        },
        { firstPageUrl, cursor }
      )
    } catch (_error) {
      return null
    }
  }

  private async fetchConversationPageAtOffset(
    page: Page,
    firstPageUrl: string,
    offset: number
  ): Promise<any | null> {
    try {
      return await page.evaluate(
        async ({ firstPageUrl, offset }) => {
          const candidateUrls = [true, false].map((fromFirst) => {
            const nextUrl = new URL(firstPageUrl)
            nextUrl.searchParams.delete('cursor')
            nextUrl.searchParams.set('offset', String(offset))
            nextUrl.searchParams.set('from_first', String(fromFirst))
            return nextUrl.toString()
          })

          for (const url of candidateUrls) {
            const response = await fetch(url, {
              method: 'GET',
              credentials: 'include',
              headers: { Accept: 'application/json' },
            })
            if (response.ok) {
              return response.json()
            }
          }
          return null
        },
        { firstPageUrl, offset }
      )
    } catch (_error) {
      return null
    }
  }

  private isThreadDetailApiResponse(responseUrl: string, threadId: string): boolean {
    if (!threadId || threadId === 'unknown') return false

    try {
      const parsedUrl = new URL(responseUrl)
      const expectedPath = `/rest/thread/${threadId}`
      return parsedUrl.hostname.endsWith('perplexity.ai') && parsedUrl.pathname === expectedPath
    } catch (_error) {
      return false
    }
  }

  private async navigateToConversationUrl(page: Page, url: string): Promise<void> {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })

    this.validateNavigationResponse(response)
  }

  private validateNavigationResponse(response: Response | null): void {
    if (!response) {
      throw new ConversationExtractor.NavigationError('Navigation failed – no response')
    }

    const status = response.status()
    if (status === 404) {
      throw new ConversationExtractor.NotFoundError('Conversation not found (404)')
    }
    if (status === 403 || status === 401) {
      throw new ConversationExtractor.AuthError('Authentication required or expired')
    }
    if (status >= 500) {
      throw new ConversationExtractor.ServerError(`Server error (${status})`)
    }
    if (status >= 400) {
      throw new ConversationExtractor.NavigationError(`HTTP error ${status}`)
    }
  }

  private parseConversationData(data: any, url: string): ExtractedConversation | null {
    try {
      const entries = this.ensureEntriesFormat(data)

      const parseResult = z
        .array(ConversationExtractor.EntrySchema)
        .nonempty({ message: 'No valid entries found' })
        .safeParse(entries)

      if (!parseResult.success) {
        logger.warn(`Entry validation failed for ${url}: ${parseResult.error.message}`)
        return null
      }

      const validEntries = parseResult.data
      const firstEntry = validEntries[0]!
      const id = this.extractIdFromUrl(url)
      const title = firstEntry.thread_title ?? data.thread_title ?? 'Untitled'
      const spaceName =
        firstEntry.collection_info?.title ?? data.collection_info?.title ?? 'General'
      const timestamp = this.extractTimestamp(firstEntry, data)
      const content = this.convertEntriesToMarkdown(validEntries, title)
      const messages = this.normalizeEntriesToMessages(validEntries, title)

      if (!content && messages.length === 0) {
        logger.warn(`Thread has empty content after formatting: ${url}`)
        return null
      }

      return {
        id,
        title,
        url,
        spaceName,
        timestamp,
        content,
        messages,
        rawApiResponse: data,
        rawEntries: validEntries,
        artifacts: [],
      }
    } catch (_error) {
      logger.error('Failed to parse conversation data.')
      return null
    }
  }

  private ensureEntriesFormat(data: any): any[] {
    if (Array.isArray(data)) {
      return data
    }
    if (Array.isArray(data.entries) && data.entries.length > 0) {
      return data.entries
    }
    if (data && (data.query_str || data.blocks)) {
      return [data]
    }
    return []
  }

  private extractIdFromUrl(url: string): string {
    const match = url.match(/\/search\/([^/?]+)/)
    return match?.[1] ?? 'unknown'
  }

  private extractTimestamp(firstEntry: any, data: any): Date {
    const ts = firstEntry.updated_datetime ?? data.updated_datetime
    return ts ? new Date(ts) : new Date()
  }

  private convertEntriesToMarkdown(entries: any[], threadTitle: string): string {
    let markdown = ''

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      let question = entry.query_str ?? ''

      if (!question) {
        if (i === 0) {
          question = threadTitle
        } else {
          question = 'Follow‑up'
        }
      }

      let fullAnswer = ''
      for (const block of entry.blocks ?? []) {
        if (block.markdown_block?.answer) {
          fullAnswer += block.markdown_block.answer + '\n\n'
        }
      }

      if (question) {
        markdown += `## ${question}\n\n`
      }
      if (fullAnswer) {
        markdown += `${fullAnswer.trim()}\n\n`
      }
      markdown += '---\n\n'
    }

    return markdown.trim()
  }

  private normalizeEntriesToMessages(
    entries: any[],
    threadTitle: string
  ): ExtractedConversationMessage[] {
    const messages: ExtractedConversationMessage[] = []

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex]
      const question = this.extractQuestionText(entry, threadTitle, entryIndex)
      const answer = this.extractAnswerText(entry)

      if (question) {
        messages.push({
          id: `${this.getStableEntryMessagePrefix(entry, entryIndex)}:user`,
          role: 'user',
          content: question,
          index: messages.length,
          entryIndex,
        })
      }

      if (answer) {
        messages.push({
          id: `${this.getStableEntryMessagePrefix(entry, entryIndex)}:assistant`,
          role: 'assistant',
          content: answer,
          index: messages.length,
          entryIndex,
        })
      }
    }

    return messages
  }

  private getStableEntryMessagePrefix(entry: any, entryIndex: number): string {
    const identity = this.getEntryIdentity(entry)
    if (!identity.startsWith('fallback:')) {
      return identity
    }

    const question = typeof entry?.query_str === 'string' ? entry.query_str : ''
    const answer = this.extractAnswerText(entry)
    const digest = createHash('sha1').update(`${question}\n\n${answer}`).digest('hex').slice(0, 16)
    return `entry:${entryIndex + 1}:${digest}`
  }

  private extractQuestionText(entry: any, threadTitle: string, entryIndex: number): string {
    if (entry.query_str) return entry.query_str
    return entryIndex === 0 ? threadTitle : 'Follow-up'
  }

  private extractAnswerText(entry: any): string {
    return (entry.blocks ?? [])
      .map((block: any) => block.markdown_block?.answer)
      .filter(
        (answer: unknown): answer is string => typeof answer === 'string' && answer.length > 0
      )
      .join('\n\n')
      .trim()
  }
}
