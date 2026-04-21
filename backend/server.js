// server.js — Main Express server
// Run with: node server.js   OR   npm run dev (with nodemon)

const express   = require('express');
const cors      = require('cors');
const path      = require('path');

const questionsRouter = require('./routes/questions');
const quizRouter      = require('./routes/quiz');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' })); // Allow all origins for local development
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve frontend static files in production
app.use(express.static(path.join(__dirname, '../frontend')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/questions', questionsRouter);
app.use('/api/quiz',      quizRouter);

// Health check
app.get('/api/health', (req, res) => {
  const { getDb } = require('./database');
  const db    = getDb();
  const count = db.prepare('SELECT COUNT(*) as n FROM questions').get().n;
  res.json({ status: 'ok', questions: count, timestamp: new Date().toISOString() });
});

// Catch-all: serve frontend for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n AWS Quiz API running at http://localhost:${PORT}`);
  console.log(` Frontend at       http://localhost:${PORT}\n`);
});

module.exports = app;
