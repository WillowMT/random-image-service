/// <reference types="bun-types" />

/**
 * Random Image Service — Hono + Bun
 *
 * Serves random images from ZIP archives via /random-image.
 *
 * ZIP reading strategy: @zip.js/zip.js
 *
 * Why this library over alternatives:
 *   - Pure JS, zero native deps — works identically on Bun, Node, Deno
 *   - Supports reading individual entries without extracting the full archive
 *     (via BlobReader + getData() on a single entry)
 *   - Handles both stored (uncompressed) and deflated entries transparently
 *   - Web Streams API compatible — plays well with Bun's Blob/Bun.file()
 *   - Better maintained than adm-zip, simpler than unzipper's streaming model
 *
 * Alternatives considered:
 *   - adm-zip: loads entire central directory into memory on every open(),
 *     and readFile() decompresses to a Buffer. Fine for small archives, but
 *     the "open every time" pattern wastes I/O for our use case.
 *   - unzipper: streaming model is elegant for pipe-through use cases but
 *     awkward for random-access "read one entry" patterns.
 *   - Manual ZIP parsing: possible (EOCD → central dir → local header),
 *     but we'd need to reimplement deflate decompression. Bun has
 *     DecompressionStream for the latter, but it's still more surface
 *     area for bugs. zip.js already handles edge cases (encryption, Zip64,
 *     unusual compression methods) that we'd skip at our peril.
 */

import { Hono } from "hono"
import { compress } from "hono/compress"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { BlobReader, ZipReader, BlobWriter } from "@zip.js/zip.js"
import { stat } from "fs/promises"
import sharp from "sharp"

// ─── Types ───────────────────────────────────────────────────────

interface ZipIndex {
  /** File mtime (ms) when this index was built */
  mtime: number
  /** Ordered list of image entry paths */
  entries: string[]
}

interface FlatEntry {
  zipName: string
  entryPath: string
}

// ─── Config ──────────────────────────────────────────────────────

const ZIP_DIR = process.env.ZIP_DIR || "./zips"
const SELECTION_MODE = (process.env.SELECTION_MODE || "flat") as "flat" | "per-zip"

// ─── State ───────────────────────────────────────────────────────

/** Per-zip index cache: zipName → ZipIndex */
const perZipIndex = new Map<string, ZipIndex>()

/** Flat list of (zip, entry) pairs for "flat" mode — rebuilt on any index change */
let flatIndex: FlatEntry[] = []

/** Optional small LRU byte cache (off by default, enable via env) */
const BYTE_CACHE_MAX = Math.max(0, parseInt(process.env.BYTE_CACHE_SIZE || "0", 10))
const byteCache = new Map<string, { data: Uint8Array; mtime: number }>()

// ─── Image helpers ───────────────────────────────────────────────

const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif",
])

function isImageFile(path: string): boolean {
  const dot = path.toLowerCase().lastIndexOf(".")
  if (dot === -1) return false
  return IMAGE_EXTS.has(path.slice(dot))
}

function contentType(path: string): string {
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
  }
  const dot = path.toLowerCase().lastIndexOf(".")
  return map[path.slice(dot)] || "application/octet-stream"
}

// ─── ZIP scanning (build index) ──────────────────────────────────

async function scanZip(zipPath: string): Promise<ZipIndex | null> {
  try {
    await stat(zipPath)
  } catch {
    return null
  }

  const fstat = await stat(zipPath)
  const mtime = fstat.mtimeMs

  try {
    const file = Bun.file(zipPath)
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()
    await reader.close()

    const imageEntries: string[] = []
    for (const entry of entries) {
      if (!entry.directory && isImageFile(entry.filename)) {
        imageEntries.push(entry.filename)
      }
    }

    return { mtime, entries: imageEntries }
  } catch (err) {
    console.error(`[scan] Failed to read ${zipPath}:`, err)
    return null
  }
}

// ─── Cache management ────────────────────────────────────────────

async function ensureIndex(zipName: string): Promise<ZipIndex | null> {
  const zipPath = `${ZIP_DIR}/${zipName}`
  try {
    await stat(zipPath)
  } catch {
    return null
  }

  const st = await stat(zipPath)
  const currentMtime = st.mtimeMs
  const cached = perZipIndex.get(zipName)

  if (cached && cached.mtime === currentMtime) {
    return cached
  }

  // Stale or missing — rebuild
  console.log(`[cache] Rebuilding index for ${zipName} (mtime changed)`)
  const idx = await scanZip(zipPath)
  if (!idx) return null

  perZipIndex.set(zipName, idx)
  rebuildFlatIndex()
  return idx
}

function rebuildFlatIndex(): void {
  flatIndex = []
  for (const [zipName, idx] of perZipIndex) {
    for (const entryPath of idx.entries) {
      flatIndex.push({ zipName, entryPath })
    }
  }
}

