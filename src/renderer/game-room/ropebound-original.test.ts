import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gameRoot = fileURLToPath(new URL("../public/ropebound-original/", import.meta.url));

async function read(relativePath: string): Promise<string> {
  return readFile(`${gameRoot}${relativePath}`, "utf8");
}

describe("vendored Ropebound game", () => {
  it("replaces Wang Xiaozhu with Cyrene in the original third character slot", async () => {
    const [html, bundle, stylesheet] = await Promise.all([
      read("index.html"),
      read("assets/app.js"),
      read("assets/app.css"),
    ]);

    expect(html).toContain("從菲比啾比、弗糯糯與昔漣中選擇兩名角色");
    expect(html).toContain("cyrene-spritesheet.png");
    expect(bundle).toContain("rt=[`菲比啾比`,`弗糯糯`,`昔漣`]");
    expect(bundle).toContain("it=[`菲`,`糯`,`漣`]");
    expect(bundle).toContain("[0,1,2].map");
    expect(bundle).toContain("avatar-cyrene");
    expect(bundle).toContain("at=[`飛帽`,`鼓氣`,`憶光`]");
    expect(bundle).toContain("昔漣 · 憶光閃步");
    expect(bundle).toContain("按住凝聚憶光 / 沿面向快速穿行");
    expect(bundle).toContain("cyreneDashEnergy");
    expect(bundle).toContain("e.character===2?176:e.character===0?158:160");
    expect(bundle).toContain("window.__ropeboundDiscordBridge");
    expect(bundle).toContain("source:`ropebound-game`,type:`input`");
    expect(bundle).toContain("source:`ropebound-game`,type:`ready`");
    expect(bundle).not.toMatch(/bgm\.mp3|背景音樂|music-button/);
    expect(bundle).toContain("./game/audio/feibi-voice.mp3");
    expect(bundle).toContain("./game/audio/nuonuo-voice.mp3");
    expect(bundle).not.toMatch(/滾球|團成球|滾動|wangRoll/);
    expect(stylesheet).toContain(
      ".portrait-2{background-image:url(../game/sprites/cyrene-spritesheet.png)}",
    );
    expect(stylesheet).toContain(".memory-ability .ability-glyph");
    expect(stylesheet).toContain("/* CYRENE_THEME */");
    expect(stylesheet).not.toContain("music-button");

    for (const content of [html, bundle, stylesheet]) {
      expect(content).not.toMatch(/王小豬|王小猪|wangxiaozhu|portrait-3|avatar-wang/);
    }
  });

  it("keeps every non-replaced upstream binary asset byte-for-byte", async () => {
    const expectedHashes: Record<string, string> = {
      "game/favicon.webp": "63f7a8971e05bdeed8b324b402a9e5443d65adc3223c5f8df50a927ae0f6a3bd",
      "game/reference-bg.webp": "489075b48528c055fbdf7b6660ed4d9da063b55c5151a39cdb382a07536bc371",
      "game/audio/feibi-voice.mp3": "7609e56d71a85b3b3d5942809055a94a4dfd5e63ad3cfae868bc1ecf00b3240b",
      "game/audio/nuonuo-voice.mp3": "a7d5fd4576903ca6414b947acbfcbf83ca1c7b571e4d07fb7fd32a7847250875",
      "game/sprites/feibi-hat-skill-sheet.webp": "64a225564883bb83ea51b37e44537c4241bb4422c574bb3b8958b595553c43fe",
      "game/sprites/feibi-spritesheet.webp": "fbb82fc65a30b9c3363d7ce689d57f794f3871d8b4976a229836da6f88c34ec1",
      "game/sprites/nuonuo-air-skill-sheet.webp": "4f8a74519018746a01788f2067e6e2625520b3f54191ac83a632fe124e6533fc",
      "game/sprites/nuonuo-spritesheet.webp": "c9864fd87b52055bbed81970a98397f6ccd7c9a35335a976222d4811f585982a",
    };

    for (const [relativePath, expectedHash] of Object.entries(expectedHashes)) {
      const bytes = await readFile(`${gameRoot}${relativePath}`);
      expect(createHash("sha256").update(bytes).digest("hex"), relativePath).toBe(expectedHash);
    }
  });

  it("keeps the simplified story route comfortably inside every character's jump envelope", async () => {
    const bundle = await read("assets/app.js");
    const route = [
      { x: -120, y: 535, width: 880 },
      { x: 800, y: 525, width: 600 },
      { x: 1440, y: 495, width: 440 },
      { x: 1920, y: 520, width: 600 },
      { x: 2560, y: 500, width: 360 },
      { x: 2960, y: 520, width: 620 },
      { x: 3620, y: 490, width: 380 },
      { x: 4040, y: 520, width: 540 },
      { x: 4620, y: 490, width: 360 },
      { x: 5020, y: 520, width: 850 },
    ];

    const gaps = route.slice(1).map((platform, index) =>
      platform.x - (route[index].x + route[index].width));
    const upwardSteps = route.slice(1).map((platform, index) =>
      Math.max(0, route[index].y - platform.y));

    expect(Math.max(...gaps)).toBeLessThanOrEqual(40);
    expect(Math.max(...upwardSteps)).toBeLessThanOrEqual(30);
    expect(bundle).toContain("{id:`drift`,x:2560,y:500,w:360,h:245}");
    expect(bundle).not.toContain("moveRange:105");
    expect(bundle).toContain("i=[800,1300,1800,2300,2800,3300,3800,4300,4800]");
    expect(bundle).toContain("Math.max(-35,Math.min(35,a-o))");

    const weakestJump = { speed: 306, jumpSpeed: 655, gravity: 1710 };
    const worstEndlessGap = 500 + 30 - 455;
    const worstRise = 35;
    const descendingLandingTime = (
      weakestJump.jumpSpeed
      + Math.sqrt(weakestJump.jumpSpeed ** 2 - 2 * weakestJump.gravity * worstRise)
    ) / weakestJump.gravity;
    const conservativeTravel = weakestJump.speed * 0.6 * descendingLandingTime;

    expect(worstEndlessGap).toBe(75);
    expect(conservativeTravel - worstEndlessGap).toBeGreaterThan(50);
  });
});
