const { Bot, session } = require("grammy");
const { conversations, createConversation } = require("@grammyjs/conversations");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const express = require("express");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OWNER_ID = process.env.OWNER_ID;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
const bot = new Bot(BOT_TOKEN);

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// Owner validation
async function isAuthorized(userId) {
  if (userId.toString() === OWNER_ID) return true;
  const { data, error } = await supabase
    .from("authorized_users")
    .select("user_id")
    .eq("user_id", userId.toString())
    .single();
  return !error && data !== null;
}

bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  if (!(await isAuthorized(ctx.from.id.toString()))) {
    return ctx.reply("⛔ Access denied. Aap authorized nahi hain.");
  }
  await next();
});

bot.command("start", (ctx) => ctx.reply("👋 Welcome to AnimeSubStudio Secure Bot!"));

// Clean URL input space/protocols helper
function sanitizeShortener(dashUrl, apiKey) {
  let cleanUrl = (dashUrl || "").trim().replace(/^(https?:\/\/|https?\/\/|https?:|http?:)/i, "");
  cleanUrl = cleanUrl.replace(/^\/+|\/+$/g, "").replace(/\s+/g, "");
  let cleanKey = (apiKey || "").trim().replace(/\s+/g, "");
  return { cleanUrl, cleanKey };
}

// 512MB RAM safe conversation
async function addPostConversation(conversation, ctx) {
  await ctx.reply("📸 Poster Image send karein:");
  const imgMsg = await conversation.wait();
  if (!imgMsg.photo && !imgMsg.document) return ctx.reply("❌ Please valid photo ya image hi bhejein.");
  
  await ctx.reply("⏳ Uploading to database...");
  const fileId = imgMsg.photo ? imgMsg.photo[imgMsg.photo.length - 1].file_id : imgMsg.document.file_id;
  const file = await bot.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  
  // Scoped buffer creation and instant flush to prevent RAM leaks
  let imgBuf = await (await fetch(fileUrl)).buffer();
  const fileName = `${uuidv4()}.jpg`;
  
  const { error: upErr } = await supabase.storage
    .from("Post-images")
    .upload(fileName, imgBuf, { contentType: "image/jpeg", duplex: "half" });
  
  imgBuf = null; // RAM Garbage collection trigger
  if (global.gc) global.gc();

  if (upErr) return ctx.reply("❌ Storage upload fail: " + upErr.message);
  const imageUrl = supabase.storage.from("Post-images").getPublicUrl(fileName).data.publicUrl;

  await ctx.reply("✏️ Post Name type karein (example: Naruto):"); 
  const { message: nm } = await conversation.wait(); 
  const name = nm.text.trim();

  await ctx.reply("📅 Release Date (example: 01/01/2005):"); 
  const { message: dt } = await conversation.wait(); 
  const date = dt.text.trim();

  await ctx.reply("🎭 Genres (example: action, adventure, fantasy):"); 
  const { message: gn } = await conversation.wait(); 
  const genres = gn.text.trim();

  await ctx.reply("🔢 Season (example: 02):"); 
  const { message: sn } = await conversation.wait(); 
  const season = sn.text.trim();

  await ctx.reply("📝 Short Story:"); 
  const { message: st } = await conversation.wait(); 
  const story = st.text.trim();

  await ctx.reply("🏷️ Category (example: Anime Hindi Sub):"); 
  const { message: ct } = await conversation.wait(); 
  const category = ct.text.trim();

  const { error: dbErr } = await supabase.from("posts").insert({
    name, image_url: imageUrl, release_date: date, genres, season, short_story: story, category
  });

  if (dbErr) return ctx.reply("❌ Database write error: " + dbErr.message);
  ctx.reply(`✅ Post "${name}" successfully add ho gayi!`);
}

const ADD_USER_PASSWORD = "anime123";
async function addUserConversation(conversation, ctx) {
  if (ctx.from.id.toString() !== OWNER_ID) return ctx.reply("⛔ Sirf owner ke liye.");
  await ctx.reply("🔑 Add user password bhejo:");
  const { message: pw } = await conversation.wait();
  if (pw.text !== ADD_USER_PASSWORD) return ctx.reply("❌ Galat password.");
  await ctx.reply("👤 Telegram ID bhejo:");
  const { message: idMsg } = await conversation.wait();
  const newId = idMsg.text.trim();
  if (!newId || isNaN(newId)) return ctx.reply("❌ Invalid ID.");
  const { error } = await supabase.from("authorized_users").insert({ user_id: newId });
  if (error) return ctx.reply("❌ " + error.message);
  ctx.reply(`✅ User ${newId} add ho gaya.`);
}

