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
import { generateStory, STORY_IMAGE_COUNT, type StoryResult } from "./story"

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
  const explicitZip = c.req.query("zip") || undefined

  // Determine count from grid / rows+cols / count param
  let rows: number, cols: number

  const gridParam = c.req.query("grid")
  const rowsParam = c.req.query("rows")
  const colsParam = c.req.query("cols")
  const countParam = c.req.query("count")

  if (gridParam) {
    // "3x4" → rows=3, cols=4
    const match = gridParam.match(/^(\d+)\s*x\s*(\d+)$/i)
    if (!match) {
      return c.json({ error: "grid must be like '3x3', '2x4', etc." }, 400)
    }
    rows = parseInt(match[1], 10)
    cols = parseInt(match[2], 10)
  } else if (rowsParam || colsParam) {
    rows = rowsParam ? parseInt(rowsParam, 10) : 1
    cols = colsParam ? parseInt(colsParam, 10) : 1
  } else {
    // Use count (default 4) and auto-calculate grid
    const count = parseInt(countParam || "4", 10)
    if (isNaN(count) || count < 1 || count > 30) {
      return c.json({ error: "count must be between 1 and 30" }, 400)
    }
    cols = Math.ceil(Math.sqrt(count))
    rows = Math.ceil(count / cols)
  }

  if (isNaN(rows) || isNaN(cols) || rows < 1 || cols < 1 || rows * cols > 30) {
    return c.json({ error: "grid dimensions invalid (max 30 total cells)" }, 400)
  }

  const total = rows * cols

  // Collect N random images
  const picked: Array<{ data: Uint8Array; path: string }> = []
  for (let i = 0; i < total; i++) {
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

  // Use the explicit grid dimensions (not auto)
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

// ─── Collage App (SPA) ────────────────────────────────────────────

const COLLAGE_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📸 Collage Magic</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    padding: 2rem;
    overflow-x: hidden;
  }

  /* Floating orbs */
  body::before, body::after {
    content: '';
    position: fixed;
    border-radius: 50%;
    filter: blur(80px);
    z-index: 0;
    animation: float 10s ease-in-out infinite alternate;
  }
  body::before {
    width: 400px; height: 400px;
    background: rgba(255, 107, 107, 0.25);
    top: -100px; left: -100px;
  }
  body::after {
    width: 500px; height: 500px;
    background: rgba(78, 205, 196, 0.2);
    bottom: -150px; right: -150px;
    animation-delay: -5s;
  }

  @keyframes float {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(60px, 40px) scale(1.1); }
  }

  .container {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2rem;
    width: 100%;
    max-width: 700px;
  }

  h1 {
    font-size: 2.2rem;
    font-weight: 800;
    background: linear-gradient(135deg, #f093fb, #f5576c, #4facfe);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    text-align: center;
    letter-spacing: -0.5px;
    animation: titleGlow 3s ease-in-out infinite alternate;
  }

  @keyframes titleGlow {
    0% { filter: brightness(1); }
    100% { filter: brightness(1.3); }
  }

  .collage-wrapper {
    position: relative;
    width: 100%;
    border-radius: 20px;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08);
    transition: box-shadow 0.4s;
  }
  .collage-wrapper:hover {
    box-shadow: 0 25px 70px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.15);
  }

  #collage-img {
    width: 100%;
    height: auto;
    display: block;
    transition: opacity 0.4s ease;
  }
  #collage-img.loading {
    opacity: 0.3;
  }

  .loader {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
  }
  .loader.active {
    opacity: 1;
  }
  .loader .spinner {
    width: 50px; height: 50px;
    border: 4px solid rgba(255,255,255,0.1);
    border-top-color: #f5576c;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .btn {
    position: relative;
    padding: 1rem 3rem;
    font-size: 1.2rem;
    font-weight: 700;
    border: none;
    border-radius: 50px;
    cursor: pointer;
    color: white;
    background: linear-gradient(135deg, #667eea, #764ba2);
    box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    letter-spacing: 0.5px;
    overflow: hidden;
  }

  .btn::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, #764ba2, #f093fb);
    opacity: 0;
    transition: opacity 0.3s;
    border-radius: 50px;
  }

  .btn:hover {
    transform: translateY(-3px) scale(1.03);
    box-shadow: 0 12px 35px rgba(102, 126, 234, 0.5);
  }
  .btn:hover::before { opacity: 1; }

  .btn:active {
    transform: translateY(0) scale(0.97);
  }

  .btn span, .btn svg {
    position: relative;
    z-index: 1;
  }

  .btn svg {
    width: 24px; height: 24px;
    transition: transform 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55);
  }
  .btn:active svg {
    transform: rotate(360deg);
  }

  .btn.spinning svg {
    animation: btnSpin 0.6s ease-in-out;
  }
  @keyframes btnSpin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  /* Tile pop-in animation when image loads */
  @keyframes popIn {
    0% { transform: scale(0.8); opacity: 0; }
    60% { transform: scale(1.05); }
    100% { transform: scale(1); opacity: 1; }
  }

  /* Confetti burst */
  .confetti-container {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 100;
    overflow: hidden;
  }
  .confetti {
    position: absolute;
    width: 10px; height: 10px;
    border-radius: 2px;
    animation: confettiFall linear forwards;
  }
  @keyframes confettiFall {
    0% { opacity: 1; transform: translateY(0) rotate(0deg) scale(1); }
    100% { opacity: 0; transform: translateY(100vh) rotate(720deg) scale(0.3); }
  }

  .footer {
    font-size: 0.8rem;
    color: rgba(255,255,255,0.3);
    margin-top: 1rem;
  }

  @media (max-width: 500px) {
    h1 { font-size: 1.5rem; }
    .btn { padding: 0.8rem 2rem; font-size: 1rem; }
    body { padding: 1rem; }
  }
