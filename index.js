// ==================== CONFIGURATION ====================
const { Bot, session, GrammyError, HttpError } = require("grammy");
const { conversations, createConversation } = require("@grammyjs/conversations");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OWNER_ID = process.env.OWNER_ID;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
const bot = new Bot(BOT_TOKEN);

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// ==================== AUTHORIZATION ====================
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
    return ctx.reply("⛔ Access denied. Aap authorised nahi hain.");
  }
  await next();
});

// ==================== START ====================
bot.command("start", async (ctx) => {
  ctx.reply("👋 Welcome to AnimeSubStudio Bot!\nAuthorised ho. Commands use karo.");
});

// ==================== ADD USER CONVERSATION ====================
const ADD_USER_PASSWORD = "anime123";

async function addUserConversation(conversation, ctx) {
  if (ctx.from.id.toString() !== OWNER_ID) {
    return ctx.reply("⛔ Sirf owner yeh command use kar sakta hai.");
  }
  await ctx.reply("🔑 Add user password bhejo:");
  const { message: pwMsg } = await conversation.wait();
  if (pwMsg.text !== ADD_USER_PASSWORD) {
    return ctx.reply("❌ Galat password. Access denied.");
  }
  await ctx.reply("👤 User ki Telegram ID bhejo:");
  const { message: idMsg } = await conversation.wait();
  const newId = idMsg.text.trim();
  if (!newId || isNaN(newId)) {
    return ctx.reply("❌ Invalid ID. Sirf numeric ID bhejo.");
  }
  const { error } = await supabase.from("authorized_users").insert({ user_id: newId });
  if (error) return ctx.reply("❌ Error: " + error.message);
  ctx.reply(`✅ User ${newId} add ho gaya.`);
}

// ==================== DELETE USER CONVERSATION ====================
async function deleteUserConversation(conversation, ctx) {
  if (ctx.from.id.toString() !== OWNER_ID) {
    return ctx.reply("⛔ Sirf owner yeh command use kar sakta hai.");
  }
  await ctx.reply("🔑 Password bhejo:");
  const { message: pwMsg } = await conversation.wait();
  if (pwMsg.text !== ADD_USER_PASSWORD) {
    return ctx.reply("❌ Galat password.");
  }
  await ctx.reply("👤 Jis user ko hatana hai uski Telegram ID bhejo:");
  const { message: idMsg } = await conversation.wait();
  const delId = idMsg.text.trim();
  if (!delId) return ctx.reply("❌ Invalid ID.");
  const { error } = await supabase.from("authorized_users").delete().eq("user_id", delId);
  if (error) return ctx.reply("❌ Error: " + error.message);
  ctx.reply(`✅ User ${delId} delete ho gaya.`);
}

