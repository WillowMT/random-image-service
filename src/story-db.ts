/**
 * Story Generation Database — SQLite persistence layer
 *
 * Uses Bun's built-in bun:sqlite for zero-dependency storage.
 * Stores each generated story + collage + image metadata.
 */

import { Database } from "bun:sqlite"
import { mkdir } from "fs/promises"
import { existsSync } from "fs"
import { dirname } from "path"

// ─── Config ───────────────────────────────────────────────────────

const DB_PATH = process.env.STORY_DB_PATH || "/app/data/stories.db"

// ─── Types ────────────────────────────────────────────────────────

export interface StoryRecord {
  id: number
  created_at: string
  story: string
  collage_base64: string
  /** JSON array of { zip, path } */
  images: string
  provider: string
  image_count: number
}

export interface StoryHistoryEntry {
  id: number
  created_at: string
  story_preview: string
  provider: string
  image_count: number
}

// ─── Init ─────────────────────────────────────────────────────────

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db

  // Ensure the directory exists
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) {
    // sync mkdir for startup — this runs once
    try {
      const { mkdirSync } = require("fs")
      mkdirSync(dir, { recursive: true })
    } catch { /* volume might already exist */ }
  }

  _db = new Database(DB_PATH)
  _db.run("PRAGMA journal_mode = WAL")  // better concurrent reads
  _db.run("PRAGMA synchronous = NORMAL") // balance speed/durability

  // Create table if not exists
  _db.run(`
    CREATE TABLE IF NOT EXISTS story_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      story TEXT NOT NULL,
      collage_base64 TEXT NOT NULL,
      images TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL DEFAULT 'generated',
      image_count INTEGER NOT NULL DEFAULT 0
    )
  `)

  console.log(`[story-db] Initialized at ${DB_PATH}`)
  return _db
}

// ─── CRUD ─────────────────────────────────────────────────────────

/**
 * Save a story generation to the database.
 * Returns the new record's ID.
 */
export function saveStory(params: {
  story: string
  collageBase64: string
  images: Array<{ zip: string; path: string }>
  provider: string
  imageCount: number
}): number {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO story_generations (story, collage_base64, images, provider, image_count)
    VALUES ($story, $collage, $images, $provider, $image_count)
  `)

  const result = stmt.run({
    $story: params.story,
    $collage: params.collageBase64,
    $images: JSON.stringify(params.images),
    $provider: params.provider,
    $image_count: params.imageCount,
  })

  return Number(result.lastInsertRowid)
}

/**
 * Get a single story by ID.
 */
export function getStory(id: number): StoryRecord | null {
  const db = getDb()
  const row = db.query("SELECT * FROM story_generations WHERE id = $id").get({ $id: id }) as StoryRecord | null
  return row || null
}

/**
 * Get the most recent stories (for history display).
 */
export function getRecentStories(limit: number = 20, offset: number = 0): StoryHistoryEntry[] {
  const db = getDb()
  const rows = db.query(`
    SELECT id, created_at, provider, image_count,
           substr(story, 1, 120) as story_preview
    FROM story_generations
    ORDER BY id DESC
    LIMIT $limit OFFSET $offset
  `).all({ $limit: limit, $offset: offset }) as StoryHistoryEntry[]

  return rows || []
}

/**
 * Get total count of stories in the database.
 */
export function getStoryCount(): number {
  const db = getDb()
  const row = db.query("SELECT COUNT(*) as count FROM story_generations").get() as { count: number }
  return row?.count || 0
}

/**
 * Delete a story by ID.
 */
export function deleteStory(id: number): boolean {
  const db = getDb()
  const result = db.run("DELETE FROM story_generations WHERE id = $id", { $id: id })
  return result.changes > 0
}

/**
 * Close the database connection (for graceful shutdown).
 */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}