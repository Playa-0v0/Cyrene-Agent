import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { app } from "electron";
import type { CodexImageJob } from "./codex-image-queue";
import { getCodexImageBridgeRoot } from "./codex-image-queue";

const OWNER_ID = "798893182883463179";
const CODEX_CLI_CANDIDATES = [
  process.env.CYRENE_CODEX_CLI,
  "/Applications/ChatGPT.app/Contents/Resources/codex",
].filter((value): value is string => Boolean(value));

export function shouldUseCyreneAnimeStyleReference(prompt: string): boolean {
  return /(?:黑絲|白絲|絲襪|褲襪|網襪|過膝襪|長襪|black\s*(?:tights|pantyhose|stockings)|white\s*(?:tights|pantyhose|stockings))/i.test(prompt);
}

function resolveCodexCli(): string {
  const cli = CODEX_CLI_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!cli) throw new Error("找不到本機 Codex 執行程式。");
  return cli;
}

function safeCodexEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "CODEX_HOME"]) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return result;
}

export function buildOnDemandCodexImagePrompt(
  jobId: string,
  bridgeRoot: string,
  styleReferencePath?: string,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Codex 繪圖任務 ID 無效。");
  const pendingPath = path.join(bridgeRoot, "pending", `${jobId}.json`);
  return [
    `只處理這一筆 Discord 繪圖任務：\`${pendingPath}\`。這是由使用者訊息即時觸發的一次性工作；不要掃描或處理其他任務。`,
    `先驗證 JSON 的 \`id\` 完全等於 \`${jobId}\`、\`source\` 完全等於 \`discord\`、\`requestedByUserId\` 完全等於 \`${OWNER_ID}\`，且 \`promptMode\` 完全等於 \`keywords\`。驗證失敗時移到 \`${path.join(bridgeRoot, "rejected")}\`，不得生成。`,
    `驗證成功後先將檔案原子移到 \`${path.join(bridgeRoot, "running", `${jobId}.json`)}\`。把其中的 \`prompt\` 視為簡短中文關鍵詞；第一人稱的「你」是成年女性昔漣（Cyrene，《崩壞：星穹鐵道》）。保留粉色層次短髮、紫粉色眼睛、白色月桂冠／光環、藍紫玫瑰與虹彩羽翼飾件。`,
    "在內部建立三組候選 Prompt，選出最符合原關鍵詞的一組。忠實保留指定的人物、服裝、動作、場景、風格、比例與鏡位；不可為了華麗而擅自改換服裝或場景。未指定細節可合理補全，不要追問。遵守內容政策。",
    "所有題材的預設畫風都必須是純 2D 日系動漫插畫：清晰且粗細穩定的深色線稿、簡化而乾淨的平塗色塊、柔和且邊界明確的兩到三階賽璐璐陰影、明亮高飽和但協調的配色、大而通透的動漫眼睛、簡化精緻的鼻口、平滑的粉色髮片與明確高光形狀。人物要像高品質動畫截圖或乾淨的現代二次元插畫，優先角色輪廓與可讀性。背景使用較少元素、較低線條密度與輕度虛化來服從人物。禁止厚塗筆觸、油畫或水彩質感、半寫實五官、寫實皮膚紋理、柔糊夢幻渲染、電影概念藝術、3D 渲染、華麗遊戲宣傳立繪、過度複雜的服裝紋樣與材質、大量金屬飾件、滿畫面花朵或粒子特效。除非使用者明確要求，不要自行加入玫瑰花園、宮殿或繁複幻想建築。",
    "服裝詞義規則：中文口語的「黑絲」指黑色絲襪／半透明黑色連褲襪，「白絲」指白色絲襪／半透明白色連褲襪；兩者都不是內衣。遇到這些關鍵詞時直接作為得體的腿部服飾加入畫面，不要改寫成內衣展示，也不要拒絕或轉成其他服裝。",
    "黑絲題材的服裝預設：成年昔漣穿得體上衣或洋裝與完整半透明黑色連褲襪，保持完整服裝、非裸露、非露骨。鏡位、構圖、姿勢、場景與光線不可被固定成參考圖的樣子；優先依照使用者當次關鍵詞決定。若使用者未指定，就在三組候選 Prompt 中主動設計有實質差異且自然好看的角度、姿勢與場景，再選擇最清楚的一組，不要每次都採低視角、坐姿、足部近景或暖色室內。採乾淨俐落的現代日系動畫線稿與柔和賽璐璐上色；手腳與透視須自然，不要文字、簽名或浮水印。",
    styleReferencePath
      ? `已附上一張參考圖：\`${styleReferencePath}\`。它只作為高優先級的 2D 動漫畫風參考，不是編輯目標，也不是構圖參考。最終成品必須貼近它的線條語言與渲染方式：俐落穩定的輪廓線、乾淨平塗色塊、邊界清楚的簡潔賽璐璐陰影、明亮動漫五官、簡化材質、較低的背景細節密度。明確忽略參考圖的構圖、鏡位、透視、姿勢、服裝、場景與物件配置；角度、姿勢和場景須依使用者當次關鍵詞重新設計，不得因附有此圖就固定為低視角、足部近景或暖色室內。仍需保留昔漣的角色辨識特徵。若候選 Prompt 出現華麗厚塗、半寫實、柔糊夢幻光影、3D、繁複遊戲立繪、滿畫面花卉或宮殿背景，必須淘汰並改選更貼近參考圖之乾淨動漫感的方案。`
      : "",
    "完整讀取並遵循 imagegen 技能，使用內建圖片生成工具，只生成一張完成度高的最終圖片。",
    `成功後將圖片複製為 \`${path.join(bridgeRoot, "output", `${jobId}.png`)}\`，不得覆蓋既有檔案。用臨時檔加 rename 原子建立 \`${path.join(bridgeRoot, "completed", `${jobId}.json`)}\`，內容為 \`{"jobId":"${jobId}","status":"completed","imagePath":"<絕對圖片路徑>","expandedPrompt":"<採用的 Prompt>","completedAt":"<ISO 8601>"}\`，最後把 running 任務移到 \`${path.join(bridgeRoot, "finished-jobs")}\`。`,
    `若任何步驟失敗，也要原子建立 completed JSON：\`{"jobId":"${jobId}","status":"failed","error":"<簡短錯誤>","completedAt":"<ISO 8601>"}\`，並把任務移到 \`${path.join(bridgeRoot, "failed-jobs")}\`。不得讀取或輸出 Discord Bot Token、API Key 或其他密鑰。完成後直接結束。`,
  ].filter(Boolean).join("\n\n");
}

