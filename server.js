require("dotenv").config();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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

// ── Create Subscription ────────────────────────────
app.post("/create-subscription", requireAuth, async (req, res) => {
  try {
    const subscription = await razorpay.subscriptions.create({
      plan_id: process.env.RAZORPAY_PLAN_ID,
      customer_notify: 1,
      total_count: 12,
      notes: { user_id: req.user.id, email: req.user.email }
    });
    res.json({ subscription_id: subscription.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Verify Payment & Upgrade User ─────────────────
app.post("/verify-payment", requireAuth, async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
  try {
    // Verify signature
    const text = razorpay_payment_id + "|" + razorpay_subscription_id;
    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(text)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Upgrade user to pro in Supabase
    await supabase
      .from("profiles")
      .update({
        plan: "pro",
        subscription_id: razorpay_subscription_id,
        payment_id: razorpay_payment_id
      })
      .eq("id", req.user.id);

    res.json({ success: true, plan: "pro" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cancel Subscription ────────────────────────────
app.post("/cancel-subscription", requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("subscription_id")
      .eq("id", req.user.id)
      .single();

    if (profile?.subscription_id) {
      await razorpay.subscriptions.cancel(profile.subscription_id);
    }

    await supabase
      .from("profiles")
      .update({ plan: "free", subscription_id: null })
      .eq("id", req.user.id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Serve Razorpay Key safely to frontend ──────────
app.get("/config", (req, res) => {
  res.json({ razorpay_key: process.env.RAZORPAY_KEY_ID });
});
// ── Admin Auth Middleware ──────────────────────────
function requireAdmin(req, res, next) {
  const password = req.headers['x-admin-password'];
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Admin Stats ────────────────────────────────────
app.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    // Total users
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true });

    // Pro users
    const { count: proUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('plan', 'pro');

    // Recent signups (last 10)
    const { data: recentUsers } = await supabase
      .from('profiles')
      .select('email, plan, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    // Daily generations last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const { data: dailyUsage } = await supabase
      .from('usage')
      .select('date, count')
      .gte('date', sevenDaysAgo.toISOString().split('T')[0])
      .order('date', { ascending: true });

    // Aggregate daily totals
    const dailyTotals = {};
    dailyUsage?.forEach(row => {
      dailyTotals[row.date] = (dailyTotals[row.date] || 0) + row.count;
    });

    // Revenue (pro users * 99)
    const revenueINR = (proUsers || 0) * 99;

    res.json({
      totalUsers: totalUsers || 0,
      proUsers: proUsers || 0,
      freeUsers: (totalUsers || 0) - (proUsers || 0),
      revenueINR,
      recentUsers: recentUsers || [],
      dailyGenerations: dailyTotals
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Link Checker ───────────────────────────────────
const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post("/check-links", async (req, res) => {
  const { targetUrl } = req.body;
  if (!targetUrl) return res.status(400).json({ error: "URL is required" });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `You are a link checker.

Step 1: Use web_search to visit this URL and retrieve its content: ${targetUrl}
Step 2: From the page content, extract every hyperlink (<a href>) you can find.
Step 3: For each link determine if it is reachable (working=2xx, redirect=3xx, broken=4xx/5xx/unreachable).

After you have gathered the information output ONLY a JSON array like this (no other text, no markdown):
[{"url":"https://example.com/page","text":"Link Label","status":"working","code":200}]

Rules:
- Resolve relative URLs using base: ${targetUrl}
- Max 30 unique links
- Use "broken" with code 0 for unreachable links
- Output ONLY the raw JSON array, nothing else`
      }]
    });

    // Extract text from response
    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => {
  console.log(`\n✅ TestGen AI running!`);
  console.log(`👉 Open http://localhost:${PORT}\n`);
});