</style>
</head>
<body>
<div class="container">
  <h1>✨ Collage Magic</h1>

  <div class="collage-wrapper">
    <img id="collage-img" class="loading" src="/collage?count=9&_t=${Date.now()}" alt="Collage">
    <div class="loader active" id="loader">
      <div class="spinner"></div>
    </div>
  </div>

  <button class="btn" id="shuffle-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="16 3 21 3 21 8"></polyline>
      <line x1="4" y1="20" x2="21" y2="3"></line>
      <polyline points="21 16 21 21 16 21"></polyline>
      <line x1="15" y1="15" x2="21" y2="21"></line>
      <line x1="4" y1="4" x2="9" y2="9"></line>
    </svg>
    <span>Shuffle!</span>
  </button>

  <div class="footer">🎞 {{IMAGE_COUNT}} images in the vault</div>
</div>

<script>
  const img = document.getElementById('collage-img');
  const loader = document.getElementById('loader');
  const btn = document.getElementById('shuffle-btn');

  // Confetti colors
  const COLORS = ['#f5576c','#667eea','#f093fb','#4facfe','#43e97b','#fa709a','#fee140','#a18cd1'];

  function burstConfetti() {
    const container = document.createElement('div');
    container.className = 'confetti-container';
    for (let i = 0; i < 60; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = Math.random() * 100 + '%';
      el.style.background = COLORS[Math.floor(Math.random() * COLORS.length)];
      el.style.width = (Math.random() * 8 + 4) + 'px';
      el.style.height = (Math.random() * 8 + 4) + 'px';
      el.style.animationDuration = (Math.random() * 2 + 1.5) + 's';
      el.style.animationDelay = (Math.random() * 0.5) + 's';
      el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      container.appendChild(el);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 4000);
  }

  function loadCollage() {
    btn.classList.add('spinning');
    loader.classList.add('active');
    img.classList.add('loading');

    const ts = Date.now();
    img.src = '/collage?count=9&_t=' + ts;
  }

  img.onload = () => {
    loader.classList.remove('active');
    img.classList.remove('loading');
    btn.classList.remove('spinning');
    burstConfetti();
    img.style.animation = 'none';
    img.offsetHeight;
    img.style.animation = 'popIn 0.5s ease-out';
  };

  img.onerror = () => {
    loader.classList.remove('active');
    img.classList.remove('loading');
    btn.classList.remove('spinning');
  };

  btn.addEventListener('click', loadCollage);
</script>
</body>
</html>`

app.get("/collage-app", (c) => {
  const html = COLLAGE_APP_HTML.replace("{{IMAGE_COUNT}}", String(flatIndex.length))
  return c.html(html)
})

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

// ─── Story generation ─────────────────────────────────────────────

/**
 * POST /api/story
 *
 * Randomly selects N images across different ZIP archives,
 * generates a collage, creates a fictional story with Claude Code,
 * and returns JSON with the collage (base64) + story text + image metadata.
 *
 * Query params:
 *   count  — number of images to use (default: 9, max: 16)
 */
app.post("/api/story", async (c) => {
  const countParam = c.req.query("count")
  let count = countParam ? parseInt(countParam, 10) : STORY_IMAGE_COUNT
  if (isNaN(count) || count < 2) count = 2
  if (count > 16) count = 16

  try {
    const result: StoryResult = await generateStory(count)
    return c.json(result)
  } catch (err) {
    console.error("[api/story] Error:", err)
    return c.json({ error: "Story generation failed", details: String(err) }, 500)
  }
})

/**
 * GET /api/story — convenience alias, same as POST
 */
app.get("/api/story", async (c) => {
  const countParam = c.req.query("count")
  let count = countParam ? parseInt(countParam, 10) : STORY_IMAGE_COUNT
  if (isNaN(count) || count < 2) count = 2
  if (count > 16) count = 16

  try {
    const result: StoryResult = await generateStory(count)
    return c.json(result)
  } catch (err) {
    console.error("[api/story] Error:", err)
    return c.json({ error: "Story generation failed", details: String(err) }, 500)
  }
})

// ─── Start ───────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10)

// Start the server — note: we do NOT export default app to prevent Bun from
// trying to start a second server on the same port.
console.log(`[server] Starting on http://0.0.0.0:${PORT}...`)
Bun.serve({
  fetch: app.fetch,
  port: PORT,
  idleTimeout: 120, // allow up to 120s for story generation via Claude Code
})
console.log(`[server] Listening on http://0.0.0.0:${PORT}`)

// Warm cache in background — indexing happens after server is already accepting requests
warmCache().then(() => {
  console.log(`[server] Cache warmed: ${perZipIndex.size} ZIPs, ${flatIndex.length} images`)
})

// No export default — prevents Bun from double-starting a second server
