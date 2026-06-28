const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const serverless = require("serverless-http");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let supabase;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
}

const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized. Galat password!" });
};

// Clean Dashboard URL & API Key (Auto-Sanitizer)
function sanitizeShortener(dashUrl, apiKey) {
  let cleanUrl = (dashUrl || "").trim();
  let cleanKey = (apiKey || "").trim();
  cleanUrl = cleanUrl.replace(/^(https?:\/\/|https?\/\/|https?:|http?:)/i, "");
  cleanUrl = cleanUrl.replace(/^\/+|\/+$/g, "");
  cleanUrl = cleanUrl.replace(/\s+/g, "");
  cleanKey = cleanKey.replace(/\s+/g, "");
  return { cleanUrl, cleanKey };
}

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({ status: "running", database_connected: !!supabase });
});

// ==================== PUBLIC FRONTEND ENDPOINTS (RLS BYPASS & BYPASS SHIELD) ====================

// 1. PUBLIC: Get all posts safely (Bypasses Supabase RLS using Secret Key)
router.get("/posts", async (req, res) => {
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

// 2. PUBLIC: Get safe episodes (excluding original_link to stop bypasses)
router.get("/episodes/:postId", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase
    .from("episodes")
    .select("id, post_id, episode_label") // Excluded original_link
    .eq("post_id", req.params.postId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 3. PUBLIC: Get Settings (Channel & Group links)
router.get("/settings", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase.from("settings").select("channel_link, group_link").eq("id", 1).single();
  if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
  res.json(data || { channel_link: "", group_link: "" });
});

// ==================== SECURE ADMIN OPERATIONS ====================

router.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Galat Password!" });
});

router.post("/admin/add-post", adminAuth, upload.single("image"), async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Database not connected" });
    const { name, release_date, genres, season, short_story, category } = req.body;
    if (!req.file) return res.status(400).json({ error: "Image upload karna zaroori hai" });

    const fileName = `${uuidv4()}-${req.file.originalname}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("Post-images")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        duplex: "half"
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from("Post-images").getPublicUrl(fileName);
    const imageUrl = urlData.publicUrl;

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

router.get("/admin/posts", adminAuth, async (req, res) => {
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

router.post("/admin/add-episode", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { post_id, episode_label, original_link } = req.body;
  const { data, error } = await supabase.from("episodes").insert({ post_id, episode_label, original_link }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

router.post("/admin/delete-post", adminAuth, async (req, res) => {
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

router.get("/admin/episodes/:postId", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase.from("episodes").select("*").eq("post_id", req.params.postId).order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/admin/delete-episode", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { episode_id } = req.body;
  const { error } = await supabase.from("episodes").delete().eq("id", episode_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get("/admin/shorteners", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase.from("shorteners").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/admin/add-shortener", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { dashboard_url, api_key } = req.body;
  const { count } = await supabase.from("shorteners").select("*", { count: "exact" });
  if (count >= 3) {
    return res.status(400).json({ error: "Sirf 3 shorteners tak allowed hain!" });
  }
  const { cleanUrl, cleanKey } = sanitizeShortener(dashboard_url, api_key);
  const { data, error } = await supabase.from("shorteners").insert({ dashboard_url: cleanUrl, api_key: cleanKey }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

router.post("/admin/delete-shortener", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { id } = req.body;
  const { error } = await supabase.from("shorteners").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post("/admin/save-settings", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { channel_link, group_link } = req.body;
  const { error } = await supabase.from("settings").upsert({ id: 1, channel_link, group_link });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post("/admin/add-premium", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { username, password } = req.body;
  const expires_at = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("premium_users").upsert({ username, password, expires_at }, { onConflict: "username" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, expires_at });
});

// ==================== SHORTLINK SECURE ENGINE ====================

router.get("/shorten", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { post_name, ep_label } = req.query;
  if (!post_name || !ep_label) return res.status(400).json({ error: "Missing parameters" });

  try {
    const { data: post } = await supabase.from("posts").select("id").eq("name", post_name).single();
    if (!post) return res.status(404).json({ error: "Post not found" });

    const { data: ep } = await supabase.from("episodes").select("original_link").eq("post_id", post.id).eq("episode_label", ep_label).single();
    if (!ep) return res.status(404).json({ error: "Episode not found" });

    const originalLink = ep.original_link;

    const { data: shorteners } = await supabase.from("shorteners").select("*");
    if (!shorteners || shorteners.length === 0) {
      return res.json({ shortLink: originalLink });
    }

    const randomIndex = Math.floor(Math.random() * shorteners.length);
    const rawShortener = shorteners[randomIndex];

    const { cleanUrl, cleanKey } = sanitizeShortener(rawShortener.dashboard_url, rawShortener.api_key);
    const apiUrl = `https://${cleanUrl}/api/${cleanKey}?url=${encodeURIComponent(originalLink)}`;

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

router.post("/premium-login", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { username, password, post_name, ep_label } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Details missing" });

  try {
    const { data: user, error } = await supabase
      .from("premium_users")
      .select("*")
      .eq("username", username)
      .eq("password", password)
      .single();

    if (error || !user) return res.status(401).json({ error: "Galat Username ya Password!" });

    if (new Date(user.expires_at) < new Date()) {
      return res.status(401).json({ error: "Aapka premium expire ho chuka hai!" });
    }

    const { data: post } = await supabase.from("posts").select("id").eq("name", post_name).single();
    if (!post) return res.status(404).json({ error: "Post not found" });

    const { data: ep = null } = await supabase.from("episodes").select("original_link").eq("post_id", post.id).eq("episode_label", ep_label).single();
    if (!ep) return res.status(404).json({ error: "Episode not found" });

    res.json({ success: true, original_link: ep.original_link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/api", router);
app.use("/.netlify/functions/api", router);
app.use("/", router);

// SERVERLESS HANDLER EXPORT (100% CORRECT)
const handler = serverless(app);
module.exports = { handler };
