// routes/questions.js — CRUD + search for questions, PDF upload endpoint

const express  = require('express');
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const { getDb } = require('../database');
const { extractBlocksFromText, parseAllQuestions } = require('../services/questionParser');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── GET /api/questions ───────────────────────────────────────────────────────
// Query params: topic, count, multiple, shuffle
router.get('/', (req, res) => {
  const db = getDb();
  const { topic, count = 65, multiple, shuffle = 'true', ids } = req.query;

  let query  = 'SELECT * FROM questions';
  const params = [];
  const conditions = [];

  if (topic && topic !== 'all') {
    conditions.push('topic = ?');
    params.push(topic);
  }
  if (multiple === 'true') {
    conditions.push('is_multiple = 1');
  }
  if (ids) {
    const idList = ids.split(',').map(Number).filter(Boolean);
    conditions.push(`id IN (${idList.map(() => '?').join(',')})`);
    params.push(...idList);
  }

  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  if (shuffle === 'true') query += ' ORDER BY RANDOM()';
  query += ' LIMIT ?';
  params.push(parseInt(count, 10));

  const rows = db.prepare(query).all(...params);

  // Parse JSON fields before sending
  const questions = rows.map(row => ({
    id:           row.id,
    question:     row.question,
    options:      JSON.parse(row.options),
    correctAnswers: JSON.parse(row.correct),
    isMultiple:   row.is_multiple === 1,
    topic:        row.topic,
    explanation:  row.explanation,
  }));

  res.json({ questions, total: questions.length });
});

// ── GET /api/questions/topics ────────────────────────────────────────────────
router.get('/topics', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT topic, COUNT(*) as count FROM questions GROUP BY topic ORDER BY count DESC'
  ).all();
  res.json(rows);
});

// ── GET /api/questions/stats ─────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const db = getDb();
  const total    = db.prepare('SELECT COUNT(*) as n FROM questions').get().n;
  const multiple = db.prepare('SELECT COUNT(*) as n FROM questions WHERE is_multiple = 1').get().n;
  const topics   = db.prepare('SELECT topic, COUNT(*) as count FROM questions GROUP BY topic').all();
  res.json({ total, multiple, single: total - multiple, topics });
});

// ── GET /api/questions/:id ───────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Question not found' });

  res.json({
    id:           row.id,
    question:     row.question,
    options:      JSON.parse(row.options),
    correctAnswers: JSON.parse(row.correct),
    isMultiple:   row.is_multiple === 1,
    topic:        row.topic,
    explanation:  row.explanation,
  });
});

// ── PUT /api/questions/:id ───────────────────────────────────────────────────
// Manual correction of a question
router.put('/:id', (req, res) => {
  const db = getDb();
  const { question, options, correctAnswers, topic, explanation } = req.body;
  if (!question || !options || !correctAnswers) {
    return res.status(400).json({ error: 'question, options, and correctAnswers are required' });
  }

  db.prepare(`
    UPDATE questions
    SET question = ?, options = ?, correct = ?, is_multiple = ?, topic = ?, explanation = ?
    WHERE id = ?
  `).run(
    question,
    JSON.stringify(options),
    JSON.stringify(correctAnswers),
    correctAnswers.length > 1 ? 1 : 0,
    topic || 'General',
    explanation || '',
    req.params.id
  );

  res.json({ success: true });
});

// ── POST /api/questions/upload-pdf ───────────────────────────────────────────
// Upload a PDF, parse questions, return preview (no save yet)
router.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const data   = await pdfParse(req.file.buffer);
    const blocks = extractBlocksFromText(data.text);
    const parsed = parseAllQuestions(blocks);

    res.json({
      preview:  parsed.slice(0, 5),  // Show first 5 for preview
      total:    parsed.length,
      _parsed:  parsed,              // Full data (used by /confirm endpoint)
    });
  } catch (err) {
    console.error('PDF parse error:', err);
    res.status(500).json({ error: 'Failed to parse PDF: ' + err.message });
  }
});

// ── POST /api/questions/import ───────────────────────────────────────────────
// Bulk import parsed questions (from PDF upload confirmation)
router.post('/import', (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions array is required' });
  }

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO questions (id, question, options, correct, is_multiple, topic, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const importMany = db.transaction((qs) => {
    let count = 0;
    for (const q of qs) {
      insert.run(
        q.id,
        q.question,
        JSON.stringify(q.options),
        JSON.stringify(q.correctAnswers),
        q.isMultiple ? 1 : 0,
        q.topic || 'General',
        q.explanation || ''
      );
      count++;
    }
    return count;
  });

  const count = importMany(questions);
  res.json({ success: true, imported: count });
});

module.exports = router;
