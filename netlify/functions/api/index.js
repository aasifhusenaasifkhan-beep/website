const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// Multer in-memory storage (Vercel Serverless compatibility)
const upload = multer({ storage: multer.memoryStorage() });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // Admin panel login pass

// Crash-proof client initialization
let supabase;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
} else {
  console.warn("⚠️ Warning: Supabase environment variables missing! Functions will fail.");
}

// Auth Middleware for Admin
const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized. Galat password!" });
};

// Test route to check backend status
app.get("/api/health", (req, res) => {
  res.json({ status: "running", database_connected: !!supabase });
});

// --- ADMIN LOGIN ---
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Galat Password!" });
});

// --- ADD POST (With Image Upload) ---
app.post("/api/admin/add-post", adminAuth, upload.single("image"), async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Database not connected" });
    const { name, release_date, genres, season, short_story, category } = req.body;
    if (!req.file) return res.status(400).json({ error: "Image upload karna zaroori hai" });

    // Upload to Supabase Storage Bucket 'Post-images'
    const fileName = `${uuidv4()}-${req.file.originalname}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("Post-images")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        duplex: "half"
      });

    if (uploadError) throw uploadError;

    // Get Public URL
    const { data: urlData } = supabase.storage.from("Post-images").getPublicUrl(fileName);
    const imageUrl = urlData.publicUrl;

    // Save Post in DB
    const { data: postData, error: dbError } = await supabase.from("posts").insert({
      name,
      image_url: imageUrl,
      release_date,
      genres,
      season,
      short_story,
      category
    }).select();

    if (dbError) throw dbError;

    res.json({ success: true, post: postData[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- SELECT POSTS (Search & Scroll list) ---
app.get("/api/admin/posts", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { search } = req.query;
  let query = supabase.from("posts").select("*").order("created_at", { ascending: false });
  if (search) {
    query = query.ilike("name", `%${search}%`);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- ADD EPISODE ---
app.post("/api/admin/add-episode", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { post_id, episode_label, original_link } = req.body;
  const { data, error } = await supabase.from("episodes").insert({ post_id, episode_label, original_link }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// --- DELETE FULL POST & EPISODES ---
app.post("/api/admin/delete-post", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
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

// --- GET EPISODES FOR A POST ---
app.get("/api/admin/episodes/:postId", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase.from("episodes").select("*").eq("post_id", req.params.postId).order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- DELETE SINGLE EPISODE ---
app.post("/api/admin/delete-episode", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { episode_id } = req.body;
  const { error } = await supabase.from("episodes").delete().eq("id", episode_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- SHORTENER SYSTEM (GET, ADD, DELETE) ---
app.get("/api/admin/shorteners", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase.from("shorteners").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/admin/add-shortener", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { dashboard_url, api_key } = req.body;
  const { count } = await supabase.from("shorteners").select("*", { count: "exact" });
  if (count >= 3) {
    return res.status(400).json({ error: "Sirf 3 shorteners tak allowed hain!" });
  }
  const { data, error } = await supabase.from("shorteners").insert({ dashboard_url, api_key }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.post("/api/admin/delete-shortener", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { id } = req.body;
  const { error } = await supabase.from("shorteners").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- SETTINGS (CHANNEL & GROUP LINKS) ---
app.get("/api/admin/settings", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase.from("settings").select("*").eq("id", 1).single();
  if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
  res.json(data || { channel_link: "", group_link: "" });
});

app.post("/api/admin/save-settings", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { channel_link, group_link } = req.body;
  const { error } = await supabase.from("settings").upsert({ id: 1, channel_link, group_link });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- PREMIUM USER ADD ---
app.post("/api/admin/add-premium", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { username, password } = req.body;
  const expires_at = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("premium_users").upsert(
    { username, password, expires_at },
    { onConflict: "username" }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, expires_at });
});

// ==================== MAIN SITE APIS ====================

// --- ROTATE & BYPASS SHORTENER ---
app.get("/api/shorten", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { post_name, ep_label } = req.query;
  if (!post_name || !ep_label) return res.status(400).json({ error: "Missing parameters" });

  try {
    const { data: post } = await supabase.from("posts").select("id").eq("name", post_name).single();
    if (!post) return res.status(404).json({ error: "Post nahi mili" });

    const { data: ep } = await supabase.from("episodes").select("original_link").eq("post_id", post.id).eq("episode_label", ep_label).single();
    if (!ep) return res.status(404).json({ error: "Episode nahi mila" });

    const originalLink = ep.original_link;

    const { data: shorteners } = await supabase.from("shorteners").select("*");
    if (!shorteners || shorteners.length === 0) {
      return res.json({ shortLink: originalLink });
    }

    const randomIndex = Math.floor(Math.random() * shorteners.length);
    const shortener = shorteners[randomIndex];

    const apiUrl = `https://${shortener.dashboard_url}/api/${shortener.api_key}?url=${encodeURIComponent(originalLink)}`;
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

// --- PREMIUM USER LOGIN ---
app.post("/api/premium-login", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { username, password, post_name, ep_label } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Details bharein" });

  try {
    const { data: user, error } = await supabase
      .from("premium_users")
      .select("*")
      .eq("username", username)
      .eq("password", password)
      .single();

    if (error || !user) return res.status(401).json({ error: "Galat Username ya Password!" });

    if (new Date(user.expires_at) < new Date()) {
      return res.status(401).json({ error: "Aapka premium pack expire ho chuka hai (28 Days over)!" });
    }

    const { data: post } = await supabase.from("posts").select("id").eq("name", post_name).single();
    if (!post) return res.status(404).json({ error: "Post nahi mili" });

    const { data: ep } = await supabase.from("episodes").select("original_link").eq("post_id", post.id).eq("episode_label", ep_label).single();
    if (!ep) return res.status(404).json({ error: "Episode nahi mila" });

    res.json({ success: true, original_link: ep.original_link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
