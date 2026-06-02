/**
 * Story Generation Module
 *
 * Picks N diverse images (one per ZIP if possible), extracts them,
 * generates a collage, and creates a fictional story using Claude Code.
 *
 * Story provider architecture:
 *   1. Claude Code CLI (if available, with image paths)
 *   2. Image-metadata prompt → Claude Code CLI (text-only fallback)
 *   3. Basic generated story (no-Claude fallback)
 */

import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js"
import { mkdir, readdir, stat, rm } from "fs/promises"
import { spawn } from "child_process"
import sharp from "sharp"
import { join, extname } from "path"

// ─── Config ───────────────────────────────────────────────────────

const ZIP_DIR = process.env.ZIP_DIR || "./zips"
const TEMP_DIR = process.env.STORY_TEMP_DIR || "/app/tmp/stories"
export const STORY_IMAGE_COUNT = parseInt(process.env.STORY_IMAGE_COUNT || "9", 10)
const COLLAGE_TILE = 400 // slightly smaller tiles for the story collage (more images)
const COLLAGE_QUALITY = 90
const CLAUDE_TIMEOUT_MS = 60_000 // 60s max for story generation

// ─── Types ────────────────────────────────────────────────────────

export interface StoryImage {
  zipName: string
  entryPath: string
  /** Absolute path to extracted temp file */
  extractedPath: string
}

export interface StoryResult {
  story: string
  /** Base64-encoded JPEG collage */
  collageBase64: string
  /** Image identifiers used */
  images: Array<{ zip: string; path: string }>
  /** Which provider generated the story */
  provider: "claude-code" | "claude-text" | "generated"
}

// ─── Helpers ──────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"])

function isImageFile(p: string): boolean {
  const dot = p.toLowerCase().lastIndexOf(".")
  return dot !== -1 && IMAGE_EXTS.has(p.slice(dot))
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Safe filename (no path traversal, no weird chars) */
function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
}

// ─── ZIP scanning (reuses same pattern from index.ts) ─────────────

export async function getZipIndex(zipName: string): Promise<string[] | null> {
  const zipPath = join(ZIP_DIR, zipName)
  try {
    await stat(zipPath)
  } catch {
    return null
  }
  try {
    const reader = new ZipReader(new BlobReader(Bun.file(zipPath)))
    const entries = await reader.getEntries()
    await reader.close()
    return entries
      .filter((e) => !e.directory && isImageFile(e.filename))
      .map((e) => e.filename)
  } catch {
    return null
  }
}

export async function listZipFiles(): Promise<string[]> {
  try {
    const entries = await readdir(ZIP_DIR)
    return entries.filter((e) => e.toLowerCase().endsWith(".zip")).sort()
  } catch {
    return []
  }
}

export async function readZipEntry(zipPath: string, entryPath: string): Promise<Uint8Array | null> {
  try {
    const reader = new ZipReader(new BlobReader(Bun.file(zipPath)))
    const entries = await reader.getEntries()
    const target = entries.find((e) => e.filename === entryPath)
    if (!target) {
      await reader.close()
      return null
    }
    const blob = await target.getData(new BlobWriter())
    await reader.close()
    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    return null
  }
}

// ─── Image selection: maximise diversity across ZIPs ─────────────

export async function pickDiverseImages(count: number): Promise<Array<{ zipName: string; entryPath: string }>> {
  const zipFiles = await listZipFiles()
  if (zipFiles.length === 0) return []

  // Build indices for all ZIPs
  const indices = new Map<string, string[]>()
  for (const z of zipFiles) {
    const entries = await getZipIndex(z)
    if (entries && entries.length > 0) {
      indices.set(z, entries)
    }
  }

  if (indices.size === 0) return []

  const result: Array<{ zipName: string; entryPath: string }> = []
  const usedZips = new Set<string>()
  const availableZips = [...indices.keys()]

  // Round 1: pick one image from each zip (round-robin, shuffled)
  const shuffledZips = shuffleArray(availableZips)
  for (const zipName of shuffledZips) {
    if (result.length >= count) break
    const entries = indices.get(zipName)!
    const pick = entries[Math.floor(Math.random() * entries.length)]
    result.push({ zipName, entryPath: pick })
    usedZips.add(zipName)
  }

  // Round 2: if we still need more, pick from any zip
  if (result.length < count) {
    const allRemaining: Array<{ zipName: string; entryPath: string }> = []
    for (const [zipName, entries] of indices) {
      for (const entryPath of entries) {
        // Avoid exact duplicates
        if (!result.some((r) => r.zipName === zipName && r.entryPath === entryPath)) {
          allRemaining.push({ zipName, entryPath })
        }
      }
    }
    const shuffled = shuffleArray(allRemaining)
    const needed = count - result.length
    result.push(...shuffled.slice(0, needed))
  }

  return result
}

// ─── Extract images to temp ──────────────────────────────────────

