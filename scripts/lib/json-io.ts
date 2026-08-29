import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'

/**
 * Every data file is read through its zod schema and written back
 * pretty-printed with two spaces (PLAN.md §4 step 9). The point is diff
 * readability: a run's commit should show what actually changed, not a
 * reflowed blob.
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DATA_DIR = path.join(REPO_ROOT, 'data')
export const PUBLIC_DIR = path.join(REPO_ROOT, 'public')

export function dataPath(...segments: string[]): string {
  return path.join(DATA_DIR, ...segments)
}

export async function readJsonFile<T>(absolute: string, schema: z.ZodType<T>): Promise<T> {
  const relative = path.relative(REPO_ROOT, absolute).replace(/\\/g, '/')

  let raw: string
  try {
    raw = await readFile(absolute, 'utf8')
  } catch {
    throw new Error(`missing file: ${relative}`)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${relative} is not valid JSON: ${(error as Error).message}`)
  }

  const result = schema.safeParse(json)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `    ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`${relative} failed schema validation:\n${detail}`)
  }

  return result.data
}

/**
 * Write via a temp file + rename so an interrupted run can never leave a
 * half-written run.json behind — the next run's preflight would see a dirty
 * tree it cannot explain.
 */
export async function writeJsonFile(absolute: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(absolute), { recursive: true })
  const temp = `${absolute}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, absolute)
}

/** Record maps (ledger listings, suburb profiles) are key-sorted so run diffs stay minimal. */
export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  )
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** ISO 8601 UTC to whole seconds — the format every timestamp field in §3 expects. */
export function isoNow(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`
}
