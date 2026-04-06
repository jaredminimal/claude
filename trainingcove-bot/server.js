const http = require("http");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;

const PORT = 3847;
const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY env var
const CACHE_FILE = path.join(__dirname, "answer-cache.json");

// ── Answer Cache ─────────────────────────────────────────────────
// Stores: { "question_key": { correct: answerIndex, wrong: [indices] } }
let cache = {};
try {
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    console.log(`Loaded ${Object.keys(cache).length} cached answers\n`);
  }
} catch (e) {
  cache = {};
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function cacheKey(question) {
  // Use first 100 chars of question as key (normalized)
  return question.replace(/\s+/g, " ").trim().substring(0, 100).toLowerCase();
}

const SYSTEM_PROMPT = `You are an expert on Arizona real estate law, fair housing, water rights, fire safety, deed fraud, landlord-tenant law, agency law, contracts, ethics, and all topics covered in Arizona Department of Real Estate continuing education courses.

You are answering multiple-choice questions from Arizona real estate training courses on TrainingCove. These cover topics including but not limited to:
- Fair Housing Act, protected classes, discrimination, HUD testing
- Arizona water resources, groundwater, CAP, ADWR
- Wildfire prevention, defensible space, Firewise USA
- Deed fraud prevention, title protection, recording
- Landlord-tenant law, leases, evictions, property management
- Agency relationships (express, implied, ostensible)
- Real estate ethics and Code of Ethics
- Disability accommodations, ESAs, ADA
- Equal Credit Opportunity Act, lending discrimination

Think carefully about each question. Consider all options before answering.
For True/False questions, remember that implied agency CAN exist without a formal written agreement.
Respond with ONLY the zero-based index number of the correct option (0, 1, 2, 3, etc.).
Do not include any other text, explanation, or punctuation. Just the number.`;

const server = http.createServer(async (req, res) => {
  // CORS headers for Tampermonkey
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Answer a question ──────────────────────────────────────────
  if (req.method === "POST" && req.url === "/answer") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { question, options } = JSON.parse(body);
        const key = cacheKey(question);

        // Check cache for a known correct answer
        if (cache[key] && cache[key].correct !== undefined) {
          const cachedAnswer = cache[key].correct;
          console.log(`Q: ${question.substring(0, 80)}...`);
          console.log(`   CACHED CORRECT: ${cachedAnswer} (${options[cachedAnswer]})\n`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ answer: cachedAnswer }));
          return;
        }

        // Check cache for known wrong answers to exclude
        const wrongAnswers = (cache[key] && cache[key].wrong) || [];

        const optionsText = options
          .map((opt, i) => {
            if (wrongAnswers.includes(i)) {
              return `${i}: ${opt} [KNOWN WRONG - DO NOT PICK]`;
            }
            return `${i}: ${opt}`;
          })
          .join("\n");

        const userMessage = `Question: ${question}\n\nOptions:\n${optionsText}`;

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 16,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        });

        const answerText = response.content[0].text.trim();
        const answerIndex = parseInt(answerText, 10);

        console.log(`Q: ${question.substring(0, 80)}...`);
        console.log(`   Options: ${options.join(" | ")}`);
        if (wrongAnswers.length > 0) {
          console.log(`   Known wrong: ${wrongAnswers.map(i => options[i]).join(", ")}`);
        }
        console.log(`   Answer: ${answerIndex} (${options[answerIndex]})\n`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answer: answerIndex }));
      } catch (err) {
        console.error("Error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Report a correct answer (cache it) ─────────────────────────
  if (req.method === "POST" && req.url === "/correct") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { question, answerIndex } = JSON.parse(body);
        const key = cacheKey(question);
        if (!cache[key]) cache[key] = {};
        cache[key].correct = answerIndex;
        saveCache();
        console.log(`   ✓ Cached correct answer for: ${question.substring(0, 60)}...\n`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Report a wrong answer (cache it) ───────────────────────────
  if (req.method === "POST" && req.url === "/wrong") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { question, answerIndex } = JSON.parse(body);
        const key = cacheKey(question);
        if (!cache[key]) cache[key] = { wrong: [] };
        if (!cache[key].wrong) cache[key].wrong = [];
        if (!cache[key].wrong.includes(answerIndex)) {
          cache[key].wrong.push(answerIndex);
        }
        saveCache();
        console.log(`   ✗ Cached wrong answer ${answerIndex} for: ${question.substring(0, 60)}...\n`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", cached: Object.keys(cache).length }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`TrainingCove answer server running on http://localhost:${PORT}`);
  console.log(`POST /answer   - Get answer (checks cache first)`);
  console.log(`POST /correct  - Report correct answer (caches it)`);
  console.log(`POST /wrong    - Report wrong answer (excludes on retry)`);
  console.log(`GET  /health   - Health check\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARNING: ANTHROPIC_API_KEY not set! Set it with:");
    console.warn("  export ANTHROPIC_API_KEY=sk-ant-...\n");
  }
});
