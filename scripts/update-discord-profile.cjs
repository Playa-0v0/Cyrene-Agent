const path = require("node:path");
const fs = require("node:fs/promises");
const { app } = require("electron");
const { Client, GatewayIntentBits } = require("discord.js");

const projectRoot = path.resolve(__dirname, "..");
const avatarPath = path.join(projectRoot, "src/renderer/public/discord/cyrene-discord-original-avatar.webp");
const bannerPath = path.join(projectRoot, "src/renderer/public/discord/cyrene-discord-original-banner.png");

async function main() {
  app.setName("live2d-cyrene");
  app.setPath("userData", path.join(app.getPath("appData"), "live2d-cyrene"));
  await app.whenReady();

  const { loadChannelsSettings } = require("../dist/main/main/channels/settings-store.js");
  const token = loadChannelsSettings().discord.botToken;
  if (!token) throw new Error("Discord Bot Token 尚未設定");

  const [avatar, banner] = await Promise.all([fs.readFile(avatarPath), fs.readFile(bannerPath)]);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(token);
    await client.user.setUsername("昔漣寶寶");
    await client.user.setAvatar(avatar);
    await client.user.setBanner(banner);
    console.log(`Discord 身分已更新：${client.user.username}#${client.user.discriminator}`);
  } finally {
    client.destroy();
    app.quit();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});