// ==================== ADD POST CONVERSATION (Step-by-step) ====================
async function addPostConversation(conversation, ctx) {
  await ctx.reply("📸 Post ki image bhejo:");
  const imageMsg = await conversation.wait();
  if (!imageMsg.photo && !imageMsg.document) {
    return ctx.reply("❌ Image zaroori hai. /addpost dobara try karo.");
  }
  const fileId = imageMsg.photo
    ? imageMsg.photo[imageMsg.photo.length - 1].file_id
    : imageMsg.document.file_id;

  const file = await bot.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const imgResponse = await fetch(fileUrl);
  const imgBuffer = await imgResponse.buffer();
  const fileName = `${uuidv4()}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from("Post-images")
    .upload(fileName, imgBuffer, { contentType: "image/jpeg", cacheControl: "3600", upsert: false });
  if (uploadError) return ctx.reply("❌ Image upload fail: " + uploadError.message);
  const { data: urlData } = supabase.storage.from("Post-images").getPublicUrl(fileName);
  const imageUrl = urlData.publicUrl;

  await ctx.reply("✏️ Post ka naam bhejo:");
  const nameMsg = await conversation.wait();
  const name = nameMsg.text.trim();

  await ctx.reply("📅 Release date bhejo (e.g., 01/01/2005):");
  const dateMsg = await conversation.wait();
  const releaseDate = dateMsg.text.trim();

  await ctx.reply("🎭 Genre bhejo (comma separated, e.g., Action, Adventure, Fantasy):");
  const genreMsg = await conversation.wait();
  const genres = genreMsg.text.trim();

  await ctx.reply("🔢 Season bhejo (e.g., 2):");
  const seasonMsg = await conversation.wait();
  const season = seasonMsg.text.trim();

  await ctx.reply("📝 Short story bhejo:");
  const storyMsg = await conversation.wait();
  const story = storyMsg.text.trim();

  await ctx.reply("🏷️ Category bhejo (e.g., Hindi Sub Anime):");
  const catMsg = await conversation.wait();
  const category = catMsg.text.trim();

  const { error: dbErr } = await supabase.from("posts").insert({
    name,
    image_url: imageUrl,
    release_date: releaseDate,
    genres,
    season,
    short_story: story,
    category
  });
  if (dbErr) return ctx.reply("❌ Database error: " + dbErr.message);
  ctx.reply(`✅ Post "${name}" successfully add ho gayi!\nImage: ${imageUrl}`);
}

// Register all conversations
bot.use(createConversation(addUserConversation));
bot.use(createConversation(deleteUserConversation));
bot.use(createConversation(addPostConversation));

// Conversation entry commands
bot.command("adduser", async (ctx) => { await ctx.conversation.enter("addUserConversation"); });
bot.command("deleteuser", async (ctx) => { await ctx.conversation.enter("deleteUserConversation"); });
bot.command("addpost", async (ctx) => { await ctx.conversation.enter("addPostConversation"); });

// ==================== ADD EPISODE (Inline) ====================
bot.command("addep", async (ctx) => {
  const text = ctx.match;
  if (!text) return ctx.reply("Format: /addep Naruto | Episode 01 | https://link.com");
  const parts = text.split("|").map(s => s.trim());
  if (parts.length < 3) return ctx.reply("❌ Format galat. Post Name, Label, Link dijiye.");
  const [postName, label, link] = parts;
  const { data: post } = await supabase.from("posts").select("id").eq("name", postName).single();
  if (!post) return ctx.reply("❌ Post nahi mili.");
  const { error } = await supabase.from("episodes").insert({
    post_id: post.id,
    episode_label: label,
    original_link: link
  });
  if (error) return ctx.reply("❌ Error: " + error.message);
  ctx.reply(`✅ "${label}" add ho gaya post "${postName}" mein.`);
});

// ==================== SELECT POST ====================
bot.command("selectpost", async (ctx) => {
  const name = ctx.match;
  if (!name) return ctx.reply("Format: /selectpost Naruto");
  const { data, error } = await supabase.from("posts").select("*").ilike("name", `%${name}%`).limit(5);
  if (error) return ctx.reply("❌ Error: " + error.message);
  if (!data.length) return ctx.reply("❌ Koi post nahi mili.");
  let msg = "🔍 Results:\n";
  data.forEach(p => msg += `- ${p.name}\n`);
  ctx.reply(msg);
});

// ==================== DELETE POST (Full) ====================
bot.command("deletepost", async (ctx) => {
  const name = ctx.match;
  if (!name) return ctx.reply("Format: /deletepost Naruto");
  const { error } = await supabase.from("posts").delete().eq("name", name);
  if (error) return ctx.reply("❌ Delete fail: " + error.message);
  ctx.reply(`✅ Post "${name}" aur episodes delete ho gaye.`);
});

// ==================== DELETE EPISODE ====================
bot.command("deleteep", async (ctx) => {
  const text = ctx.match;
  if (!text) return ctx.reply("Format: /deleteep Naruto | Episode 04");
  const parts = text.split("|").map(s => s.trim());
  if (parts.length < 2) return ctx.reply("❌ Format galat.");
  const [postName, label] = parts;
  const { data: post } = await supabase.from("posts").select("id").eq("name", postName).single();
  if (!post) return ctx.reply("❌ Post nahi mili.");
  const { error } = await supabase.from("episodes").delete().eq("post_id", post.id).eq("episode_label", label);
  if (error) return ctx.reply("❌ Delete fail: " + error.message);
  ctx.reply(`✅ "${label}" delete ho gaya post "${postName}" se.`);
});

// ==================== ADD SHORTENER ====================
bot.command("addshortener", async (ctx) => {
  const text = ctx.match;
  if (!text) return ctx.reply("Format: /addshortener Dashboard URL | API Key");
  const parts = text.split("|").map(s => s.trim());
  if (parts.length < 2) return ctx.reply("❌ Format galat.");
  const [url, key] = parts;
  const { count, error } = await supabase.from("shorteners").select("*", { count: "exact", head: true });
  if (!error && count >= 3) return ctx.reply("❌ Already 3 shorteners hain.");
  const { error: insertErr } = await supabase.from("shorteners").insert({
    dashboard_url: url,
    api_key: key
  });
  if (insertErr) return ctx.reply("❌ Error: " + insertErr.message);
  ctx.reply("✅ Shortener add ho gaya.");
});

// ==================== DELETE SHORTENER ====================
bot.command("deleteshortener", async (ctx) => {
  const key = ctx.match;
  if (!key) return ctx.reply("Format: /deleteshortener API Key");
  const { error } = await supabase.from("shorteners").delete().eq("api_key", key);
  if (error) return ctx.reply("❌ Error: " + error.message);
  ctx.reply("✅ Shortener delete ho gaya.");
});

// ==================== SET LINKS ====================
bot.command("setlinks", async (ctx) => {
  const text = ctx.match;
  if (!text) return ctx.reply("Format: /setlinks Channel Link | Group Link");
  const parts = text.split("|").map(s => s.trim());
  if (parts.length < 2) return ctx.reply("❌ Dono links dijiye.");
  const [channel, group] = parts;
  const { error } = await supabase.from("settings").upsert({ id: 1, channel_link: channel, group_link: group });
  if (error) return ctx.reply("❌ Error: " + error.message);
  ctx.reply("✅ Channel aur Group link save ho gaye.");
});

// ==================== ADD PREMIUM ====================
bot.command("addpremium", async (ctx) => {
  const text = ctx.match;
  if (!text) return ctx.reply("Format: /addpremium Username | Password");
  const parts = text.split("|").map(s => s.trim());
  if (parts.length < 2) return ctx.reply("❌ Format galat.");
  const [username, password] = parts;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 28);
  const { error } = await supabase.from("premium_users").insert({
    username,
    password,
    expires_at: expiresAt.toISOString()
  });
  if (error) return ctx.reply("❌ Error: " + error.message);
  ctx.reply(`✅ Premium account ban gaya.\nUsername: ${username}\nPassword: ${password}\nExpiry: ${expiresAt.toDateString()}`);
});

// ==================== ERROR HANDLER ====================
bot.catch((err) => {
  console.error("Bot error:", err);
});

// ==================== START BOT ====================
bot.start();
console.log("Bot started...");
