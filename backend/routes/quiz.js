// routes/quiz.js — Quiz session management: start, submit, results

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

const router = express.Router();

// ── POST /api/quiz/start ─────────────────────────────────────────────────────
// Create a new quiz attempt, return the questions (without correct answers)
router.post('/start', (req, res) => {
  const db = getDb();
  const { topic = 'all', count = 65, shuffle = true, multipleOnly = false } = req.body;

  // Build question query
  let query = 'SELECT * FROM questions';
  const params = [];
  const conditions = [];

  if (topic !== 'all') {
    conditions.push('topic = ?');
    params.push(topic);
  }
  if (multipleOnly) {
    conditions.push('is_multiple = 1');
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  if (shuffle) query += ' ORDER BY RANDOM()';
  query += ' LIMIT ?';
  params.push(Math.min(parseInt(count, 10), 200)); // Cap at 200

  const rows = db.prepare(query).all(...params);

  if (rows.length === 0) {
    return res.status(404).json({ error: 'No questions found for the given filters' });
  }

  // Create attempt record
  const attemptId = uuidv4();
  const settings  = JSON.stringify({ topic, count: rows.length, shuffle, multipleOnly });

  db.prepare(`
    INSERT INTO attempts (id, settings) VALUES (?, ?)
  `).run(attemptId, settings);

  // Return questions WITHOUT correct answers (exam mode)
  const questions = rows.map(row => ({
    id:        row.id,
    question:  row.question,
    options:   JSON.parse(row.options),
    isMultiple: row.is_multiple === 1,
    topic:     row.topic,
    // NO correctAnswers here
  }));

  res.json({
    attemptId,
    questions,
    total:    questions.length,
    timeLimit: Math.max(rows.length * 72, 3600), // 72 seconds per question, min 60 min
  });
});

// ── POST /api/quiz/submit ────────────────────────────────────────────────────
// Submit answers, calculate score, return full results with explanations
router.post('/submit', (req, res) => {
  const db = getDb();
  const { attemptId, answers, timeTaken } = req.body;
  // answers: [{ questionId, selected: [0,2], flagged: false }, ...]

  if (!attemptId || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'attemptId and answers are required' });
  }

  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

  // Fetch all questions in this attempt at once for efficiency
  const questionIds = answers.map(a => a.questionId);
  const placeholders = questionIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM questions WHERE id IN (${placeholders})`).all(...questionIds);
  const questionMap = {};
  for (const row of rows) questionMap[row.id] = row;

  // Score each answer
  const insertAnswer = db.prepare(`
    INSERT OR REPLACE INTO attempt_answers (attempt_id, question_id, selected, is_correct, flagged)
    VALUES (?, ?, ?, ?, ?)
  `);

  let correct = 0;
  const detailedResults = [];

  const scoreAll = db.transaction(() => {
    for (const ans of answers) {
      const row = questionMap[ans.questionId];
      if (!row) continue;

      const correctArr   = JSON.parse(row.correct);
      const selectedArr  = ans.selected || [];

      // Strict matching: must select ALL correct and ONLY correct answers
      const isCorrect =
        correctArr.length === selectedArr.length &&
        correctArr.every(c => selectedArr.includes(c));

      if (isCorrect) correct++;

      insertAnswer.run(
        attemptId,
        ans.questionId,
        JSON.stringify(selectedArr),
        isCorrect ? 1 : 0,
        ans.flagged ? 1 : 0
      );

      detailedResults.push({
        questionId:     ans.questionId,
        question:       row.question,
        options:        JSON.parse(row.options),
        selected:       selectedArr,
        correctAnswers: correctArr,
        isCorrect,
        flagged:        ans.flagged || false,
        topic:          row.topic,
        explanation:    row.explanation,
      });
    }
  });

  scoreAll();

  // Update attempt with final score
  db.prepare(`
    UPDATE attempts
    SET finished_at = datetime('now'), score = ?, total = ?, time_taken = ?
    WHERE id = ?
  `).run(correct, answers.length, timeTaken || 0, attemptId);

  // Topic breakdown
  const topicBreakdown = {};
  for (const r of detailedResults) {
    if (!topicBreakdown[r.topic]) topicBreakdown[r.topic] = { correct: 0, total: 0 };
    topicBreakdown[r.topic].total++;
    if (r.isCorrect) topicBreakdown[r.topic].correct++;
  }

  const percentage = answers.length > 0 ? Math.round((correct / answers.length) * 100) : 0;
  const passed     = percentage >= 72; // AWS SAA pass mark is ~72%

  res.json({
    attemptId,
    score:       correct,
    total:       answers.length,
    percentage,
    passed,
    timeTaken:   timeTaken || 0,
    topicBreakdown,
    results:     detailedResults,
  });
});

// ── GET /api/quiz/attempts ───────────────────────────────────────────────────
router.get('/attempts', (req, res) => {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT id, started_at, finished_at, score, total, time_taken, settings
    FROM attempts
    WHERE finished_at IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 50
  `).all();

  const attempts = rows.map(row => ({
    id:         row.id,
    startedAt:  row.started_at,
    finishedAt: row.finished_at,
    score:      row.score,
    total:      row.total,
    percentage: row.total > 0 ? Math.round((row.score / row.total) * 100) : 0,
    passed:     row.total > 0 && (row.score / row.total) >= 0.72,
    timeTaken:  row.time_taken,
    settings:   JSON.parse(row.settings),
  }));

  res.json(attempts);
});

// ── GET /api/quiz/attempts/:id ───────────────────────────────────────────────
router.get('/attempts/:id', (req, res) => {
  const db      = getDb();
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(req.params.id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

  const answers = db.prepare(`
    SELECT aa.*, q.question, q.options, q.correct, q.topic, q.explanation
    FROM attempt_answers aa
    JOIN questions q ON aa.question_id = q.id
    WHERE aa.attempt_id = ?
  `).all(req.params.id);

  const results = answers.map(row => ({
    questionId:     row.question_id,
    question:       row.question,
    options:        JSON.parse(row.options),
    selected:       JSON.parse(row.selected),
    correctAnswers: JSON.parse(row.correct),
    isCorrect:      row.is_correct === 1,
    flagged:        row.flagged === 1,
    topic:          row.topic,
    explanation:    row.explanation,
  }));

  const pct = attempt.total > 0 ? Math.round((attempt.score / attempt.total) * 100) : 0;

  res.json({
    attemptId:  attempt.id,
    startedAt:  attempt.started_at,
    finishedAt: attempt.finished_at,
    score:      attempt.score,
    total:      attempt.total,
    percentage: pct,
    passed:     pct >= 72,
    timeTaken:  attempt.time_taken,
    settings:   JSON.parse(attempt.settings),
    results,
  });
});

// ── GET /api/quiz/weak-areas ─────────────────────────────────────────────────
// Aggregate topic performance across all attempts
router.get('/weak-areas', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT q.topic,
           COUNT(*)                                          AS total,
           SUM(CASE WHEN aa.is_correct = 1 THEN 1 ELSE 0 END) AS correct
    FROM attempt_answers aa
    JOIN questions q ON aa.question_id = q.id
    GROUP BY q.topic
    ORDER BY (CAST(correct AS FLOAT) / total) ASC
  `).all();

  const areas = rows.map(r => ({
    topic:      r.topic,
    total:      r.total,
    correct:    r.correct,
    percentage: Math.round((r.correct / r.total) * 100),
  }));

  res.json(areas);
});

module.exports = router;