// ─── Read single entry from ZIP ──────────────────────────────────

async function readZipEntry(
  zipPath: string,
  entryPath: string,
): Promise<Uint8Array | null> {
  // Check byte cache first
  if (BYTE_CACHE_MAX > 0) {
    try {
      const st = await stat(zipPath)
      const cacheKey = `${zipPath}::${entryPath}`
      const cached = byteCache.get(cacheKey)
      if (cached && cached.mtime === st.mtimeMs) {
        return cached.data
      }
    } catch {
      // file doesn't exist
    }
  }

  try {
    const file = Bun.file(zipPath)
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()

    const target = entries.find((e) => e.filename === entryPath)
    if (!target) {
      await reader.close()
      return null
    }

    // Get the data as a Blob, then convert to Uint8Array
    const blob = await target.getData(new BlobWriter())
    await reader.close()

    const bytes = new Uint8Array(await blob.arrayBuffer())

    // Cache if enabled
    if (BYTE_CACHE_MAX > 0) {
      const cacheKey = `${zipPath}::${entryPath}`
      if (byteCache.size >= BYTE_CACHE_MAX) {
        // Evict oldest entry
        const firstKey = byteCache.keys().next().value
        if (firstKey) byteCache.delete(firstKey)
      }
      try {
        const fileStat = await stat(zipPath)
        byteCache.set(cacheKey, { data: bytes, mtime: fileStat.mtimeMs })
      } catch {}
    }

    return bytes
  } catch (err) {
    console.error(`[read] Failed to read ${entryPath} from ${zipPath}:`, err)
    return null
  }
}

// ─── List ZIPs ───────────────────────────────────────────────────

async function listZipFiles(): Promise<string[]> {
  const { readdir } = await import("fs/promises")
  try {
    const entries = await readdir(ZIP_DIR)
    return entries.filter((e) => e.toLowerCase().endsWith(".zip"))
  } catch (err) {
    console.warn("[list] Failed to read ZIP directory:", err)
    return []
  }
}

// ─── Warmup ──────────────────────────────────────────────────────

async function warmCache(): Promise<void> {
  const zipFiles = await listZipFiles()
  for (const zipName of zipFiles) {
    await ensureIndex(zipName)
  }
  const totalImages = flatIndex.length
  console.log(`[warm] Indexed ${perZipIndex.size} ZIPs, ${totalImages} images (mode: ${SELECTION_MODE})`)
}

// ─── Select random image — request-time ──────────────────────────

interface Selection {
  zipName: string
  entryPath: string
}

interface SelectionResult {
  selection: Selection | null
  error?: { message: string; status: number }
}

async function selectRandomImage(explicitZip?: string): Promise<SelectionResult> {
  if (explicitZip) {
    const idx = await ensureIndex(explicitZip)
    if (!idx) {
      return { selection: null, error: { message: `ZIP not found: ${explicitZip}`, status: 404 } }
    }
    if (idx.entries.length === 0) {
      return { selection: null, error: { message: `No images in ZIP: ${explicitZip}`, status: 422 } }
    }
    const entryPath = idx.entries[Math.floor(Math.random() * idx.entries.length)]
    return { selection: { zipName: explicitZip, entryPath } }
  }

  // Ensure all ZIPs are indexed
  const zipFiles = await listZipFiles()
  if (zipFiles.length === 0) {
    return { selection: null, error: { message: "No ZIP files found in " + ZIP_DIR, status: 404 } }
  }

  for (const z of zipFiles) {
    await ensureIndex(z)
  }

  if (SELECTION_MODE === "flat") {
    if (flatIndex.length === 0) {
      return { selection: null, error: { message: "No images found in any ZIP archive", status: 422 } }
    }
    const pick = flatIndex[Math.floor(Math.random() * flatIndex.length)]
    return { selection: pick }
  }

  // per-zip mode
  const availableZips = [...perZipIndex.entries()].filter(
    ([, idx]) => idx.entries.length > 0,
  )
  if (availableZips.length === 0) {
    return { selection: null, error: { message: "No images found in any ZIP archive", status: 422 } }
  }
  const [zipName, idx] = availableZips[Math.floor(Math.random() * availableZips.length)]
  const entryPath = idx.entries[Math.floor(Math.random() * idx.entries.length)]
  return { selection: { zipName, entryPath } }
}

// ─── App ─────────────────────────────────────────────────────────

const app = new Hono()

app.use("*", compress())
app.use("*", cors())
app.use("*", logger())

// Health / status
app.get("/", (c) =>
  c.json({
    status: "ok",
    zips: perZipIndex.size,
    images: flatIndex.length,
    mode: SELECTION_MODE,
    zipDir: ZIP_DIR,
  }),
)

