import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileWriter } from '../../src/export/file-writer.js'
import type { ExtractedConversation } from '../../src/scraper/conversation-extractor.js'
import { config } from '../../src/utils/config.js'

function sampleConversation(): ExtractedConversation {
  return {
    id: 'thread-123',
    title: 'Test Thread',
    url: 'https://www.perplexity.ai/search/thread-123',
    spaceName: 'Research Space',
    timestamp: new Date('2026-05-15T10:00:00.000Z'),
    content: '## What is the plan?\n\nA structured export.\n\n---',
    messages: [
      {
        id: '1-user',
        role: 'user',
        content: 'What is the plan?',
        index: 0,
        entryIndex: 0,
      },
      {
        id: '1-assistant',
        role: 'assistant',
        content: 'A structured export.',
        index: 1,
        entryIndex: 0,
      },
    ],
    artifacts: [
      {
        artifact_id: '0001-deadbeef',
        kind: 'image',
        mime_type: 'image/png',
        source_url: 'https://example.test/image.png',
        local_path: '/home/c/chat_archive_artifacts/perplexity/thread-123/0001-deadbeef.png',
        size_bytes: 1234,
        sha256: 'deadbeef',
      },
    ],
    rawApiResponse: { entries: [{ query_str: 'What is the plan?' }] },
    rawEntries: [{ query_str: 'What is the plan?' }],
  }
}

describe('FileWriter', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'perplexity-writer-'))
    config.exportDir = join(root, 'markdown')
    config.structuredExportDir = join(root, 'structured')
    config.exportStructuredJson = true
    config.exportMarkdown = false
  })

  it('writes structured ITIR JSON by default without Markdown', () => {
    const writer = new FileWriter()
    const written = writer.write(sampleConversation())

    expect(written.primaryPath).toBe(written.structuredJsonPath)
    expect(written.markdownPath).toBeUndefined()
    expect(written.structuredJsonPath).toBeTruthy()
    expect(existsSync(written.structuredJsonPath!)).toBe(true)

    const artifact = JSON.parse(readFileSync(written.structuredJsonPath!, 'utf-8'))
    expect(artifact.schema).toBe('itir.perplexity.thread.v1')
    expect(written.structuredJsonPath).toContain('.itir.perplexity.json')
    expect(artifact.source_thread_id).toBe('thread-123')
    expect(artifact.space).toBe('Research Space')
    expect(artifact.url).toBe('https://www.perplexity.ai/search/thread-123')
    expect(artifact.messages).toHaveLength(2)
    expect(artifact.messages[0].source_message_id).toBe('1-user')
    expect(artifact.artifacts).toHaveLength(1)
    expect(artifact.artifacts[0].local_path).toContain('chat_archive_artifacts')
    expect(artifact.raw.entries).toEqual([{ query_str: 'What is the plan?' }])
  })

  it('preserves Markdown output when enabled', () => {
    config.exportMarkdown = true
    const writer = new FileWriter()
    const written = writer.write(sampleConversation())

    expect(written.structuredJsonPath).toBeTruthy()
    expect(written.markdownPath).toBeTruthy()
    expect(existsSync(written.markdownPath!)).toBe(true)

    const markdown = readFileSync(written.markdownPath!, 'utf-8')
    expect(markdown).toContain('# Test Thread')
    expect(markdown).toContain('**Space:** Research Space')
    expect(markdown).toContain('## What is the plan?')
  })

  it('writes structured ITIR JSON to an explicit resolver path', () => {
    const writer = new FileWriter()
    const outPath = join(root, 'resolver', 'thread-123.itir.perplexity.json')
    const written = writer.writeStructuredJsonToPath(sampleConversation(), outPath)

    expect(written.primaryPath).toBe(outPath)
    expect(written.structuredJsonPath).toBe(outPath)
    expect(written.markdownPath).toBeUndefined()
    expect(existsSync(outPath)).toBe(true)

    const artifact = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(artifact.schema).toBe('itir.perplexity.thread.v1')
    expect(artifact.source_thread_id).toBe('thread-123')
  })
})
