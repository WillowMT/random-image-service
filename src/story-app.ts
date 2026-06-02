/**
 * Story App — Dark-themed SPA for generating and browsing AI stories
 *
 * Embedded HTML served at /story-app.
 * Features: generate stories, view collage + story text, browse history.
 * Uses the /api/story, /api/story/history, and /api/story/:id endpoints.
 */
export const STORY_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📖 Story Collage</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0d0d14;
    --surface: #16161f;
    --surface-2: #1e1e2a;
    --border: #2a2a3a;
    --text: #e0e0eb;
    --text-dim: #7a7a8a;
    --accent: #7c5cbf;
    --accent-glow: rgba(124, 92, 191, 0.3);
    --pink: #f5576c;
    --blue: #4facfe;
    --radius: 12px;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
  }

  /* ─── Layout ─────────────────────────────── */

  .sidebar {
    width: 300px;
    min-width: 300px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 1.2rem 1rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .sidebar-header h2 {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .sidebar-header .count {
    font-size: 0.8rem;
    color: var(--text-dim);
    background: var(--surface-2);
    padding: 2px 10px;
    border-radius: 20px;
  }

  .history-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
  }

  .history-list::-webkit-scrollbar {
    width: 4px;
  }
  .history-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .history-list::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
  }

  .history-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.8rem;
    margin-bottom: 0.5rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .history-card:hover {
    border-color: var(--accent);
    background: #252538;
  }

  .history-card.active {
    border-color: var(--accent);
    box-shadow: 0 0 12px var(--accent-glow);
  }

  .history-card .date {
    font-size: 0.7rem;
    color: var(--text-dim);
    margin-bottom: 0.3rem;
  }

  .history-card .preview {
    font-size: 0.8rem;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    color: var(--text);
  }

  .history-card .meta {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.4rem;
    font-size: 0.65rem;
    color: var(--text-dim);
  }

  .history-card .meta .tag {
    background: var(--surface);
    padding: 1px 8px;
    border-radius: 10px;
  }

  .history-empty {
    text-align: center;
    padding: 2rem 1rem;
    color: var(--text-dim);
    font-size: 0.85rem;
  }

  /* ─── Main ────────────────────────────────── */

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .main-header {
    padding: 1rem 2rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .main-header h1 {
    font-size: 1.4rem;
    font-weight: 800;
    background: linear-gradient(135deg, var(--accent), var(--pink), var(--blue));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .controls select {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
    outline: none;
  }

  .controls select:focus {
    border-color: var(--accent);
  }

  .btn-generate {
    padding: 0.6rem 1.8rem;
    font-size: 0.9rem;
    font-weight: 700;
    border: none;
    border-radius: 50px;
    cursor: pointer;
    color: white;
    background: linear-gradient(135deg, var(--accent), #9b6dff);
    box-shadow: 0 4px 20px var(--accent-glow);
    transition: all 0.3s ease;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .btn-generate:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 30px var(--accent-glow);
  }

  .btn-generate:active {
    transform: translateY(0) scale(0.97);
  }

  .btn-generate:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none !important;
  }

  .btn-generate .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Content ────────────────────────────── */

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    align-items: center;
  }

  .content::-webkit-scrollbar {
    width: 6px;
  }
  .content::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
  }

  .collage-wrapper {
    width: 100%;
    max-width: 700px;
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.06);
    position: relative;
  }

  .collage-wrapper img {
    width: 100%;
    height: auto;
    display: block;
    transition: opacity 0.4s ease;
  }

  .collage-wrapper img.loading {
    opacity: 0.3;
  }

  .placeholder {
    width: 100%;
    max-width: 700px;
    aspect-ratio: 1;
    border-radius: var(--radius);
    background: var(--surface-2);
    border: 1px dashed var(--border);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.8rem;
    color: var(--text-dim);
    font-size: 0.9rem;
    text-align: center;
    padding: 2rem;
  }

  .placeholder .icon {
    font-size: 3rem;
    opacity: 0.4;
  }

  .story-card {
    width: 100%;
    max-width: 700px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem 2rem;
  }

  .story-card .story-title {
    font-size: 1.2rem;
    font-weight: 700;
    margin-bottom: 1rem;
    color: var(--accent);
  }

  .story-card .story-body {
    line-height: 1.8;
    font-size: 0.95rem;
    white-space: pre-wrap;
    color: var(--text);
  }

  .story-card .story-meta {
    display: flex;
    gap: 1rem;
    margin-top: 1.2rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--text-dim);
    flex-wrap: wrap;
  }

  .story-card .story-meta span {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .loader-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s;
  }

  .loader-overlay.active {
    opacity: 1;
    pointer-events: all;
  }

  .loader-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 2.5rem 3rem;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }

  .loader-card .big-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(124, 92, 191, 0.2);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 1rem;
  }

  .loader-card p {
    color: var(--text-dim);
    font-size: 0.9rem;
  }

  /* ─── Responsive ─────────────────────────── */

  @media (max-width: 800px) {
    body { flex-direction: column; }
    .sidebar {
      width: 100%;
      min-width: unset;
      height: auto;
      max-height: 200px;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-header { padding: 0.8rem 1rem; }
    .history-list { display: flex; gap: 0.5rem; overflow-x: auto; padding: 0.5rem; flex-wrap: nowrap; }
    .history-card { min-width: 200px; margin-bottom: 0; flex-shrink: 0; }
    .main-header { flex-direction: column; align-items: stretch; gap: 0.5rem; padding: 0.8rem 1rem; }
    .controls { justify-content: stretch; }
    .controls select { flex: 1; }
    .btn-generate { flex: 1; justify-content: center; }
    .content { padding: 1rem; }
    .story-card { padding: 1rem; }
  }
</style>
</head>
<body>

<!-- ─── Sidebar ───────────────────────────── -->
<div class="sidebar">
  <div class="sidebar-header">
    <h2>📚 Stories</h2>
    <span class="count" id="story-count">0</span>
  </div>
  <div class="history-list" id="history-list">
    <div class="history-empty">Generate your first story ✨</div>
  </div>
</div>

<!-- ─── Main ──────────────────────────────── -->
<div class="main">
  <div class="main-header">
    <h1>📖 Story Collage</h1>
    <div class="controls">
      <select id="count-select">
        <option value="4">4 images</option>
        <option value="6">6 images</option>
        <option value="9" selected>9 images</option>
        <option value="12">12 images</option>
        <option value="16">16 images</option>
      </select>
      <button class="btn-generate" id="generate-btn">
        <span id="btn-text">✨ Generate</span>
      </button>
    </div>
  </div>

  <div class="content" id="content">
    <div class="placeholder">
      <div class="icon">📖</div>
      <div>Press <strong>Generate</strong> to create a story</div>
      <div style="font-size:0.8rem;">Claude Code weaves your images into fiction</div>
    </div>
  </div>
</div>

<!-- ─── Loader overlay ─────────────────────── -->
<div class="loader-overlay" id="loader">
  <div class="loader-card">
    <div class="big-spinner"></div>
    <p id="loader-text">Weaving images into a story...</p>
  </div>
</div>

<script>
// ─── State ──────────────────────────────────

let currentId = null
let isLoading = false

// ─── DOM refs ───────────────────────────────

const historyList = document.getElementById('history-list')
const content = document.getElementById('content')
const generateBtn = document.getElementById('generate-btn')
const btnText = document.getElementById('btn-text')
const countSelect = document.getElementById('count-select')
const loader = document.getElementById('loader')
const loaderText = document.getElementById('loader-text')
const storyCount = document.getElementById('story-count')

// ─── Helpers ────────────────────────────────

function dateStr(iso) {
  const d = new Date(iso + 'Z')
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

// ─── Render story in main content ───────────

function renderStory(data) {
  currentId = data.id

  // Parse title from markdown ## Title
  let title = 'Untitled Story'
  let body = data.story
  const titleMatch = data.story.match(/^##\\s+(.+)/m)
  if (titleMatch) {
    title = titleMatch[1]
    body = data.story.replace(/^##\\s+.+\\n*/m, '').trim()
  }

  content.innerHTML = \`
    <div class="collage-wrapper">
      <img src="data:image/jpeg;base64,\${data.collageBase64}" alt="Story collage">
    </div>
    <div class="story-card">
      <div class="story-title">\${title}</div>
      <div class="story-body">\${body}</div>
      <div class="story-meta">
        <span>📸 \${data.images?.length || data.imageCount || 0} images</span>
        <span>🤖 \${data.provider || 'generated'}</span>
        <span>🆔 #\${data.id}</span>
      </div>
    </div>
  \`
}

// ─── Render history sidebar ─────────────────

function renderHistory(stories, total) {
  storyCount.textContent = total || stories.length

  if (!stories || stories.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No stories yet ✨</div>'
    return
  }

  historyList.innerHTML = stories.map(s => {
    // Extract title from preview
    let title = s.story_preview || 'Untitled'
    const titleMatch = (s.story_preview || '').match(/^##\\s+(.+)/)
    if (titleMatch) title = titleMatch[1]

    const previewText = titleMatch
      ? (s.story_preview || '').replace(/^##\\s+.+\\n*/m, '').trim().slice(0, 120)
      : (s.story_preview || '').slice(0, 120)

    const isActive = s.id === currentId ? ' active' : ''

    return \`
      <div class="history-card\${isActive}" data-id="\${s.id}" onclick="loadStory(\${s.id})">
        <div class="date">\${dateStr(s.created_at)}</div>
        <div class="preview">\${title.slice(0, 60)}</div>
        <div class="meta">
          <span class="tag">📸 \${s.image_count}</span>
          <span class="tag">\${s.provider}</span>
        </div>
      </div>
    \`
  }).join('')
}

// ─── Load story by ID ───────────────────────

async function loadStory(id) {
  if (isLoading) return
  try {
    const res = await fetch('/api/story/' + id)
    if (!res.ok) return
    const data = await res.json()
    renderStory(data)
    // Highlight in history
    document.querySelectorAll('.history-card').forEach(c => c.classList.remove('active'))
    const card = document.querySelector('.history-card[data-id="' + id + '"]')
    if (card) card.classList.add('active')
  } catch (err) {
    console.error('Failed to load story:', err)
  }
}

// ─── Generate new story ─────────────────────

async function generateStory() {
  if (isLoading) return
  isLoading = true
  generateBtn.disabled = true
  btnText.innerHTML = '<span class="spinner"></span> Generating...'
  loaderText.textContent = 'Claude Code is weaving your images into a story...'
  loader.classList.add('active')

  const count = countSelect.value

  try {
    const res = await fetch('/api/story?count=' + count)
    if (!res.ok) {
      const err = await res.json()
      alert('Error: ' + (err.error || 'Unknown error'))
      return
    }
    const data = await res.json()
    renderStory(data)
    // Refresh history
    await refreshHistory()
    // Scroll to top
    content.scrollTop = 0
  } catch (err) {
    console.error('Generation failed:', err)
    alert('Story generation failed. Check console for details.')
  } finally {
    isLoading = false
    generateBtn.disabled = false
    btnText.innerHTML = '✨ Generate'
    loader.classList.remove('active')
  }
}

// ─── Refresh history ────────────────────────

async function refreshHistory() {
  try {
    const res = await fetch('/api/story/history?limit=50')
    if (!res.ok) return
    const data = await res.json()
    renderHistory(data.stories, data.total)
  } catch (err) {
    console.error('Failed to load history:', err)
  }
}

// ─── Init ───────────────────────────────────

// Load latest story and history on page load
async function init() {
  try {
    const res = await fetch('/api/story/history?limit=50')
    if (!res.ok) return
    const data = await res.json()
    renderHistory(data.stories, data.total)

    // Show the most recent story
    if (data.stories && data.stories.length > 0) {
      await loadStory(data.stories[0].id)
    }
  } catch (err) {
    console.error('Init failed:', err)
  }
}

generateBtn.addEventListener('click', generateStory)
init()
</script>
</body>
</html>`