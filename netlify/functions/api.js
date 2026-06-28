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

// Advanced Domain extractor: Converts 'https://app.bitly.com/Bq6sfFja0Zz/home' to 'app.bitly.com'
function sanitizeShortener(dashUrl, apiKey) {
  let cleanUrl = (dashUrl || "").trim();
  let cleanKey = (apiKey || "").trim();
  
  try {
    if (!/^https?:\/\//i.test(cleanUrl)) {
      cleanUrl = "https://" + cleanUrl;
    }
    const parsed = new URL(cleanUrl);
    cleanUrl = parsed.hostname;
  } catch (e) {
    cleanUrl = cleanUrl.replace(/^(https?:\/\/|https?\/|https?:|http?:)/i, "");
    cleanUrl = cleanUrl.split('/')[0];
  }
  
  cleanUrl = cleanUrl.replace(/\s+/g, "");
  cleanKey = cleanKey.replace(/\s+/g, "");
  return { cleanUrl, cleanKey };
}

async function cleanExpiredPremiumUsers() {
  if (!supabase) return;
  try {
    const now = new Date().toISOString();
    await supabase.from("premium_users").delete().lt("expires_at", now);
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}

// Highly robust fetch function with native Bitly and AdlinkFly support
async function fetchShortlink(cleanUrl, cleanKey, originalLink) {
  
  // 1. NATIVE BITLY (v4) SUPPORT
  if (cleanUrl.includes("bitly")) {
    try {
      const response = await fetch("https://api-ssl.bitly.com/v4/shorten", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cleanKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ long_url: originalLink })
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.link) {
          return data.link; // Returns 'https://bit.ly/xxxx'
        }
      } else {
        const errText = await response.text();
        console.error("Bitly API responded with error:", response.status, errText);
      }
    } catch (err) {
      console.error("Bitly shortening exception:", err.message);
    }
    return null;
  }

  // 2. STANDARD ADLINKFLY SUPPORT (GPLinks, ShrinkMe, etc.)
  const tryUrls = [];
  if (!cleanUrl.startsWith("api.")) {
    tryUrls.push(`https://api.${cleanUrl}/api?api=${cleanKey}&url=${encodeURIComponent(originalLink)}`);
  }
  tryUrls.push(`https://${cleanUrl}/api?api=${cleanKey}&url=${encodeURIComponent(originalLink)}`);

  for (const url of tryUrls) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*"
        },
        timeout: 6000
      });
      
      if (response.ok) {
        const text = await response.text();
        let shortLink = "";
        try {
          const json = JSON.parse(text);
          shortLink = json.shortenedUrl || json.short_url || json.url || "";
        } catch (e) {
          if (text.startsWith("http://") || text.startsWith("https://")) {
            shortLink = text.trim();
          }
        }
        if (shortLink && shortLink.startsWith("http")) {
          return shortLink;
        }
      }
    } catch (err) {
      console.error(`Shortener fetch failed for URL: ${url}`, err.message);
    }
  }
  return null;
}

const router = express.Router();

// ==================== PUBLIC FRONTEND ENDPOINTS ====================

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