export async function extractImages(
  images: Array<{ zipName: string; entryPath: string }>,
  sessionId: string,
): Promise<StoryImage[]> {
  const dir = join(TEMP_DIR, sessionId)
  await mkdir(dir, { recursive: true })

  const result: StoryImage[] = []

  for (const { zipName, entryPath } of images) {
    const zipPath = join(ZIP_DIR, zipName)
    const bytes = await readZipEntry(zipPath, entryPath)
    if (!bytes) continue

    // Determine extension from the entry path
    const ext = extname(entryPath) || ".jpg"
    const safeName = safeFilename(entryPath.replace(/\//g, "_"))
    const outPath = join(dir, `${result.length}_${safeName}`)

    await Bun.write(outPath, bytes)
    result.push({ zipName, entryPath, extractedPath: outPath })
  }

  return result
}

// ─── Generate collage from extracted images ──────────────────────

export async function generateCollage(images: StoryImage[]): Promise<Buffer> {
  if (images.length === 0) {
    // Fallback: plain dark canvas
    return await sharp({
      create: { width: COLLAGE_TILE, height: COLLAGE_TILE, channels: 3, background: { r: 20, g: 20, b: 30 } },
    }).jpeg({ quality: COLLAGE_QUALITY }).toBuffer()
  }

  const cols = Math.ceil(Math.sqrt(images.length))
  const rows = Math.ceil(images.length / cols)

  const composites: sharp.OverlayOptions[] = []

  for (let i = 0; i < images.length; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const left = col * COLLAGE_TILE
    const top = row * COLLAGE_TILE

    try {
      const buf = await sharp(images[i].extractedPath)
        .resize(COLLAGE_TILE, COLLAGE_TILE, { fit: "cover", position: "centre" })
        .toBuffer()
      composites.push({ input: buf, left, top })
    } catch (err) {
      console.error(`[story/collage] Failed processing ${images[i].entryPath}:`, err)
    }
  }

  const canvasW = cols * COLLAGE_TILE
  const canvasH = rows * COLLAGE_TILE

  return await sharp({
    create: { width: canvasW, height: canvasH, channels: 3, background: { r: 20, g: 20, b: 30 } },
  })
    .composite(composites)
    .jpeg({ quality: COLLAGE_QUALITY })
    .toBuffer()
}

// ─── Claude Code story provider ───────────────────────────────────

/**
 * Generate a fictional story from image metadata using Claude Code CLI (text-only).
 * Uses image filenames and archive names as creative inspiration.
 * Falls back gracefully if Claude Code is unavailable.
 */
async function tryClaudeText(images: StoryImage[]): Promise<string | null> {
  const imageDesc = images
    .map((img, i) => `Image ${i + 1}: from archive "${img.zipName}", filename "${img.entryPath}"`)
    .join("\n")

  const prompt = `You are a creative fiction writer. I'll describe a set of images and I want you to write a short fictional story (300-500 words) that connects them into a single narrative.

Images:
${imageDesc}

Based on these filenames and the archives they come from, imagine what each image might depict and weave them into a cohesive, imaginative story. Give it a title.

Write ONLY the story, no preamble or explanation. Format as:
## Title
Story text...`

  return new Promise<string | null>((resolve) => {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    delete env.ANTHROPIC_BASE_URL
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_COOKIES

    const proc = spawn("claude", ["-p", prompt, "--print"], {
      timeout: CLAUDE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    })

    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on("error", () => resolve(null))
    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const story = stdout.trim()
      resolve(story.length >= 10 ? story : null)
    })

    setTimeout(() => {
      try { proc.kill() } catch { /* ignore */ }
      resolve(null)
    }, CLAUDE_TIMEOUT_MS)
  })
}

/**
 * Final fallback: generate a simple story from image metadata directly.
 */
export function generateFallbackStory(images: StoryImage[]): string {
  const archives = [...new Set(images.map((img) => img.zipName))]
  const totalImages = images.length

  return `## Echoes of ${archives.length} Worlds

In a realm where time folded like pages of an ancient book, ${totalImages} moments from ${archives.length} different timelines converged. Each image carried a fragment of a story — a whispered memory from "${archives[0] || "the first archive"}"${archives.length > 1 ? `, a frozen second from "${archives[1] || "the second"}"` : ""}${archives.length > 2 ? `, and glimpses from ${archives.length - 2} other dimensions.` : "."}

The scenes never met in the same universe, but here, in this collage of borrowed time, they danced together. Shadows from one frame reached into the light of another. A color from the third echoed in the fourth. And somewhere between the pixels, a narrative emerged — not written in words, but in the spaces where the images touched.

What story were they telling? Perhaps one only the viewer could complete — a fiction born from the collision of ${totalImages} frozen seconds, stitched together across the archives of forgotten timelines.

*The end.*`
}

// ─── Cleanup ──────────────────────────────────────────────────────

async function cleanup(sessionId: string): Promise<void> {
  const dir = join(TEMP_DIR, sessionId)
  try {
    await rm(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

// ─── Main entry point ────────────────────────────────────────────

export async function generateStory(
  count: number = STORY_IMAGE_COUNT,
): Promise<StoryResult> {
  const sessionId = `story_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // 1. Pick diverse images
  const picks = await pickDiverseImages(count)
  if (picks.length === 0) {
    return {
      story: "No images available to create a story.",
      collageBase64: "",
      images: [],
      provider: "generated",
    }
  }

  // 2. Extract to temp
  const extracted = await extractImages(picks, sessionId)
  if (extracted.length === 0) {
    return {
      story: "Could not extract any images from the archives.",
      collageBase64: "",
      images: [],
      provider: "generated",
    }
  }

  // 3. Generate collage
  const collageBuffer = await generateCollage(extracted)
  const collageBase64 = collageBuffer.toString("base64")

  // 4. Generate story (try providers in order)
  let story: string | null = null
  let provider: StoryResult["provider"] = "generated"

  // Use Claude Code with text-only prompt (image filenames + archive context)
  // Claude Code's sandbox doesn't allow reading arbitrary image paths from
  // subprocess spawn, but text-based prompts with image metadata work beautifully.
  try {
    story = await tryClaudeText(extracted)
  } catch (err) {
    console.error("[story] Claude Code text fallback failed:", err)
  }
  if (story) {
    provider = "claude-text"
  }

  if (!story) {
    story = generateFallbackStory(extracted)
    provider = "generated"
  }

  // 5. Cleanup temp files
  cleanup(sessionId).catch(() => {})

  return {
    story,
    collageBase64,
    images: extracted.map((img) => ({ zip: img.zipName, path: img.entryPath })),
    provider,
  }
}