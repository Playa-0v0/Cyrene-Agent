type PaintProvider = "openrouter" | "gemini";
type TaskStatus = "loading" | "done" | "failed";

interface ReferenceImage {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
}

interface PaintTask {
  id: string;
  prompt: string;
  provider: PaintProvider;
  model: string;
  status: TaskStatus;
  time: string;
}

interface ConnectionInfo {
  provider: PaintProvider;
  label: string;
  connected: boolean;
  model: string;
}

const MODEL_OPTIONS: Record<PaintProvider, Array<{ value: string; label: string }>> = {
  openrouter: [
    { value: "google/gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image · 平衡" },
    { value: "google/gemini-3-pro-image", label: "Gemini 3 Pro Image · 精緻" },
    { value: "bytedance-seed/seedream-4.5", label: "Seedream 4.5 · 插畫" },
    { value: "black-forest-labs/flux.2-pro", label: "FLUX.2 Pro · 寫實" },
  ],
  gemini: [
    { value: "gemini-3.1-flash-image", label: "Nano Banana 2 · 推薦" },
    { value: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite · 快速" },
    { value: "gemini-3-pro-image", label: "Nano Banana Pro · 專業" },
  ],
};

const CLOTHING_PROMPTS: Record<string, { label: string; prompt: string }> = {
  none: { label: "未選擇服裝", prompt: "" },
  signature: {
    label: "昔漣星海禮服",
    prompt: "her signature pearl-white fitted dress with lavender-cyan filigree, rose ornaments, iridescent panels, and a deep starry-indigo asymmetric train",
  },
  casual: {
    label: "柔軟居家白襯衫",
    prompt: "a tasteful oversized soft white lounge shirt with long sleeves, relaxed cozy styling, fully covered",
  },
  "black-stockings": {
    label: "白紫禮服＋黑色絲襪",
    prompt: "an elegant white-and-lavender dress paired with tasteful black semi-sheer thigh-high stockings and refined black heels",
  },
  wedding: {
    label: "月桂婚紗",
    prompt: "an ethereal white wedding dress with a laurel motif, translucent crystal layers, lavender accents, and delicate rose embroidery",
  },
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const taskStorageKey = "cyrene.paint.tasks.v2";

document.addEventListener("DOMContentLoaded", () => {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".panel-tab");
  const panes = document.querySelectorAll<HTMLElement>(".tab-pane");
  const creationParamsEl = byId<HTMLTextAreaElement>("creation-params");
  const buildPromptBtn = byId<HTMLButtonElement>("build-prompt-btn");
  const imagePromptEl = byId<HTMLTextAreaElement>("image-prompt");
  const clearPromptBtn = byId<HTMLButtonElement>("clear-prompt-btn");
  const providerSelect = byId<HTMLSelectElement>("provider-select");
  const providerHelp = byId<HTMLParagraphElement>("provider-help");
  const modelSelect = byId<HTMLSelectElement>("model-select");
  const clothingSelect = byId<HTMLSelectElement>("clothing-select");
  const aspectSelect = byId<HTMLSelectElement>("aspect-select");
  const resolutionSelect = byId<HTMLSelectElement>("resolution-select");
  const qualitySelect = byId<HTMLSelectElement>("quality-select");
  const characterPromptEl = byId<HTMLTextAreaElement>("character-prompt");
  const injectCharacterEl = byId<HTMLInputElement>("inject-character");
  const generateBtn = byId<HTMLButtonElement>("generate-btn");
  const inlineMessage = byId<HTMLDivElement>("inline-message");
  const generationSummary = byId<HTMLDivElement>("generation-summary");

  const referenceInput = byId<HTMLInputElement>("reference-input");
  const pickReferenceBtn = byId<HTMLButtonElement>("pick-reference-btn");
  const referenceDropZone = byId<HTMLDivElement>("reference-drop-zone");
  const referenceGrid = byId<HTMLDivElement>("reference-grid");
  const referenceCount = byId<HTMLSpanElement>("reference-count");

  const headerStatus = byId<HTMLDivElement>("header-status");
  const headerProviderLabel = byId<HTMLSpanElement>("header-provider-label");
  const connectionList = byId<HTMLDivElement>("connection-list");
  const openSettingsBtn = byId<HTMLButtonElement>("open-settings-btn");

  const canvasTitle = byId<HTMLHeadingElement>("canvas-title");
  const metaResolution = byId<HTMLSpanElement>("meta-resolution");
  const metaModel = byId<HTMLSpanElement>("meta-model");
  const metaProvider = byId<HTMLSpanElement>("meta-provider");
  const viewDetailsBtn = byId<HTMLButtonElement>("view-details-btn");
  const promptDrawer = byId<HTMLDivElement>("prompt-drawer");
  const finalPromptPreview = byId<HTMLPreElement>("final-prompt-preview");
  const displayImage = byId<HTMLImageElement>("display-image");
  const imageStage = byId<HTMLDivElement>("image-stage");
  const canvasLoader = byId<HTMLDivElement>("canvas-loader");
  const loaderText = byId<HTMLElement>("loader-text");
  const tasksCount = byId<HTMLSpanElement>("tasks-count");
  const tasksList = byId<HTMLDivElement>("tasks-list");

  let references: ReferenceImage[] = [];
  let connections: ConnectionInfo[] = [];
  let taskHistory = loadTasks();

  function setMessage(message: string, isError = false) {
    inlineMessage.textContent = message;
    inlineMessage.classList.toggle("is-error", isError);
  }

  function loadTasks(): PaintTask[] {
    try {
      const value = JSON.parse(localStorage.getItem(taskStorageKey) || "[]") as PaintTask[];
      return Array.isArray(value) ? value.slice(0, 12) : [];
    } catch {
      return [];
    }
  }

  function saveTasks() {
    const persisted = taskHistory.filter((task) => task.status !== "loading").slice(0, 12);
    localStorage.setItem(taskStorageKey, JSON.stringify(persisted));
  }

  function renderTasks() {
    tasksCount.textContent = `${taskHistory.length} 項`;
    tasksList.replaceChildren();
    if (taskHistory.length === 0) {
      const empty = document.createElement("div");
      empty.className = "task-empty";
      empty.textContent = "完成第一次生成後，任務會保留在這裡。";
      tasksList.appendChild(empty);
      return;
    }

    for (const task of taskHistory) {
      const item = document.createElement("div");
      item.className = "task-item";
      const prompt = document.createElement("div");
      prompt.className = "task-item__prompt";
      prompt.textContent = task.prompt;
      prompt.title = task.prompt;

      const meta = document.createElement("div");
      meta.className = "task-item__meta";
      const status = document.createElement("span");
      status.className = `task-item__status task-item__status--${task.status}`;
      status.textContent = task.status === "done" ? "已完成" : task.status === "failed" ? "失敗" : "生成中";
      const time = document.createElement("span");
      time.className = "task-item__time";
      time.textContent = task.time;
      meta.append(status, time);
      item.append(prompt, meta);
      tasksList.appendChild(item);
    }
  }

  function renderModels() {
    const provider = providerSelect.value as PaintProvider;
    const previous = modelSelect.value;
    modelSelect.replaceChildren();
    for (const model of MODEL_OPTIONS[provider]) {
      const option = document.createElement("option");
      option.value = model.value;
      option.textContent = model.label;
      modelSelect.appendChild(option);
    }
    if (MODEL_OPTIONS[provider].some((model) => model.value === previous)) modelSelect.value = previous;
    updateMeta();
  }

  function updateMeta() {
    const provider = providerSelect.value as PaintProvider;
    const clothing = CLOTHING_PROMPTS[clothingSelect.value] ?? CLOTHING_PROMPTS.none;
    canvasTitle.textContent = `AI 繪圖 · ${clothing.label}`;
    metaResolution.textContent = `${aspectSelect.value} · ${resolutionSelect.value}`;
    metaModel.textContent = modelSelect.value || "等待選擇模型";
    metaProvider.textContent = provider === "openrouter" ? "OpenRouter" : "Gemini";
    const spans = generationSummary.querySelectorAll("span");
    if (spans[0]) spans[0].textContent = `參考圖 ${references.length} 張`;
    providerHelp.textContent = provider === "openrouter"
      ? "透過 OpenRouter Unified Image API 生成，可在模型間切換。"
      : "直接使用 Gemini 原生圖片 API，適合角色一致性與多輪修改。";
  }

  function renderConnections() {
    connectionList.replaceChildren();
    for (const connection of connections) {
      const card = document.createElement("div");
      card.className = "connection-card";
      const icon = document.createElement("span");
      icon.className = "connection-card__icon";
      icon.textContent = connection.provider === "openrouter" ? "◈" : "✦";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = connection.label;
      const model = document.createElement("small");
      model.textContent = connection.model || "尚未設定模型";
      copy.append(title, model);
      const state = document.createElement("span");
      state.className = `connection-card__state${connection.connected ? " is-connected" : ""}`;
      state.textContent = connection.connected ? "已連接" : "未設定";
      card.append(icon, copy, state);
      connectionList.appendChild(card);
    }

    const selected = connections.find((item) => item.provider === providerSelect.value);
    const anyConnected = connections.some((item) => item.connected);
    headerStatus.classList.toggle("is-offline", !anyConnected);
    headerProviderLabel.textContent = selected?.connected
      ? `${selected.label} 已連接`
      : anyConnected
        ? "已有可用圖片生成管道"
        : "請先設定 OpenRouter 或 Gemini API Key";
  }

  async function refreshConnections() {
    try {
      connections = await window.paint.getConnections();
      const openrouter = connections.find((item) => item.provider === "openrouter");
      const gemini = connections.find((item) => item.provider === "gemini");
      if (!openrouter?.connected && gemini?.connected) providerSelect.value = "gemini";
      renderModels();
      renderConnections();
    } catch {
      connections = [
        { provider: "openrouter", label: "OpenRouter", connected: false, model: "" },
        { provider: "gemini", label: "Gemini", connected: false, model: "" },
      ];
      renderConnections();
    }
  }

  function buildFinalPrompt() {
    const parts: string[] = [];
    if (injectCharacterEl.checked && characterPromptEl.value.trim()) parts.push(characterPromptEl.value.trim());
    if (imagePromptEl.value.trim()) parts.push(imagePromptEl.value.trim());
    const clothing = CLOTHING_PROMPTS[clothingSelect.value]?.prompt;
    if (clothing) parts.push(clothing);
    parts.push("premium anime game key art, refined cel shading, accurate anatomy and hands, no text, no logo, no watermark");
    return parts.join(". ");
  }

  function fileToReference(file: File): Promise<ReferenceImage> {
    return new Promise((resolve, reject) => {
      if (file.size > 8 * 1024 * 1024) {
        reject(new Error(`${file.name} 超過 8 MB`));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        dataUrl: String(reader.result),
        mimeType: file.type || "image/png",
      });
      reader.onerror = () => reject(new Error(`無法讀取 ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function addReferenceFiles(files: File[]) {
    const remaining = 4 - references.length;
    if (remaining <= 0) {
      setMessage("最多只能加入 4 張參考圖。", true);
      return;
    }
    try {
      const loaded = await Promise.all(files.slice(0, remaining).map(fileToReference));
      references = [...references, ...loaded];
      renderReferences();
      setMessage(`已加入 ${loaded.length} 張參考圖。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "參考圖讀取失敗。", true);
    }
  }

  function renderReferences() {
    referenceGrid.replaceChildren();
    for (const reference of references) {
      const item = document.createElement("div");
      item.className = "reference-item";
      const image = document.createElement("img");
      image.src = reference.dataUrl;
      image.alt = reference.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `移除 ${reference.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        references = references.filter((item) => item.id !== reference.id);
        renderReferences();
      });
      item.append(image, remove);
      referenceGrid.appendChild(item);
    }
    referenceCount.textContent = String(references.length);
    updateMeta();
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => item.classList.remove("is-active"));
      panes.forEach((pane) => pane.classList.remove("is-active"));
      tab.classList.add("is-active");
      byId<HTMLElement>(`pane-${tab.dataset.panelTab}`).classList.add("is-active");
      if (tab.dataset.panelTab === "connection") void refreshConnections();
    });
  });

  buildPromptBtn.addEventListener("click", async () => {
    const description = creationParamsEl.value.trim();
    if (!description) {
      setMessage("請先輸入中文創作描述。", true);
      creationParamsEl.focus();
      return;
    }
    buildPromptBtn.disabled = true;
    buildPromptBtn.textContent = "✦ 正在整理畫面語言…";
    setMessage("");
    try {
      const result = await window.paint.buildPrompt(description);
      if (!result?.trim()) throw new Error("提示詞模型沒有回傳內容，請檢查主要模型連線。 ");
      imagePromptEl.value = result.trim();
      setMessage("Prompt 已完成，可以直接生成或繼續修改。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Prompt 構建失敗。", true);
    } finally {
      buildPromptBtn.disabled = false;
      buildPromptBtn.textContent = "✦ 構建繪圖 Prompt";
    }
  });

  clearPromptBtn.addEventListener("click", () => {
    imagePromptEl.value = "";
    creationParamsEl.value = "";
    setMessage("");
  });

  providerSelect.addEventListener("change", () => {
    renderModels();
    renderConnections();
  });
  for (const element of [modelSelect, clothingSelect, aspectSelect, resolutionSelect, qualitySelect]) {
    element.addEventListener("change", updateMeta);
  }

  pickReferenceBtn.addEventListener("click", () => referenceInput.click());
  referenceInput.addEventListener("change", () => {
    void addReferenceFiles(Array.from(referenceInput.files ?? []));
    referenceInput.value = "";
  });
  referenceDropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    referenceDropZone.classList.add("is-dragging");
  });
  referenceDropZone.addEventListener("dragleave", () => referenceDropZone.classList.remove("is-dragging"));
  referenceDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    referenceDropZone.classList.remove("is-dragging");
    void addReferenceFiles(Array.from(event.dataTransfer?.files ?? []));
  });

  viewDetailsBtn.addEventListener("click", () => {
    promptDrawer.classList.toggle("is-open");
    viewDetailsBtn.textContent = promptDrawer.classList.contains("is-open") ? "隱藏完整提示詞" : "查看完整提示詞";
  });

  openSettingsBtn.addEventListener("click", () => window.paint.openSettings());

  generateBtn.addEventListener("click", async () => {
    const finalPrompt = buildFinalPrompt();
    if (!imagePromptEl.value.trim() && !creationParamsEl.value.trim()) {
      setMessage("請先輸入或構建繪圖 Prompt。", true);
      imagePromptEl.focus();
      return;
    }

    const provider = providerSelect.value as PaintProvider;
    const connection = connections.find((item) => item.provider === provider);
    if (!connection?.connected) {
      setMessage(`尚未設定 ${provider === "openrouter" ? "OpenRouter" : "Gemini"} API Key，請到連接頁前往設定。`, true);
      return;
    }

    const model = modelSelect.value;
    const now = new Date();
    const task: PaintTask = {
      id: `task-${Date.now()}`,
      prompt: finalPrompt,
      provider,
      model,
      status: "loading",
      time: now.toLocaleTimeString("zh-TW", { hour12: false }),
    };
    taskHistory.unshift(task);
    renderTasks();
    updateMeta();
    finalPromptPreview.textContent = finalPrompt;
    canvasLoader.classList.add("is-loading");
    generateBtn.disabled = true;
    loaderText.textContent = provider === "openrouter" ? "OpenRouter 正在生成畫面…" : "Gemini 正在繪製畫面…";
    setMessage("");

    try {
      const result = await window.paint.generateImage({
        provider,
        prompt: finalPrompt,
        model,
        aspectRatio: aspectSelect.value,
        resolution: resolutionSelect.value as "1K" | "2K" | "4K",
        quality: qualitySelect.value as "auto" | "low" | "medium" | "high",
        references: references.map(({ dataUrl, mimeType }) => ({ dataUrl, mimeType })),
      });
      if (!result?.dataUrl) throw new Error("圖片服務沒有回傳可顯示的圖片。");
      displayImage.src = result.dataUrl;
      imageStage.style.aspectRatio = aspectSelect.value.replace(":", " / ");
      task.status = "done";
      setMessage(
        `${provider === "openrouter" ? "OpenRouter" : "Gemini"} 生成完成。${result.savedPath ? ` 已儲存至 ${result.savedPath}` : ""}`,
      );
    } catch (error) {
      task.status = "failed";
      setMessage(error instanceof Error ? error.message : "圖片生成失敗。", true);
    } finally {
      canvasLoader.classList.remove("is-loading");
      generateBtn.disabled = false;
      saveTasks();
      renderTasks();
    }
  });

  renderTasks();
  renderModels();
  renderReferences();
  void refreshConnections();
});
