// importQuestions.js
// Run ONCE to seed the database: node importQuestions.js
// Place questions.json in the same folder as this file.

const path = require('path');
const fs   = require('fs');
const { getDb } = require('./database');

const JSON_PATH = path.join(__dirname, 'questions.json');

if (!fs.existsSync(JSON_PATH)) {
  console.error('ERROR: questions.json not found.');
  console.error('Place questions.json in the backend/ folder and try again.');
  process.exit(1);
}

console.log('Reading questions.json...');
const questions = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
console.log(`Found ${questions.length} questions`);

const db = getDb();

const insert = db.prepare(`
  INSERT OR REPLACE INTO questions (id, question, options, correct, is_multiple, topic, explanation)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const importAll = db.transaction((qs) => {
  let count = 0;
  for (const q of qs) {
    if (!q.question || !q.options || !q.correctAnswers) continue;
    insert.run(
      q.id,
      q.question,
      JSON.stringify(q.options),
      JSON.stringify(q.correctAnswers),
      q.isMultiple ? 1 : 0,
      q.topic || 'General',
      q.explanation || `The correct answer is ${String.fromCharCode(65 + q.correctAnswers[0])}.`
    );
    count++;
  }
  return count;
});

const imported = importAll(questions);
console.log(`\nImported ${imported} questions successfully.`);

// Print topic breakdown
const topics = db.prepare(
  'SELECT topic, COUNT(*) as count FROM questions GROUP BY topic ORDER BY count DESC'
).all();

console.log('\nTopic breakdown:');
for (const t of topics) {
  console.log(`  ${t.topic.padEnd(20)} ${t.count}`);
}

console.log('\nDone! Run `npm start` to launch the server.');