router.get("/episodes/:postId", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase
    .from("episodes")
    .select("id, post_id, episode_label")
    .eq("post_id", req.params.postId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

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

router.post("/admin/add-post", adminAuth, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: "Database not connected" });
    const { name, image_url, release_date, genres, season, short_story, category } = req.body;
    if (!image_url) return res.status(400).json({ error: "Image URL required!" });

    const { data: postData, error: dbError } = await supabase.from("posts").insert({
      name, image_url, release_date, genres, season, short_story, category
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
  let { post_id, episode_label, original_link, play_link } = req.body;
  
  original_link = (original_link || "").trim();
  play_link = (play_link || "").trim();

  const { data, error } = await supabase.from("episodes").insert({ 
    post_id, episode_label, original_link, play_link 
  }).select();
  
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
    return res.status(400).json({ error: "Maximum 3 shorteners are allowed!" });
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

router.get("/admin/settings", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase.from("settings").select("*").eq("id", 1).single();
  if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
  res.json(data || { channel_link: "", group_link: "", player_password: "" });
});

router.post("/admin/save-settings", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { channel_link, group_link, player_password } = req.body;
  const { error } = await supabase.from("settings").upsert({ id: 1, channel_link, group_link, player_password });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get("/admin/premium-users", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  await cleanExpiredPremiumUsers();
  const { data, error } = await supabase.from("premium_users").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/admin/add-premium", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { username, password } = req.body;
  const expires_at = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("premium_users").upsert({ 
    username, password, expires_at, session_token: "" 
  }, { onConflict: "username" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, expires_at });
});

router.post("/admin/delete-premium", adminAuth, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { id } = req.body;
  const { error } = await supabase.from("premium_users").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ==================== SHORTEN ENGINE ====================

router.get("/shorten", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { post_name, ep_label } = req.query;
  if (!post_name || !ep_label) return res.status(400).json({ error: "Missing parameters" });

  try {
    const { data: post } = await supabase.from("posts").select("id").eq("name", post_name).single();
    if (!post) return res.status(404).json({ error: "Post not found" });

    const { data: ep } = await supabase.from("episodes").select("original_link").eq("post_id", post.id).eq("episode_label", ep_label).single();
    
    if (!ep || !ep.original_link) {
      return res.json({ error: "Is episode ke liye Download Link uplabdh nahi hai!" });
    }

    const originalLink = ep.original_link;

    const { data: shorteners } = await supabase.from("shorteners").select("*");
    if (!shorteners || shorteners.length === 0) {
      // If no shortener is added in DB, allow direct download
      return res.json({ shortLink: originalLink });
    }

    const randomIndex = Math.floor(Math.random() * shorteners.length);
    const rawShortener = shorteners[randomIndex];
    const { cleanUrl, cleanKey } = sanitizeShortener(rawShortener.dashboard_url, rawShortener.api_key);
    
    const shortLink = await fetchShortlink(cleanUrl, cleanKey, originalLink);
    
    if (shortLink && shortLink.startsWith("http")) {
      res.json({ shortLink });
    } else {
      // ANTI-BYPASS SECURITY: Never send original direct link on shortener API failure
      res.json({ error: "Shortener API currently busy ya down hai! Kripya thodi der baad firse prayas karein." });
    }
  } catch (err) {
    res.json({ error: "Shortener process execution error: " + err.message });
  }
});

// ==================== VIDEO PLAYER VALIDATION & PAGE ====================

router.post("/verify-player", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { password, post_name, ep_label } = req.body;

  try {
    const { data: settings } = await supabase.from("settings").select("player_password").eq("id", 1).single();
    const systemPass = settings?.player_password || "";

    if (systemPass && password !== systemPass) {
      return res.status(401).json({ error: "Streaming password galat hai!" });
    }

    const { data: post } = await supabase.from("posts").select("id").eq("name", post_name).single();
    if (!post) return res.status(404).json({ error: "Post not found" });

    const { data: ep } = await supabase.from("episodes").select("play_link").eq("post_id", post.id).eq("episode_label", ep_label).single();
    
    if (!ep || !ep.play_link) {
      return res.status(404).json({ error: "Is episode ke liye Stream Video Link uplabdh nahi hai!" });
    }

    const streamToken = Buffer.from(ep.play_link).toString("base64");
    res.json({ success: true, token: streamToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/play-stream", (req, res) => {
  const { t, title } = req.query;
  if (!t) return res.status(400).send("Access Token Missing.");
  
  const originalUrl = Buffer.from(t, "base64").toString("ascii");
  const videoTitle = title ? decodeURIComponent(title) : "Anime Streaming";

  const isEmbed = originalUrl.includes("embed") || originalUrl.includes("/e/") || originalUrl.includes("dood") || originalUrl.includes("streamwish") || originalUrl.includes("filemoon") || originalUrl.includes("streamtape") || originalUrl.includes("mixdrop") || originalUrl.includes("filelions") || originalUrl.includes("streamhide");

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${videoTitle}</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <style>
        body { margin: 0; padding: 0; background-color: #060608; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; min-height: 100vh; justify-content: space-between; align-items: center; }
        .container { width: 100%; max-width: 960px; padding: 20px; box-sizing: border-box; }
        .back-bar { display: flex; align-items: center; width: 100%; margin-bottom: 15px; }
        .back-btn { background: none; border: none; color: #e50914; font-size: 16px; cursor: pointer; text-decoration: none; font-weight: bold; display: flex; align-items: center; gap: 8px; }
        .back-btn:hover { color: #fff; }
        .title { font-size: 1.3rem; font-weight: bold; margin-left: 20px; text-shadow: 0 0 10px rgba(229, 9, 20, 0.4); }
        .player-wrapper { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; overflow: hidden; border: 1px solid rgba(229, 9, 20, 0.3); box-shadow: 0 10px 30px rgba(229, 9, 20, 0.2); }
        iframe, video { width: 100%; height: 100%; border: none; object-fit: contain; }
        .ad-container { width: 100%; text-align: center; margin: 15px 0; padding: 12px; background: rgba(255, 255, 255, 0.02); border: 1px dashed rgba(255, 255, 255, 0.1); border-radius: 8px; font-size: 11px; color: #666; box-sizing: border-box; }
        .banner-top, .banner-bottom { max-width: 728px; }
        @media (max-width: 600px) {
          .title { font-size: 1.1rem; margin-left: 10px; }
          .container { padding: 10px; }
        }
      </style>
    </head>
    <body>
      <div class="container ad-container banner-top">
        <span>[SPONSORED AD SPOT - PASTE BANNERS OR DIRECT LINK ADS HERE]</span>
      </div>

      <div class="container">
        <div class="back-bar">
          <button class="back-btn" onclick="window.close()"><i class="fa-solid fa-arrow-left"></i> Close Player</button>
          <span class="title">${videoTitle}</span>
        </div>
        
        <div class="player-wrapper">
          ${isEmbed ? `
            <iframe src="${originalUrl}" allowfullscreen="true" scrolling="no" allow="autoplay; encrypted-media"></iframe>
          ` : `
            <video controls autoplay>
              <source src="${originalUrl}" type="video/mp4">
              Your browser does not support HTML5 playback.
            </video>
          `}
        </div>
      </div>

      <div class="container ad-container banner-bottom" style="margin-bottom: 25px;">
        <span>[BOTTOM AD BANNER - INCREASE STREAMING REVENUE]</span>
      </div>
    </body>
    </html>
  `);
});

// ==================== PREMIUM SYSTEM ====================

router.post("/premium-login", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Details missing" });

  try {
    const { data: user, error } = await supabase
      .from("premium_users")
      .select("*")
      .eq("username", username)
      .eq("password", password)
      .single();

    if (error || !user) return res.status(401).json({ error: "Galat Gmail ya Password!" });

    if (new Date(user.expires_at) < new Date()) {
      return res.status(401).json({ error: "Aapka premium standard timeline limit se expire ho chuka hai!" });
    }

    const newSessionToken = uuidv4();
    await supabase
      .from("premium_users")
      .update({ session_token: newSessionToken })
      .eq("id", user.id);

    res.json({ 
      success: true, 
      username: user.username, 
      session_token: newSessionToken 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/premium-bypass", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { username, session_token, post_name, ep_label } = req.body;
  if (!username || !session_token) return res.status(401).json({ error: "Aap logged in nahi hain!" });

  try {
    const { data: user, error } = await supabase
      .from("premium_users")
      .select("*")
      .eq("username", username)
      .single();

    if (error || !user) return res.status(401).json({ error: "Aap premium user nahi hain!" });

    if (new Date(user.expires_at) < new Date()) {
      return res.status(401).json({ error: "Premium standard trial limit expire ho chuki hai!" });
    }

    if (user.session_token !== session_token) {
      return res.status(403).json({ error: "Device Limit Reached! Is Gmail ID ko doosra device chala raha hai." });
    }

    const { data: post } = await supabase.from("posts").select("id").eq("name", post_name).single();
    if (!post) return res.status(404).json({ error: "Post not found" });

    const { data: ep } = await supabase.from("episodes").select("original_link").eq("post_id", post.id).eq("episode_label", ep_label).single();
    
    if (!ep || !ep.original_link) {
      return res.status(404).json({ error: "Is episode ke liye Download Link uplabdh nahi hai!" });
    }

    res.json({ success: true, original_link: ep.original_link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/api", router);
app.use("/.netlify/functions/api", router);
app.use("/", router);

const handler = serverless(app);
module.exports = { handler };
