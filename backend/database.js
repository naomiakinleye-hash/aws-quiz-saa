// database.js — SQLite database setup using better-sqlite3
// Creates all tables on first run. Safe to call multiple times.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'quiz.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL'); // Better concurrent performance
    db.pragma('foreign_keys = ON');
    initializeTables();
  }
  return db;
}

function initializeTables() {
  db.exec(`
    -- Questions table: stores all exam questions
    CREATE TABLE IF NOT EXISTS questions (
      id          INTEGER PRIMARY KEY,
      question    TEXT    NOT NULL,
      options     TEXT    NOT NULL,  -- JSON array of option strings
      correct     TEXT    NOT NULL,  -- JSON array of 0-based indices
      is_multiple INTEGER NOT NULL DEFAULT 0,
      topic       TEXT    NOT NULL DEFAULT 'General',
      explanation TEXT    NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Quiz attempts: one row per quiz session
    CREATE TABLE IF NOT EXISTS attempts (
      id          TEXT    PRIMARY KEY,  -- UUID
      started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      score       INTEGER,
      total       INTEGER,
      time_taken  INTEGER,             -- seconds
      settings    TEXT    NOT NULL DEFAULT '{}'  -- JSON: topic filter, count, etc.
    );

    -- Attempt answers: one row per question answered in a session
    CREATE TABLE IF NOT EXISTS attempt_answers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id  TEXT    NOT NULL REFERENCES attempts(id),
      question_id INTEGER NOT NULL REFERENCES questions(id),
      selected    TEXT    NOT NULL DEFAULT '[]',  -- JSON array of selected indices
      is_correct  INTEGER NOT NULL DEFAULT 0,
      flagged     INTEGER NOT NULL DEFAULT 0
    );

    -- Indexes for fast lookups
    CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic);
    CREATE INDEX IF NOT EXISTS idx_attempt_answers_attempt ON attempt_answers(attempt_id);
  `);
}

module.exports = { getDb };