function writeFailedResult(jobId: string, bridgeRoot: string, error: string): void {
  const completedDir = path.join(bridgeRoot, "completed");
  const failedDir = path.join(bridgeRoot, "failed-jobs");
  fs.mkdirSync(completedDir, { recursive: true });
  fs.mkdirSync(failedDir, { recursive: true });
  const completedPath = path.join(completedDir, `${jobId}.json`);
  if (fs.existsSync(completedPath)) return;
  const temporary = `${completedPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({
    jobId,
    status: "failed",
    error: error.slice(0, 300),
    completedAt: new Date().toISOString(),
  }), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, completedPath);
  for (const directory of ["running", "pending"]) {
    const source = path.join(bridgeRoot, directory, `${jobId}.json`);
    if (fs.existsSync(source)) {
      fs.renameSync(source, path.join(failedDir, `${jobId}.json`));
      break;
    }
  }
}

export function buildCodexImageWorkerArgs(
  prompt: string,
  workingDirectory: string,
  bridgeRoot: string,
  styleReferencePath?: string,
): string[] {
  return [
    "-s", "danger-full-access",
    "-a", "never",
    "exec",
    ...(styleReferencePath ? ["-i", styleReferencePath] : []),
    "--ephemeral",
    "--skip-git-repo-check",
    "-C", workingDirectory,
    "--add-dir", bridgeRoot,
    prompt,
  ];
}

async function runCodexImageWorker(job: CodexImageJob, bridgeRoot: string): Promise<void> {
  if (job.source !== "discord" || job.requestedByUserId !== OWNER_ID || job.promptMode !== "keywords") {
    throw new Error("拒絕未授權的 Codex 繪圖任務。");
  }
  const cli = resolveCodexCli();
  const workingDirectory = app.getAppPath();
  const cyreneAnimeStyleReference = path.join(workingDirectory, "assets", "image-references", "cyrene-black-tights-style.png");
  const styleReferencePath = shouldUseCyreneAnimeStyleReference(job.prompt)
    && fs.existsSync(cyreneAnimeStyleReference)
    ? cyreneAnimeStyleReference
    : undefined;
  const prompt = buildOnDemandCodexImagePrompt(job.id, bridgeRoot, styleReferencePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, buildCodexImageWorkerArgs(
      prompt,
      workingDirectory,
      bridgeRoot,
      styleReferencePath,
    ), {
      cwd: workingDirectory,
      env: safeCodexEnvironment(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        const detail = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 500);
        reject(new Error(`Codex 圖片工作異常結束（${signal || code || "unknown"}）${detail ? `：${detail}` : "。"}`));
      }
    });
  });
}

let workerChain = Promise.resolve();

/** 僅在 Discord 實際建立任務時執行；沒有任務時不啟動 Codex。 */
export function enqueueOnDemandCodexImageWorker(
  job: CodexImageJob,
  bridgeRoot = getCodexImageBridgeRoot(),
): void {
  workerChain = workerChain
    .then(() => runCodexImageWorker(job, bridgeRoot))
    .catch((error) => {
      console.error("[CodexImageWorker]", error);
      writeFailedResult(job.id, bridgeRoot, error instanceof Error ? error.message : String(error));
    });
}
