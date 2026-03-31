const http = require("http");
const Anthropic = require("@anthropic-ai/sdk").default;

const PORT = 3847;
const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY env var

const SYSTEM_PROMPT = `You are answering multiple-choice questions from an Arizona real estate training course (TrainingCove).
Pick the single best answer. Respond with ONLY the zero-based index number of the correct option (0, 1, 2, or 3).
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

  if (req.method === "POST" && req.url === "/answer") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { question, options } = JSON.parse(body);

        const optionsText = options
          .map((opt, i) => `${i}: ${opt}`)
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

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`TrainingCove answer server running on http://localhost:${PORT}`);
  console.log(`POST /answer  - Send { question, options } to get an answer`);
  console.log(`GET  /health  - Health check\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARNING: ANTHROPIC_API_KEY not set! Set it with:");
    console.warn("  export ANTHROPIC_API_KEY=sk-ant-...\n");
  }
});