async function deleteUserConversation(conversation, ctx) {
  if (ctx.from.id.toString() !== OWNER_ID) return ctx.reply("⛔ Sirf owner.");
  await ctx.reply("🔑 Password bhejo:");
  const { message: pw } = await conversation.wait();
  if (pw.text !== ADD_USER_PASSWORD) return ctx.reply("❌ Galat password.");
  await ctx.reply("👤 Jiski ID delete karni ho:");
  const { message: idMsg } = await conversation.wait();
  const delId = idMsg.text.trim();
  if (!delId) return ctx.reply("❌ Invalid ID.");
  const { error } = await supabase.from("authorized_users").delete().eq("user_id", delId);
  if (error) return ctx.reply("❌ " + error.message);
  ctx.reply(`✅ User ${delId} delete.`);
}

bot.use(createConversation(addPostConversation));
bot.use(createConversation(addUserConversation));
bot.use(createConversation(deleteUserConversation));

bot.command("addpost", async (ctx) => { await ctx.conversation.enter("addPostConversation"); });
bot.command("adduser", async (ctx) => { await ctx.conversation.enter("addUserConversation"); });
bot.command("deleteuser", async (ctx) => { await ctx.conversation.enter("deleteUserConversation"); });

// Episode actions
bot.command("addep", async (ctx) => {
  const text = ctx.match; if (!text) return ctx.reply("/addep Naruto | Ep 01 | link");
  const parts = text.split("|").map(s=>s.trim()); if (parts.length < 3) return ctx.reply("❌ Format galat.");
  const [pname, label, link] = parts;
  const { data: post } = await supabase.from("posts").select("id").eq("name", pname).single();
  if (!post) return ctx.reply("❌ Post nahi mili.");
  
  const epLabel = isNaN(label) ? label : "EPISODE " + String(label).padStart(2, '0');
  await supabase.from("episodes").insert({ post_id: post.id, episode_label: epLabel, original_link: link });
  ctx.reply(`✅ "${epLabel}" add ho gaya.`);
});

bot.command("selectpost", async (ctx) => {
  const name = ctx.match; if (!name) return ctx.reply("/selectpost Naruto");
  const { data } = await supabase.from("posts").select("*").ilike("name", `%${name}%`).limit(5);
  if (!data || !data.length) return ctx.reply("❌ Nahi mila.");
  let msg = "🔍 Results:\n"; data.forEach(p=> msg += `- ${p.name}\n`);
  ctx.reply(msg);
});

bot.command("deletepost", async (ctx) => {
  const name = ctx.match; if (!name) return ctx.reply("/deletepost Naruto");
  await supabase.from("posts").delete().eq("name", name);
  ctx.reply(`✅ Post "${name}" successfully deleted.`);
});

bot.command("deleteep", async (ctx) => {
  const text = ctx.match; if (!text) return ctx.reply("/deleteep Naruto | Ep 04");
  const parts = text.split("|").map(s=>s.trim()); if (parts.length < 2) return ctx.reply("❌ Format galat.");
  const [pname, label] = parts;
  const { data: post } = await supabase.from("posts").select("id").eq("name", pname).single();
  if (!post) return ctx.reply("❌ Post nahi mili.");
  await supabase.from("episodes").delete().eq("post_id", post.id).eq("episode_label", label);
  ctx.reply(`✅ "${label}" deleted.`);
});

// Settings operations
bot.command("addshortener", async (ctx) => {
  const text = ctx.match; if (!text) return ctx.reply("/addshortener DashboardURL | APIKey");
  const parts = text.split("|").map(s=>s.trim()); if (parts.length < 2) return ctx.reply("❌ Format galat.");
  const { cleanUrl, cleanKey } = sanitizeShortener(parts[0], parts[1]);
  await supabase.from("shorteners").insert({ dashboard_url: cleanUrl, api_key: cleanKey });
  ctx.reply("✅ Shortener account add ho gaya.");
});

bot.command("deleteshortener", async (ctx) => {
  const key = ctx.match; if (!key) return ctx.reply("/deleteshortener APIKey");
  await supabase.from("shorteners").delete().eq("api_key", key.trim());
  ctx.reply("✅ Shortener deleted.");
});

bot.command("setlinks", async (ctx) => {
  const text = ctx.match; if (!text) return ctx.reply("/setlinks ChannelLink | GroupLink");
  const parts = text.split("|").map(s=>s.trim()); if (parts.length < 2) return ctx.reply("❌ Links miss ho gayi.");
  await supabase.from("settings").upsert({ id: 1, channel_link: parts[0], group_link: parts[1] });
  ctx.reply("✅ Telegram links updated.");
});

bot.command("addpremium", async (ctx) => {
  const text = ctx.match; if (!text) return ctx.reply("/addpremium username | password");
  const parts = text.split("|").map(s=>s.trim()); if (parts.length < 2) return ctx.reply("❌ Details sahi se bhejein.");
  const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 28);
  await supabase.from("premium_users").insert({ username: parts[0], password: parts[1], expires_at: expiresAt.toISOString() });
  ctx.reply(`✅ Premium member successfully created for 28 Days.`);
});

bot.catch((err) => console.error("Bot error:", err));

// Port bindings for Render deploy
const app = express();
app.get("/", (req, res) => res.send("Bot Node Engine is healthy"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Port successfully bound to ${PORT}`);
  bot.start();
  console.log("Bot process has been active.");
});
