// services/questionParser.js
// Parses raw question text (from PDF extraction) into structured question objects.
// Handles single-choice, multiple-choice, and inconsistent formatting.

const AWS_TOPICS = {
  S3:         ['s3 ', 'bucket', 'object storage', 'glacier', 'intelligent-tiering', 'transfer acceleration', 'cross-region replication'],
  EC2:        ['ec2', ' instance', 'ami ', 'auto scaling', 'launch template', 'spot instance', 'reserved instance', 'on-demand'],
  VPC:        ['vpc', 'subnet', 'route table', 'nat gateway', 'internet gateway', 'security group', 'nacl', 'peering', 'private subnet', 'public subnet'],
  RDS:        ['rds', 'aurora', 'mysql', 'postgresql', 'database', 'multi-az', 'read replica', 'db instance'],
  Lambda:     ['lambda', 'serverless', 'function url'],
  IAM:        ['iam', ' role', 'policy', 'permission', 'principal', 'sso', 'identity', 'organizations'],
  CloudFront: ['cloudfront', 'cdn', 'distribution', 'edge location', 'origin'],
  Route53:    ['route 53', 'route53', ' dns', 'hosted zone', 'health check', 'latency routing'],
  DynamoDB:   ['dynamodb', 'nosql', 'document database', 'dax'],
  SQS:        ['sqs', 'queue', 'message queue', 'dead-letter'],
  SNS:        ['sns', 'notification', 'pub/sub', 'topic'],
  ECS:        ['ecs', 'fargate', 'container', 'docker', 'eks', 'kubernetes'],
  CloudWatch: ['cloudwatch', 'monitoring', 'metrics', 'alarm', 'logs insight'],
  KMS:        ['kms', 'key management', 'encryption key', 'cmk', 'customer managed'],
  ELB:        ['load balancer', ' alb', ' nlb', ' elb ', 'application load balancer', 'network load balancer', 'target group'],
  Networking: ['direct connect', 'site-to-site vpn', 'transit gateway', 'global accelerator', 'vpn connection'],
  Storage:    ['efs', 'fsx', 'ebs volume', 'storage gateway', 'snowball', 'datasync', 'file server'],
};

/**
 * Detect the AWS topic most relevant to this question.
 */
function detectTopic(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const [topic, keywords] of Object.entries(AWS_TOPICS)) {
    scores[topic] = keywords.filter(kw => lower.includes(kw)).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : 'General';
}

/**
 * Parse a single raw question block into a structured object.
 * Returns null if the block can't be parsed reliably.
 */
function parseQuestionBlock(block) {
  const { num, raw, correct_raw } = block;

  // Remove "Topic N" prefix lines
  let text = raw.replace(/^Topic \d+.*$/gm, '').trim();

  // Split into non-empty lines
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const optionRe = /^([A-E])\.\s+(.+)/;
  const questionLines = [];
  const options = [];         // { label, text }
  let currentOpt = null;
  let currentOptParts = [];

  for (const line of lines) {
    const m = line.match(optionRe);
    if (m) {
      // Flush previous option
      if (currentOpt) {
        options.push({ label: currentOpt, text: currentOptParts.join(' ').trim() });
      }
      currentOpt = m[1];
      currentOptParts = [m[2]];
    } else if (currentOpt) {
      currentOptParts.push(line); // Multi-line option continuation
    } else {
      questionLines.push(line);
    }
  }
  if (currentOpt) {
    options.push({ label: currentOpt, text: currentOptParts.join(' ').trim() });
  }

  const questionText = questionLines.join(' ').trim();
  const optionTexts  = options.map(o => o.text);
  const optionLabels = options.map(o => o.label);

  if (!questionText || optionTexts.length < 2) return null;

  // Map correct answer letters (e.g. "BD") to 0-based indices
  const correctAnswers = [];
  if (correct_raw) {
    for (const ch of correct_raw.toUpperCase()) {
      const idx = optionLabels.indexOf(ch);
      if (idx !== -1) {
        correctAnswers.push(idx);
      } else {
        // Fallback: use ASCII offset
        const fallback = ch.charCodeAt(0) - 65;
        if (fallback >= 0 && fallback < optionTexts.length) {
          correctAnswers.push(fallback);
        }
      }
    }
  }

  if (correctAnswers.length === 0) return null; // Can't use without answer key

  const fullText = questionText + ' ' + optionTexts.join(' ');

  return {
    id:           num,
    question:     questionText,
    options:      optionTexts,
    correctAnswers,
    isMultiple:   correctAnswers.length > 1,
    topic:        detectTopic(fullText),
    explanation:  `The correct answer is ${correct_raw}. Review the AWS documentation for this topic.`,
  };
}

/**
 * Parse an array of raw blocks. Returns array of valid question objects.
 */
function parseAllQuestions(rawBlocks) {
  const results = [];
  let skipped = 0;

  for (const block of rawBlocks) {
    try {
      const q = parseQuestionBlock(block);
      if (q) {
        results.push(q);
      } else {
        skipped++;
      }
    } catch (err) {
      skipped++;
    }
  }

  console.log(`Parsed ${results.length} questions, skipped ${skipped}`);
  return results;
}

/**
 * Parse raw PDF text into question blocks.
 * Handles the two-column ExamTopics layout.
 */
function extractBlocksFromText(rawText) {
  // Remove noise
  let text = rawText
    .replace(/\d+\/\d+\/\d+.*?ExamTopics\n?/g, '')
    .replace(/https?:\/\/\S+\n?/g, '')
    .replace(/Viewing questions.*?\n/g, '')
    .replace(/Topic 1 - Exam [A-Z]\n?/g, '');

  // Split on "Question #N"
  const parts = text.split(/(Question #\d+)/);
  const blocks = [];

  for (let i = 1; i < parts.length - 1; i += 2) {
    const qnum = parts[i].trim();
    const body = parts[i + 1] || '';

    const caMatch = body.match(/Correct Answer:\s*([A-E]+)/);
    const correctRaw = caMatch ? caMatch[1].trim() : null;

    // Strip answer/vote noise
    const cleaned = body
      .replace(/Correct Answer:.*?\n/g, '')
      .replace(/Community vote distribution.*?\n/g, '')
      .replace(/Most Voted\n?/g, '')
      .replace(/\b[A-E]\s*\(\d+%\)\s*/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    if (cleaned.length > 30) {
      blocks.push({
        num: parseInt(qnum.replace('Question #', ''), 10),
        raw: cleaned,
        correct_raw: correctRaw,
      });
    }
  }

  return blocks;
}

module.exports = { parseQuestionBlock, parseAllQuestions, extractBlocksFromText, detectTopic };
