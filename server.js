require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
// Serve portfolio explicitly at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve testgen app
app.get("/testgen", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "testgen", "index.html"));
});

// Serve static assets
app.use(express.static(path.join(__dirname, "public")));
app.use("/testgen", express.static(path.join(__dirname, "public/testgen")));

// Supabase admin client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const FREE_LIMIT = 10; // generations per day

// ── Auth Middleware ────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized — please login" });
  }
  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: "Invalid or expired session — please login again" });
  }
  req.user = user;
  next();
}

// ── Usage Check Middleware ─────────────────────────
async function checkUsage(req, res, next) {
  const userId = req.user.id;
  const today = new Date().toISOString().split("T")[0];

  // Get or create usage record for today
  const { data, error } = await supabase
    .from("usage")
    .select("count")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  const currentCount = data?.count || 0;

  // Get user plan
  const { data: profile } = await supabase
    .from("profiles")
    .select("plan")
    .eq("id", userId)
    .single();

  const plan = profile?.plan || "free";
  const limit = plan === "pro" ? 999999 : FREE_LIMIT;

  if (currentCount >= limit) {
    return res.status(429).json({
      error: `Daily limit reached (${limit}/day on ${plan} plan). Upgrade to Pro for unlimited generations.`,
      count: currentCount,
      limit
    });
  }

  req.currentCount = currentCount;
  req.today = today;
  next();
}

// ── Increment Usage ────────────────────────────────
async function incrementUsage(userId, today, currentCount) {
  await supabase.from("usage").upsert({
    user_id: userId,
    date: today,
    count: currentCount + 1
  }, { onConflict: "user_id,date" });
}

// ── Groq Route ─────────────────────────────────────
app.post("/generate/groq", requireAuth, checkUsage, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GROQ_API_KEY not set" });
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: req.body.prompt }],
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    await incrementUsage(req.user.id, req.today, req.currentCount);
    res.json({ text: data.choices?.[0]?.message?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gemini Route ───────────────────────────────────
app.post("/generate/gemini", requireAuth, checkUsage, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    await incrementUsage(req.user.id, req.today, req.currentCount);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Usage Stats Route ──────────────────────────────
app.get("/usage", requireAuth, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const { data } = await supabase
    .from("usage")
    .select("count")
    .eq("user_id", req.user.id)
    .eq("date", today)
    .single();
  const { data: profile } = await supabase
    .from("profiles")
    .select("plan")
    .eq("id", req.user.id)
    .single();
  const plan = profile?.plan || "free";
  const limit = plan === "pro" ? 999999 : FREE_LIMIT;
  res.json({ count: data?.count || 0, limit, plan });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ TestGen AI running!`);
  console.log(`👉 Open http://localhost:${PORT}\n`);
});
