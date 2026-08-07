import "../ui/theme";
import "./wavesuid.css";

type PickedFile = { name: string; url: string; contentType?: string };
type WavesUidResult = { ok: boolean; text: string; media: Array<{ name: string; dataUrl?: string; url?: string }>; error?: string };

declare global {
  interface Window {
    wavesUid?: {
      status: () => Promise<{ online: boolean; localOcr?: boolean }>;
      run: (command: string, attachments?: PickedFile[]) => Promise<WavesUidResult>;
      pickFile: () => Promise<PickedFile | null>;
      captureDiscord: () => Promise<{ ok: boolean; file?: PickedFile; error?: string }>;
      login: () => Promise<{ ok: boolean; phase?: string; error?: string }>;
      loginStatus: () => Promise<{ phase: "idle" | "waiting" | "connected" | "failed"; message: string; uid?: string }>;
      dataStatus: () => Promise<{ uids: string[] }>;
      deleteData: (uid: string) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}

const commandInput = document.getElementById("command-input") as HTMLInputElement;
const runButton = document.getElementById("run-btn") as HTMLButtonElement;
const attachButton = document.getElementById("attach-btn") as HTMLButtonElement;
const captureDiscordButton = document.getElementById("capture-discord-btn") as HTMLButtonElement;
const loginButton = document.getElementById("login-btn") as HTMLButtonElement;
const loginStatusTitle = document.getElementById("login-status-title") as HTMLElement;
const loginStatusDetail = document.getElementById("login-status-detail") as HTMLElement;
const attachmentChip = document.getElementById("attachment-chip") as HTMLElement;
const attachmentName = document.getElementById("attachment-name") as HTMLElement;
const resultCommand = document.getElementById("result-command") as HTMLElement;
const resultText = document.getElementById("result-text") as HTMLElement;
const resultMedia = document.getElementById("result-media") as HTMLElement;
const mediaLightbox = document.getElementById("media-lightbox") as HTMLDialogElement;
const mediaLightboxImage = document.getElementById("media-lightbox-image") as HTMLImageElement;
const errorMessage = document.getElementById("error-message") as HTMLElement;
const serviceState = document.getElementById("service-state") as HTMLElement;
const privacyDetail = document.getElementById("privacy-detail") as HTMLElement;
const storedData = document.getElementById("stored-data") as HTMLElement;
const storedUid = document.getElementById("stored-uid") as HTMLSelectElement;
const deleteDataButton = document.getElementById("delete-data-btn") as HTMLButtonElement;
const views = ["empty-state", "loading-state", "result-content", "error-state"].map((id) => document.getElementById(id) as HTMLElement);
let selectedFile: PickedFile | null = null;

function showView(id: string): void { for (const view of views) view.hidden = view.id !== id; }

function setCommand(command: string): void {
  commandInput.value = command;
  document.querySelectorAll<HTMLElement>(".command-card").forEach((card) => card.classList.toggle("is-active", card.dataset.command === command));
}

async function refreshStatus(): Promise<void> {
  const state = await window.wavesUid?.status().catch(() => ({ online: false, localOcr: false }));
  const online = Boolean(state?.online);
  const localOcr = Boolean(state?.localOcr);
  serviceState.classList.toggle("is-online", online);
  serviceState.classList.toggle("is-offline", !online);
  const label = serviceState.querySelector("b");
  if (label) label.textContent = online && localOcr ? "本機 OCR 就緒" : online ? "核心在線 · OCR 未安裝" : "本機核心離線";
  privacyDetail.textContent = localOcr
    ? "macOS Vision · 零雲端上傳 · 暫存圖片即時清除"
    : "找不到本機 OCR 元件，截圖分析暫停使用";
  await refreshStoredData();
  await refreshLoginStatus();
}

async function refreshLoginStatus(): Promise<void> {
  const state = await window.wavesUid?.loginStatus().catch(() => null);
  if (!state) return;
  const labels = { idle: "尚未連結", waiting: "等待登入完成", connected: "國際服已連結", failed: "連結未完成" };
  loginStatusTitle.textContent = labels[state.phase];
  loginStatusDetail.textContent = state.uid ? `${state.message} UID：${state.uid}` : state.message;
  loginButton.textContent = state.phase === "connected" ? "重新連結" : state.phase === "waiting" ? "登入視窗已開啟" : "連結國際服";
  loginButton.disabled = state.phase === "waiting";
}

async function refreshStoredData(): Promise<void> {
  const data = await window.wavesUid?.dataStatus().catch(() => ({ uids: [] as string[] }));
  const uids = data?.uids ?? [];
  storedUid.replaceChildren(...uids.map((uid) => {
    const option = document.createElement("option");
    option.value = uid;
    option.textContent = uid;
    return option;
  }));
  storedData.hidden = uids.length === 0;
  deleteDataButton.hidden = uids.length === 0;
}

function renderMedia(media: WavesUidResult["media"]): void {
  resultMedia.replaceChildren();
  for (const item of media) {
    const source = item.dataUrl || item.url;
    if (!source) continue;
    if (/\.(?:png|jpe?g|gif|webp)$/i.test(item.name) || source.startsWith("data:image/")) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = item.name;
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "media-preview";
      preview.title = "點擊放大檢視";
      preview.setAttribute("aria-label", `放大檢視 ${item.name}`);
      preview.appendChild(image);
      preview.addEventListener("click", () => {
        mediaLightboxImage.src = source;
        mediaLightboxImage.alt = item.name;
        mediaLightbox.showModal();
      });
      resultMedia.appendChild(preview);
    } else {
      const link = document.createElement("a");
      link.href = source;
      link.download = item.name;
      link.textContent = `下載 ${item.name}`;
      resultMedia.appendChild(link);
    }
  }
}

function closeMediaLightbox(): void {
  if (mediaLightbox.open) mediaLightbox.close();
}

async function runCommand(): Promise<void> {
  if (!window.wavesUid || runButton.disabled) return;
  const command = commandInput.value.trim() || "幫助";
  if (command === "分析" && !selectedFile) {
    errorMessage.textContent = "請先選擇官方 Discord Bot 產生的角色卡圖片。";
    showView("error-state");
    return;
  }
  runButton.disabled = true;
  showView("loading-state");
  try {
    const result = await window.wavesUid.run(command, selectedFile ? [selectedFile] : []);
    if (!result.ok) throw new Error(result.error || "插件沒有回傳結果");
    resultCommand.textContent = `WW ${command}`;
    resultText.textContent = result.text;
    resultText.hidden = !result.text;
    renderMedia(result.media);
    showView("result-content");
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : String(error);
    showView("error-state");
    void refreshStatus();
  } finally {
    runButton.disabled = false;
  }
}

async function captureDiscordCard(): Promise<void> {
  if (!window.wavesUid || captureDiscordButton.disabled) return;
  captureDiscordButton.disabled = true;
  captureDiscordButton.textContent = "正在尋找角色卡…";
  showView("loading-state");
  try {
    const result = await window.wavesUid.captureDiscord();
    if (!result.ok || !result.file) throw new Error(result.error || "無法擷取 Discord 角色卡");
    selectedFile = result.file;
    attachmentChip.hidden = false;
    attachmentName.textContent = "Discord 角色卡（本機暫存）";
    setCommand("分析");
    await runCommand();
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : String(error);
    showView("error-state");
  } finally {
    captureDiscordButton.disabled = false;
    captureDiscordButton.textContent = "◎ 擷取 Discord";
  }
}

document.querySelectorAll<HTMLButtonElement>(".command-card").forEach((button) => button.addEventListener("click", async () => {
  setCommand(button.dataset.command || "幫助");
  if (button.dataset.command === "分析" && !selectedFile) {
    selectedFile = await window.wavesUid?.pickFile().catch(() => null) ?? null;
    attachmentChip.hidden = !selectedFile;
    attachmentName.textContent = selectedFile?.name ?? "";
    if (!selectedFile) return;
  }
  void runCommand();
}));
document.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((button) => button.addEventListener("click", () => {
  setCommand(button.dataset.example || "幫助");
  void runCommand();
}));
runButton.addEventListener("click", () => void runCommand());
document.getElementById("retry-btn")?.addEventListener("click", () => void runCommand());
commandInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) void runCommand(); });
attachButton.addEventListener("click", async () => {
  selectedFile = await window.wavesUid?.pickFile().catch(() => null) ?? null;
  attachmentChip.hidden = !selectedFile;
  attachmentName.textContent = selectedFile?.name ?? "";
  if (selectedFile && /\.(?:png|jpe?g|webp)$/i.test(selectedFile.name)) setCommand("分析");
});
captureDiscordButton.addEventListener("click", () => void captureDiscordCard());
document.getElementById("capture-discord-empty")?.addEventListener("click", () => void captureDiscordCard());
loginButton.addEventListener("click", async () => {
  loginButton.disabled = true;
  try {
    const result = await window.wavesUid?.login();
    if (!result?.ok) throw new Error(result?.error || "無法開啟國際服登入頁");
  } catch (error) {
    loginStatusTitle.textContent = "連結未完成";
    loginStatusDetail.textContent = error instanceof Error ? error.message : String(error);
    loginButton.disabled = false;
  }
  await refreshLoginStatus();
});
setInterval(() => void refreshLoginStatus(), 2_500);
deleteDataButton.addEventListener("click", async () => {
  const uid = storedUid.value;
  if (!uid || !window.confirm(`確定刪除 UID ${uid} 的所有本機面板資料？此操作無法復原。`)) return;
  const result = await window.wavesUid?.deleteData(uid);
  if (!result?.ok) {
    window.alert(result?.error || "無法刪除本機資料");
    return;
  }
  await refreshStoredData();
});
document.getElementById("attachment-remove")?.addEventListener("click", () => { selectedFile = null; attachmentChip.hidden = true; });
document.getElementById("copy-command")?.addEventListener("click", async (event) => {
  await navigator.clipboard.writeText(`ww${commandInput.value.trim() || "幫助"}`);
  (event.currentTarget as HTMLButtonElement).textContent = "已複製";
  setTimeout(() => { (event.currentTarget as HTMLButtonElement).textContent = "複製 Discord 指令"; }, 1200);
});
document.getElementById("media-lightbox-close")?.addEventListener("click", closeMediaLightbox);
mediaLightboxImage.addEventListener("click", closeMediaLightbox);
mediaLightbox.addEventListener("click", (event) => {
  if (event.target === mediaLightbox) closeMediaLightbox();
});

void refreshStatus();
