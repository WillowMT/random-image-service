/**
 * Game Generation Database — SQLite persistence layer
 *
 * Stores each generated game (without the collage to keep DB small).
 */

import { Database } from "bun:sqlite"
import { existsSync } from "fs"
import { dirname } from "path"

const DB_PATH = process.env.STORY_DB_PATH || "/app/data/stories.db"

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) {
    try {
      const { mkdirSync } = require("fs")
      mkdirSync(dir, { recursive: true })
    } catch { /* volume might already exist */ }
  }
  _db = new Database(DB_PATH)
  _db.run("PRAGMA journal_mode = WAL")
  _db.run("PRAGMA synchronous = NORMAL")
  _db.run(`
    CREATE TABLE IF NOT EXISTS game_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      image_count INTEGER NOT NULL DEFAULT 0,
      game_data TEXT NOT NULL DEFAULT '{}'
    )
  `)
  console.log(`[game-db] Initialized at ${DB_PATH}`)
  return _db
}

export function saveGame(params: { imageCount: number; gameData: object }): number {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO game_results (image_count, game_data)
    VALUES ($image_count, $game_data)
  `).run({
    $image_count: params.imageCount,
    $game_data: JSON.stringify(params.gameData),
  })
  return Number(result.lastInsertRowid)
}