// Random image
app.get("/random-image", async (c) => {
  const explicitZip = c.req.query("zip")
  const { selection, error } = await selectRandomImage(explicitZip)

  if (error) {
    return c.json({ error: error.message }, error.status)
  }

  const zipPath = `${ZIP_DIR}/${selection!.zipName}`
  const bytes = await readZipEntry(zipPath, selection!.entryPath)

  if (!bytes) {
    return c.json({ error: "Failed to read image from archive" }, 500)
  }

  return new Response(bytes, {
    headers: { "Content-Type": contentType(selection!.entryPath) },
  })
})

// ─── Collage ──────────────────────────────────────────────────────

const TILE_SIZE = 600
const COLLAGE_QUALITY = 92

app.get("/collage", async (c) => {
  const countParam = c.req.query("count") || "4"
  const explicitZip = c.req.query("zip") || undefined
  const count = parseInt(countParam, 10)

  if (isNaN(count) || count < 1 || count > 30) {
    return c.json({ error: "count must be between 1 and 30" }, 400)
  }

  // Collect N random images
  const picked: Array<{ data: Uint8Array; path: string }> = []
  for (let i = 0; i < count; i++) {
    const { selection, error } = await selectRandomImage(explicitZip)
    if (error) {
      if (i > 0) break // return partial collage if we have at least one
      return c.json({ error: error.message }, error.status)
    }
    const zipPath = `${ZIP_DIR}/${selection!.zipName}`
    const bytes = await readZipEntry(zipPath, selection!.entryPath)
    if (bytes) picked.push({ data: bytes, path: selection!.entryPath })
  }

  if (picked.length === 0) {
    return c.json({ error: "No images could be read" }, 500)
  }

  // Compute grid dimensions
  const cols = Math.ceil(Math.sqrt(picked.length))
  const rows = Math.ceil(picked.length / cols)
  const canvasW = cols * TILE_SIZE
  const canvasH = rows * TILE_SIZE

  // Resize all images and composite them onto a canvas
  const composites: sharp.OverlayOptions[] = []

  for (let i = 0; i < picked.length; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const left = col * TILE_SIZE
    const top = row * TILE_SIZE

    const buf = await sharp(picked[i].data)
      .resize(TILE_SIZE, TILE_SIZE, { fit: "cover", position: "centre" })
      .toBuffer()

    composites.push({ input: buf, left, top })
  }

  const canvas = await sharp({
    create: { width: canvasW, height: canvasH, channels: 3, background: { r: 20, g: 20, b: 30 } },
  })
    .composite(composites)
    .jpeg({ quality: COLLAGE_QUALITY })
    .toBuffer()

  return new Response(canvas, {
    headers: { "Content-Type": "image/jpeg" },
  })
})

// ─── List ZIPs and their contents ─────────────────────────────────

app.get("/zips", async (c) => {
  const zipFiles = await listZipFiles()
  const result: Array<{ name: string; images: number; size: number }> = []

  for (const zipName of zipFiles) {
    const idx = await ensureIndex(zipName)
    const zipPath = `${ZIP_DIR}/${zipName}`
    let size = 0
    try {
      const st = await stat(zipPath)
      size = st.size
    } catch {}
    result.push({
      name: zipName,
      images: idx ? idx.entries.length : 0,
      size,
    })
  }

  return c.json({ archives: result, total: result.length })
})

app.get("/zips/:name", async (c) => {
  const zipName = c.req.param("name")
  const zipPath = `${ZIP_DIR}/${zipName}`

  try {
    await stat(zipPath)
  } catch {
    return c.json({ error: "ZIP not found" }, 404)
  }

  try {
    const file = Bun.file(zipPath)
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()
    await reader.close()

    // Build a tree-like structure: folders first, then files
    const folders = new Set<string>()
    const files: Array<{ path: string; size: number; isImage: boolean }> = []

    for (const entry of entries) {
      if (entry.directory) {
        folders.add(entry.filename.replace(/\/$/, ""))
      } else {
        files.push({
          path: entry.filename,
          size: entry.uncompressedSize,
          isImage: isImageFile(entry.filename),
        })
      }
    }

    return c.json({
      archive: zipName,
      totalEntries: entries.length,
      folders: [...folders].sort(),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    })
  } catch (err) {
    console.error(`[zips] Failed to read ${zipPath}:`, err)
    return c.json({ error: "Failed to read ZIP archive" }, 500)
  }
})

// ─── Start ───────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10)

// Start the server — note: we do NOT export default app to prevent Bun from
// trying to start a second server on the same port.
console.log(`[server] Starting on http://0.0.0.0:${PORT}...`)
Bun.serve({ fetch: app.fetch, port: PORT })
console.log(`[server] Listening on http://0.0.0.0:${PORT}`)

// Warm cache in background — indexing happens after server is already accepting requests
warmCache().then(() => {
  console.log(`[server] Cache warmed: ${perZipIndex.size} ZIPs, ${flatIndex.length} images`)
})

// No export default — prevents Bun from double-starting a second server
