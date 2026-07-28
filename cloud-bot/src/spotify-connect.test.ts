import assert from "node:assert/strict";
import test from "node:test";
import { playOnSpotify } from "./spotify-connect.js";

test("雲端播放會控制官方 Spotify 裝置而非 Discord 音訊", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    if (String(input).includes("accounts.spotify.com")) {
      return new Response(JSON.stringify({ access_token: "access" }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  await playOnSpotify({
    spotifyClientId: "client",
    spotifyClientSecret: "secret",
    spotifyRefreshToken: "refresh",
  }, "https://open.spotify.com/playlist/list123?si=x");

  assert.equal(calls[1].url, "https://api.spotify.com/v1/me/player/play");
  assert.deepEqual(JSON.parse(calls[1].body ?? "{}"), { context_uri: "spotify:playlist:list123" });
});
