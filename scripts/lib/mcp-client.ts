import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { PACKAGE_ROOT } from './json-io'

/**
 * A minimal MCP stdio client for the realestate server.
 *
 * The server exposes no batch CLI and the SDK is not a dependency here, but the
 * protocol over stdio is a few lines of JSON-RPC. Shared by `capture-run.ts` and
 * `audit-postcodes.ts` so there is one handshake and one parser to get right.
 *
 * It spawns its **own** server instance. Browser-backed tools take an exclusive
 * lock on the Chrome profile, so do not run two of those at once;
 * `resolve_location` needs no browser and is safe alongside anything.
 */

/**
 * The compiled server, resolved as a sibling of this repo rather than hardcoded.
 *
 * It was an absolute `E:/Personal Projects/...` path, which is why nothing but
 * the Windows machine could run any part of the pipeline. The two repos are
 * checked out side by side on both machines it lives on — `E:/Personal
 * Projects/{SydneyRealEstateFindings,RealEstateMCP}` and
 * `~/Documents/Programming/{...}` — so one relative hop resolves correctly on
 * each, and `REALESTATE_MCP_ENTRY` covers any layout that does not.
 *
 * Note it is `dist/`, not `src/`: the server runs compiled JS, so a change to
 * its source does nothing here until it is rebuilt.
 */
const SERVER_ENTRY =
  process.env.REALESTATE_MCP_ENTRY?.trim() ||
  path.join(PACKAGE_ROOT, 'dist', 'index.js')
const CALL_TIMEOUT_MS = 180_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''

  /**
   * Takes no keys. The server reads its own configuration — `GOOGLE_MAPS_API_KEY`,
   * `TFNSW_API_KEY`, the router and geocoder choices — from a `.env` at its own
   * package root, and this repo holds none of them (docs/adr/0004).
   *
   * This used to open `~/.claude.json`, lift the `realestate` entry's `env` out
   * of it and hand it over, so the pipeline had to know the server's whole
   * configuration in order to start it. That file only ever applied when *Claude
   * Code* spawned the server, which is exactly why this had to imitate it; a
   * `.env` at the package root is read whoever starts the process, so the two
   * spawn paths finally agree.
   */
  constructor() {
    if (!existsSync(SERVER_ENTRY)) {
      // Spawning it anyway gets "Cannot find module" on the child's stderr,
      // which the filter below may or may not surface. Say it here instead.
      throw new Error(
        `no compiled MCP server at ${SERVER_ENTRY}\n` +
          `  Build it there (npm install && npm run build), or set REALESTATE_MCP_ENTRY ` +
          `to its dist/index.js.`,
      )
    }
    this.child = spawn(process.execPath, [SERVER_ENTRY], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    // The server logs to stderr; surface only real failures, not its chatter.
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (/error|refus|blocked|bot protection/i.test(text)) console.error(`   [server] ${text}`)
    })
  }

  private onData(chunk: string) {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(line)
      } catch {
        continue // not a JSON-RPC frame; the server also prints plain logs
      }
      if (message.id == null) continue
      const waiting = this.pending.get(message.id)
      if (!waiting) continue
      this.pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.error) waiting.reject(new Error(message.error.message ?? 'MCP error'))
      else waiting.resolve(message.result)
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${CALL_TIMEOUT_MS}ms`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  notify(method: string, params?: unknown) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async handshake() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'capture-run', version: '1.0.0' },
    })
    this.notify('notifications/initialized')
  }

  /** Call a tool and parse the JSON the server puts in its text content block. */
  private async callRaw(name: string, args: unknown): Promise<unknown> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    const text = result.content?.find((c) => c.type === 'text')?.text ?? ''
    if (result.isError) throw new Error(text.slice(0, 400))
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`tool ${name} returned non-JSON: ${text.slice(0, 400)}`)
    }
  }

  async callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
    return (await this.callRaw(name, args)) as Record<string, unknown>
  }

  /** Same as `callTool`, for tools whose payload is a JSON array. */
  async callToolArray(name: string, args: unknown): Promise<unknown[]> {
    const parsed = await this.callRaw(name, args)
    if (!Array.isArray(parsed)) throw new Error(`tool ${name} did not return an array`)
    return parsed
  }

  close() {
    this.child.stdin.end()
    this.child.kill()
  }
}
