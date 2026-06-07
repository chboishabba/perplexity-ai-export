import { resolve } from 'node:path'
import { BrowserManager } from './scraper/browser.js'
import { ConversationExtractor } from './scraper/conversation-extractor.js'
import { FileWriter } from './export/file-writer.js'
import { logger } from './utils/logger.js'

interface CliOptions {
  url: string
  out?: string
  json: boolean
}

function usage(): string {
  return [
    'Usage: npm run export:thread -- --url <perplexity-url> [--out <file>] [--json]',
    '',
    'Exports one Perplexity thread as itir.perplexity.thread.v1 JSON.',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = { json: false }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--url') {
      const value = argv[++index]
      if (!value) throw new Error('--url requires a value')
      options.url = value
    } else if (arg === '--out') {
      const value = argv[++index]
      if (!value) throw new Error('--out requires a value')
      options.out = value
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!options.url) {
    throw new Error('--url is required')
  }

  return options as CliOptions
}

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage())
    process.exitCode = 2
    return
  }

  const browserManager = new BrowserManager()
  try {
    const page = await browserManager.launch()
    const extractor = new ConversationExtractor(page.context())
    const conversation = await extractor.extract(options.url)
    const writer = new FileWriter()
    const written = options.out
      ? writer.writeStructuredJsonToPath(conversation, resolve(options.out))
      : writer.write(conversation)

    const payload = {
      ok: true,
      source: 'perplexity',
      source_thread_id: conversation.id,
      title: conversation.title,
      output_path: written.structuredJsonPath ?? written.primaryPath,
      markdown_path: written.markdownPath,
      message_count: conversation.messages.length,
    }

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      logger.success(`Exported ${conversation.id} to ${payload.output_path}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const payload = {
      ok: false,
      error: message,
      hint: 'Perplexity export requires a usable Playwright browser session. If login or Cloudflare blocks this run, refresh the saved auth state in perplexity-ai-export.',
    }
    if (options.json) {
      console.error(JSON.stringify(payload, null, 2))
    } else {
      logger.error(payload.error)
      logger.error(payload.hint)
    }
    process.exitCode = 1
  } finally {
    await browserManager.close()
  }
}

main()
