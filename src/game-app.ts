/**
 * Game App — Embedded HTML served at /game-app.
 *
 * Interactive blur-guessing game where users pick which image is the original
 * in each pair. Uses the /api/game endpoint.
 */

export const GAME_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Spot the Original</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d0d12;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .container {
    max-width: 920px;
    width: 100%;
    padding: 20px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 0;
    border-bottom: 1px solid #222;
    margin-bottom: 24px;
  }
  header h1 {
    font-size: 22px;
    font-weight: 700;
    background: linear-gradient(135deg, #e0e0e0, #888);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .score-box {
    background: #1a1a24;
    padding: 8px 18px;
    border-radius: 10px;
    font-size: 18px;
    font-weight: 600;
    border: 1px solid #333;
  }
  .score-box span { color: #7c7cff; }
  .loading {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 300px;
    font-size: 18px;
    color: #666;
  }
  .loading .spinner {
    width: 28px; height: 28px;
    border: 3px solid #222; border-top-color: #7c7cff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 12px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error-box {
    background: #1a0a0a;
    border: 1px solid #442;
    border-radius: 10px;
    padding: 30px;
    text-align: center;
    color: #c66;
    margin: 40px 0;
  }
  .game-img-wrapper {
    position: relative;
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid #222;
    margin-bottom: 24px;
    background: #111;
  }
  .game-img-wrapper img {
    width: 100%;
    height: auto;
    display: block;
  }
  .rounds-container {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 24px;
  }
  .round-row {
    background: #15151e;
    border: 1px solid #222;
    border-radius: 10px;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .round-label {
    font-size: 14px;
    color: #666;
    min-width: 70px;
  }
  .round-label strong { color: #aaa; }
  .guess-btns {
    display: flex;
    gap: 8px;
  }
  .guess-btn {
    padding: 10px 28px;
    border-radius: 8px;
    border: 1px solid #333;
    background: #1a1a24;
    color: #888;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .guess-btn:hover { border-color: #555; color: #ccc; }
  .guess-btn.selected {
    border-color: #7c7cff;
    background: #1e1e35;
    color: #b8b8ff;
  }
  .guess-btn.correct-reveal {
    border-color: #2a6;
    background: #0f2418;
    color: #4e8;
  }
  .guess-btn.wrong-reveal {
    border-color: #c44;
    background: #241010;
    color: #e66;
  }
  .guess-btn:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .guess-btn .check-icon {
    margin-left: 6px;
    font-size: 14px;
  }
  .action-bar {
    display: flex;
    gap: 12px;
    justify-content: center;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .primary-btn {
    padding: 14px 40px;
    border-radius: 10px;
    border: none;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-check {
    background: #7c7cff;
    color: #fff;
  }
  .btn-check:hover { background: #6a6ae8; }
  .btn-check:disabled {
    background: #333;
    color: #666;
    cursor: default;
  }
  .btn-new {
    background: #222;
    color: #aaa;
    border: 1px solid #333;
  }
  .btn-new:hover { background: #2a2a; color: #ddd; }
  .results {
    margin-top: 16px;
    padding: 20px;
    border-radius: 12px;
    text-align: center;
  }
  .results.win {
    background: #0f2418;
    border: 1px solid #2a6;
  }
  .results.lose {
    background: #1a0e0e;
    border: 1px solid #442;
  }
  .results h2 {
    font-size: 26px;
    margin-bottom: 4px;
  }
  .results .sub {
    color: #666;
    font-size: 14px;
  }
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: #555;
  }
  .empty-state h2 { color: #888; margin-bottom: 10px; }
  @media (max-width: 600px) {
    .container { padding: 12px; }
    .round-row { flex-wrap: wrap; gap: 8px; }
    .round-label { min-width: auto; }
    .guess-btn { padding: 8px 18px; font-size: 13px; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🎯 Spot the Original</h1>
    <div class="score-box">Score: <span id="scoreDisplay">?</span>/<span id="totalDisplay">?</span></div>
  </header>
  <div id="app">
    <div class="loading" id="loading">
      <div class="spinner"></div>
      Loading game…
    </div>
  </div>
</div>
<script>
const APP = document.getElementById('app');

async function loadGame() {
  APP.innerHTML = \`<div class="loading"><div class="spinner"></div>Loading game…</div>\`;
  try {
    const res = await fetch('/api/game?count=6');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderGame(data);
  } catch (err) {
    APP.innerHTML = \`<div class="error-box">❌ Failed to load game: \${err.message}</div>\`;
  }
}

function renderGame(data) {
  const { collageBase64, pairs, imageCount, images } = data;
  // Initialize guesses: null = unselected, 'left' or 'right'
  const guesses = new Array(imageCount).fill(null);

  function buildRounds() {
    return pairs.map((pair, i) => {
      const g = guesses[i];
      const leftSel = g === 'left' ? ' selected' : '';
      const rightSel = g === 'right' ? ' selected' : '';
      return \`<div class="round-row" data-row="\${i}">
        <div class="round-label">Round <strong>\${i + 1}</strong></div>
        <div class="guess-btns">
          <button class="guess-btn\${leftSel}" data-row="\${i}" data-side="left">👈 Left</button>
          <button class="guess-btn\${rightSel}" data-row="\${i}" data-side="right">Right 👉</button>
        </div>
      </div>\`;
    }).join('');
  }

  function revealResults() {
    const answered = guesses.filter(g => g !== null).length;
    let correct = 0;
    pairs.forEach((pair, i) => {
      if (guesses[i] === pair.correctSide) correct++;
    });

    // Highlight correct/wrong buttons
    document.querySelectorAll('.guess-btn').forEach(btn => {
      const row = parseInt(btn.dataset.row);
      const side = btn.dataset.side;
      btn.disabled = true;
      const isCorrect = side === pairs[row].correctSide;
      if (isCorrect) {
        btn.classList.add('correct-reveal');
        if (guesses[row] === side) btn.innerHTML = btn.textContent + ' ✅';
      } else {
        if (guesses[row] === side) {
          btn.classList.add('wrong-reveal');
          btn.innerHTML = btn.textContent + ' ❌';
        }
      }
      btn.classList.remove('selected');
    });

    document.getElementById('checkBtn').style.display = 'none';
    document.getElementById('scoreDisplay').textContent = correct;
    document.getElementById('totalDisplay').textContent = imageCount;

    // Show results banner
    const resultsDiv = document.createElement('div');
    resultsDiv.className = 'results' + (correct >= Math.ceil(imageCount * 0.6) ? ' win' : ' lose');
    const pct = Math.round((correct / imageCount) * 100);
    resultsDiv.innerHTML = \`
      <h2>\${correct >= Math.ceil(imageCount * 0.6) ? '🎉 ' : ''}\${correct}/\${imageCount} (\${pct}%)</h2>
      <div class="sub">\${correct === imageCount ? 'Perfect! You\'re a pixel detective 🔍' :
        correct >= Math.ceil(imageCount * 0.6) ? 'Nice eye! 👀' :
        correct >= Math.ceil(imageCount * 0.4) ? 'Not bad, keep practicing 🎯' :
        'The blur is strong with this one 🌫️'}</div>
    \`;
    const existing = document.getElementById('resultsBox');
    if (existing) existing.remove();
    resultsDiv.id = 'resultsBox';
    document.getElementById('actionBar').after(resultsDiv);
  }

  function render() {
    // Check if all answered to enable the check button
    const allAnswered = guesses.every(g => g !== null);

    APP.innerHTML = \`
      <div class="game-img-wrapper">
        <img src="data:image/jpeg;base64,\${collageBase64}" alt="Game board">
      </div>
      <div class="rounds-container">
        \${buildRounds()}
      </div>
      <div class="action-bar" id="actionBar">
        <button class="primary-btn btn-check" id="checkBtn" \${!allAnswered ? 'disabled' : ''}>✅ Check Answers</button>
        <button class="primary-btn btn-new" id="newBtn">🔄 New Game</button>
      </div>
    \`;

    // Bind guess buttons
    document.querySelectorAll('.guess-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = parseInt(btn.dataset.row);
        const side = btn.dataset.side;
        // Toggle: clicking the same side deselects
        if (guesses[row] === side) {
          guesses[row] = null;
        } else {
          guesses[row] = side;
        }
        render();
      });
    });

    document.getElementById('checkBtn').addEventListener('click', revealResults);
    document.getElementById('newBtn').addEventListener('click', loadGame);
  }

  render();
  document.getElementById('scoreDisplay').textContent = '?';
  document.getElementById('totalDisplay').textContent = imageCount;
}

// Start
loadGame();
</script>
</body>
</html>`