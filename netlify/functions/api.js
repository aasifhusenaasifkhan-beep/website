const express = require("express");
const cors = require("cors");
const serverless = require("serverless-http");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY; // Service Role Key for DB ops
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// Naya variable: Client-side upload ke liye
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY; 

let supabase;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
}

// Admin Auth Middleware
const adminAuth = (req, res, next) => {
  if (req.headers.authorization === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized. Galat password!" });
};

// URL Sanitizer function
function sanitizeShortener(dashUrl, apiKey) {
  let cleanUrl = (dashUrl || "").trim().replace(/^(https?:\/\/|https?\/\/|https?:|http?:)/i, "").replace(/^\/+|\/+$/g, "").replace(/\s+/g, "");
  let cleanKey = (apiKey || "").trim().replace(/\s+/g, "");
  return { cleanUrl, cleanKey };
}

const router = express.Router();

// ==================== ADMIN ROUTES ====================

// Login & Get Supabase Config for Direct Upload (Bypasses Netlify Load)
router.post("/admin/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    return res.json({ 
      success: true, 
      supabaseUrl: SUPABASE_URL, 
      supabaseAnonKey: SUPABASE_ANON_KEY 
    });
  }
  return res.status(401).json({ error: "Galat Password!" });
});

// Save Post (Sirf Text data, Image frontend se upload hogi)
router.post("/admin/add-post", adminAuth, async (req, res) => {
  try {
    const { name, image_url, release_date, genres, season, short_story, category } = req.body;
    const { data, error } = await supabase.from("posts").insert({
      name, image_url, release_date, genres, season, short_story, category
    }).select();
    if (error) throw error;
    res.json({ success: true, post: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Posts List
router.get("/admin/posts", adminAuth, async (req, res) => {
  let query = supabase.from("posts").select("*").order("created_at", { ascending: false });
  if (req.query.search) query = query.ilike("name", `%${req.query.search}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Add Episode with Tag
router.post("/admin/add-episode", adminAuth, async (req, res) => {
  const { post_id, episode_label, original_link } = req.body;
  const { data, error } = await supabase.from("episodes").insert({ post_id, episode_label, original_link }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// Delete Post (Cascade) & Files
router.post("/admin/delete-post", adminAuth, async (req, res) => {
  const { post_id } = req.body;
  const { data: post } = await supabase.from("posts").select("image_url").eq("id", post_id).single();
  if (post && post.image_url) {
    const fileName = post.image_url.split("/").pop();
    await supabase.storage.from("Post-images").remove([fileName]);
  }
  const { error } = await supabase.from("posts").delete().eq("id", post_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Delete Episode
router.post("/admin/delete-episode", adminAuth, async (req, res) => {
  const { error } = await supabase.from("episodes").delete().eq("id", req.body.episode_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Admin Get Episodes (Contains original_link for management)
router.get("/admin/episodes/:postId", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("episodes").select("*").eq("post_id", req.params.postId).order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Shortener Management
router.get("/admin/shorteners", adminAuth, async (req, res) => {
  const { data } = await supabase.from("shorteners").select("*");
  res.json(data || []);
});
router.post("/admin/add-shortener", adminAuth, async (req, res) => {
  const { dashboard_url, api_key } = req.body;
  const { cleanUrl, cleanKey } = sanitizeShortener(dashboard_url, api_key);
  const { count } = await supabase.from("shorteners").select("*", { count: "exact" });
  if (count >= 3) return res.status(400).json({ error: "Sirf 3 shorteners allowed hain!" });
  const { data, error } = await supabase.from("shorteners").insert({ dashboard_url: cleanUrl, api_key: cleanKey }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});
router.post("/admin/delete-shortener", adminAuth, async (req, res) => {
  await supabase.from("shorteners").delete().eq("id", req.body.id);
  res.json({ success: true });
});

// Settings & Premium
router.post("/admin/save-settings", adminAuth, async (req, res) => {
  await supabase.from("settings").upsert({ id: 1, channel_link: req.body.channel_link, group_link: req.body.group_link });
  res.json({ success: true });
});
router.post("/admin/add-premium", adminAuth, async (req, res) => {
  const expires_at = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("premium_users").upsert({ username: req.body.username, password: req.body.password, expires_at }, { onConflict: "username" });
  res.json({ success: true, expires_at });
});


// ==================== PUBLIC SITE ROUTES ====================

// 1. Get Settings
router.get("/public/settings", async (req, res) => {
  const { data } = await supabase.from("settings").select("*").eq("id", 1).single();
  res.json(data || { channel_link: "", group_link: "" });
});

// 2. Get Public Posts
router.get("/public/posts", async (req, res) => {
  const { data } = await supabase.from("posts").select("*").order("created_at", { ascending: false });
  res.json(data || []);
});

// 3. Get Public Episodes (ANTI-BYPASS: No original_link selected)
router.get("/public/episodes/:postId", async (req, res) => {
  const { data, error } = await supabase.from("episodes")
    .select("id, post_id, episode_label, created_at") 
    .eq("post_id", req.params.postId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 4. Generate Shortlink
router.get("/public/shorten", async (req, res) => {
  const { ep_id } = req.query;
  try {
    const { data: ep } = await supabase.from("episodes").select("original_link").eq("id", ep_id).single();
    if (!ep) return res.status(404).json({ error: "Episode nahi mila" });

    const { data: shorteners } = await supabase.from("shorteners").select("*");
    if (!shorteners || shorteners.length === 0) return res.json({ shortLink: ep.original_link });

    const raw = shorteners[Math.floor(Math.random() * shorteners.length)];
    const apiUrl = `https://${raw.dashboard_url}/api/${raw.api_key}?url=${encodeURIComponent(ep.original_link)}`;
    
    const response = await fetch(apiUrl);
    const text = await response.text();
    let shortLink = text.trim();
    try {
      const json = JSON.parse(text);
      shortLink = json.shortenedUrl || json.short_url || json.url || text;
    } catch (e) {}

    res.json({ shortLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Premium Authentication
router.post("/public/premium-login", async (req, res) => {
  const { username, password, ep_id } = req.body;
  try {
    const { data: user, error } = await supabase.from("premium_users")
      .select("*").eq("username", username).eq("password", password).single();
    
    if (error || !user) return res.status(401).json({ error: "Galat Username ya Password!" });
    if (new Date(user.expires_at) < new Date()) return res.status(401).json({ error: "Premium pack expire ho chuka hai!" });

    const { data: ep } = await supabase.from("episodes").select("original_link").eq("id", ep_id).single();
    res.json({ success: true, original_link: ep.original_link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/api", router);
app.use("/.netlify/functions/api", router);

module.exports.handler = serverless(app);
