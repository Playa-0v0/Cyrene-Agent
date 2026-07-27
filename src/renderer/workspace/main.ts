declare global {
  interface Window {
    sidebar?: {
      minimize: () => void;
      close: () => void;
      toggleMaximize: () => void;
      openCall: () => void;
      setPetDockVisible: (visible: boolean) => void;
      reportSlotBounds: (bounds: { x: number; y: number; width: number; height: number; isDocked: boolean }) => void;
      onPetDockChanged: (cb: (docked: boolean) => void) => () => void;
      readSharedNotebook: () => Promise<string>;
      openSharedNotebook: () => Promise<boolean>;
    };
    modelConfig?: {
      get: () => Promise<{ model: string; provider: string; connected: boolean }>;
      onChanged: (cb: (config: { model: string; provider: string; connected: boolean }) => void) => () => void;
    };
    runtimeState?: {
      get: () => Promise<{ status: string; feeling: string }>;
      onChanged: (cb: (state: { status: string; feeling: string }) => void) => () => void;
    };
    tokenUsage?: {
      get: (days: number) => Promise<Array<{ date: string; input: number; output: number }>>;
    };
    callUsage?: {
      get: (days: number) => Promise<Array<{
        date: string;
        weekday: string;
        totalMs: number;
        desktopMs: number;
        discordMs: number;
        active: boolean;
      }>>;
    };
    cyreneScheduler?: {
      list: () => Promise<{ ok: boolean; value?: Array<{ enabled: boolean; title: string; nextFireAt: string | null }> }>;
    };
    tasks?: {
      onSchedulerChanged: (cb: () => void) => () => void;
    };
    connectionStatus?: {
      get: () => Promise<Array<{ id: string; name: string; detail: string; icon: string; state: "connected" | "pending" | "error"; label: string }>>;
    };
    chatStore?: {
      list: () => Promise<Array<{ id: string; title: string; updatedAt: number }>>;
      getMessages?: (sessionId: string) => Promise<Array<{ role: string }>>;
      rename: (id: string, title: string) => Promise<unknown>;
      delete: (id: string) => Promise<boolean>;
      onChanged?: (cb: () => void) => () => void;
    };
  }
}

const iframe = document.getElementById("content-iframe") as HTMLIFrameElement;
const tabs = document.querySelectorAll(".sidebar__tab");
const minBtn = document.getElementById("min-btn");
const maxBtn = document.getElementById("max-btn");
const closeBtn = document.getElementById("close-btn");
const resetBtn = document.getElementById("reset-btn");

const headerModelStatusEl = document.getElementById("header-model-status");
const modelNameEl = document.getElementById("model-name");
const onlineLabelEl = document.getElementById("online-label");

const statMessagesEl = document.getElementById("stat-messages");
const statInteractionsEl = document.getElementById("stat-interactions");
const statTokensEl = document.getElementById("stat-tokens");
const agentCoreStatusEl = document.getElementById("agent-core-status");
const agentSessionCountEl = document.getElementById("agent-session-count");

const infoTabs = document.querySelectorAll(".info-tab");
const statsCard = document.querySelector(".stats-tab-content") as HTMLElement | null;
const nextCard = document.querySelector(".next-card") as HTMLElement | null;
const connCard = document.querySelector(".conn-card") as HTMLElement | null;
const connectionStatusList = document.getElementById("connection-status-list");
const petSlot = document.getElementById("pet-slot");

// 預設只顯示「概覽」卡片，隱藏「日程」與「狀態」
if (nextCard) nextCard.style.display = "none";
if (connCard) connCard.style.display = "none";

const infoPanel = document.querySelector(".info-panel") as HTMLElement | null;

function setInfoPanelVisible(visible: boolean) {
  if (infoPanel) {
    infoPanel.style.display = visible ? "flex" : "none";
  }
}

// 1. 左側選單分頁切換邏輯
tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");

    const targetTab = tab.getAttribute("data-tab");
    if (targetTab) {
      updateTitlebarModeText(targetTab);
    }

    // 如果是共同筆記本、遊戲房或考試模式，隱藏右側資訊面板以騰出全寬空間，並將停靠在裡面的桌寵暫時隱藏（不讓其彈出到桌面）
    if (targetTab === "notebook" || targetTab === "game-room" || targetTab === "exam") {
      setInfoPanelVisible(false);
      window.sidebar?.setPetDockVisible(false);
    } else {
      setInfoPanelVisible(true);
      const activeInfoTab = document.querySelector(".info-tab.is-active")?.textContent?.trim();
      window.sidebar?.setPetDockVisible(activeInfoTab === "概覽");
    }
    
    // 即時重新上報桌寵停靠狀態與座標
    reportSlotBounds();

    if (targetTab === "chat") {
      iframe.src = "../chat/index.html";
    } else if (targetTab === "tasks") {
      iframe.src = "../tasks/index.html";
    } else if (targetTab === "memory") {
      iframe.src = "../settings/index.html#memory";
    } else if (targetTab === "notebook") {
      iframe.src = "../notebook/index.html";
    } else if (targetTab === "exam") {
      iframe.src = "../exam/index.html";
    } else if (targetTab === "game-room") {
      iframe.src = "../game-room/index.html";
    } else if (targetTab === "channels") {
      iframe.src = "../settings/index.html#channels-discord";
    } else if (targetTab === "stickers") {
      iframe.src = "../paint/index.html";
    } else if (targetTab === "settings") {
      iframe.src = "../settings/index.html#general";
    }
  });
});

let activeMode = "chat";
let activeStyle = "01_default.md";

const modeValEl = document.getElementById("ws-mode-val");
const styleValEl = document.getElementById("ws-style-val");
const titlebarModeEl = document.querySelector(".titlebar__mode");

function updateTitlebarModeText(tab: string) {
  if (!titlebarModeEl) return;
  if (tab === "chat") {
    titlebarModeEl.textContent = modeValEl?.textContent?.trim() || "協作";
  } else if (tab === "tasks") {
    titlebarModeEl.textContent = "備忘任務";
  } else if (tab === "notebook") {
    titlebarModeEl.textContent = "共同筆記本";
  } else if (tab === "exam") {
    titlebarModeEl.textContent = "考試模式";
  } else if (tab === "game-room") {
    titlebarModeEl.textContent = "遊戲房";
  } else if (tab === "settings" || tab === "memory") {
    titlebarModeEl.textContent = "系統設置";
  } else if (tab === "channels") {
    titlebarModeEl.textContent = "渠道管理";
  } else {
    titlebarModeEl.textContent = "陪伴模式";
  }
}

const modeItems = document.querySelectorAll("#ws-mode-menu .ws-dropdown__item");
const styleItems = document.querySelectorAll("#ws-style-menu .ws-dropdown__item");

function broadcastStateToIframe() {
  try {
    iframe.contentWindow?.postMessage({ type: "set-mode", value: activeMode }, "*");
    iframe.contentWindow?.postMessage({ type: "set-style", value: activeStyle }, "*");
  } catch (err) {
    console.warn("Failed to broadcast state to iframe:", err);
  }
}

// 監聽 iframe 載入完成，確保每次切換回聊天頁面時能自動同步最新模式與風格
iframe.addEventListener("load", () => {
  broadcastStateToIframe();
});

modeItems.forEach((item) => {
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    modeItems.forEach((i) => i.classList.remove("is-active"));
    item.classList.add("is-active");
    
    const value = item.getAttribute("data-value") || "chat";
    const label = item.textContent?.trim() || "協作";
    activeMode = value;
    if (modeValEl) modeValEl.textContent = label;
    updateTitlebarModeText("chat");
    broadcastStateToIframe();
  });
});

styleItems.forEach((item) => {
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    styleItems.forEach((i) => i.classList.remove("is-active"));
    item.classList.add("is-active");
    
    const value = item.getAttribute("data-value") || "01_default.md";
    const label = item.textContent?.trim() || "🌸 溫柔 · 和善";
    activeStyle = value;
    if (styleValEl) styleValEl.textContent = label;
    broadcastStateToIframe();
  });
});

const reasoningValEl = document.getElementById("ws-reasoning-val");
const reasoningItems = document.querySelectorAll("#ws-reasoning-menu .ws-dropdown__item");

reasoningItems.forEach((item) => {
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    reasoningItems.forEach((i) => i.classList.remove("is-active"));
    item.classList.add("is-active");
    
    const label = item.textContent?.trim() || "Auto · 自動";
    if (reasoningValEl) reasoningValEl.textContent = label;
    
    const value = item.getAttribute("data-value") || "auto";
    try {
      iframe.contentWindow?.postMessage({ type: "set-reasoning", value }, "*");
    } catch (err) {
      console.warn("Failed to broadcast reasoning state:", err);
    }
  });
});

// 1.5. 右側陪伴面板標籤切換邏輯
infoTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    infoTabs.forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");

    const tabText = tab.textContent?.trim();
    const showDockSlot = tabText === "概覽";
    if (petSlot) petSlot.hidden = !showDockSlot;
    window.sidebar?.setPetDockVisible(showDockSlot);
    
    // 即時重新上報桌寵停靠狀態與座標
    reportSlotBounds();

    if (tabText === "概覽") {
      if (statsCard) statsCard.style.display = "block";
      if (nextCard) nextCard.style.display = "none";
      if (connCard) connCard.style.display = "none";
    } else if (tabText === "日程") {
      if (statsCard) statsCard.style.display = "none";
      if (nextCard) nextCard.style.display = "block";
      if (connCard) connCard.style.display = "none";
    } else if (tabText === "狀態") {
      if (statsCard) statsCard.style.display = "none";
      if (nextCard) nextCard.style.display = "none";
      if (connCard) connCard.style.display = "block";
    }
  });
});

// 2. 視窗控制按鈕
minBtn?.addEventListener("click", () => {
  window.sidebar?.minimize();
});

maxBtn?.addEventListener("click", () => {
  window.sidebar?.toggleMaximize();
});

closeBtn?.addEventListener("click", () => {
  window.sidebar?.close();
});

resetBtn?.addEventListener("click", () => {
  iframe.src = "../settings/index.html#general";
  tabs.forEach((t) => t.classList.remove("is-active"));
  const settingsTab = document.querySelector('.sidebar__tab[data-tab="settings"]');
  settingsTab?.classList.add("is-active");
  setInfoPanelVisible(true);
});

const panelChatBtn = document.getElementById("panel-chat-btn");
const panelCallBtn = document.getElementById("panel-call-btn");
const panelModelBtn = document.getElementById("panel-model-btn");

panelChatBtn?.addEventListener("click", () => {
  const chatTab = document.querySelector('.sidebar__tab[data-tab="chat"]') as HTMLElement;
  if (chatTab) chatTab.click();
});

panelCallBtn?.addEventListener("click", () => {
  window.sidebar?.openCall();
});

panelModelBtn?.addEventListener("click", () => {
  const settingsTab = document.querySelector('.sidebar__tab[data-tab="settings"]') as HTMLElement;
  if (settingsTab) {
    settingsTab.click();
    iframe.src = "../settings/index.html#api";
  }
});



// 4. 連接與狀態同步
async function initStatusSync() {
  // 對話模型同步
  if (window.modelConfig) {
    try {
      const cfg = await window.modelConfig.get();
      if (modelNameEl) modelNameEl.textContent = cfg.model || "未連接";
      if (headerModelStatusEl) headerModelStatusEl.textContent = `${cfg.model || "模型"} 已連接`;
      if (agentCoreStatusEl) agentCoreStatusEl.textContent = cfg.connected ? "Agent Core 運行中" : "Agent Core 未連接";
    } catch (err) {
      console.error("Failed to load model config:", err);
    }

    window.modelConfig.onChanged((cfg) => {
      if (modelNameEl) modelNameEl.textContent = cfg.model || "未連接";
      if (headerModelStatusEl) headerModelStatusEl.textContent = `${cfg.model || "模型"} 已連接`;
      if (agentCoreStatusEl) agentCoreStatusEl.textContent = cfg.connected ? "Agent Core 運行中" : "Agent Core 未連接";
    });
  }

  // 情感/狀態同步
  if (window.runtimeState && window.modelConfig) {
    const STATUS_EMOJI: Record<string, string> = {
      陪伴中: "🌸",
      思考中: "💭",
      工作中: "⚡",
      聆聽中: "🫧",
      提醒中: "🔔",
      離線: "💤",
    };

    const FEELING_EMOJI: Record<string, string> = {
      平靜: "🌿",
      開心: "✨",
      溫柔: "🌸",
      激動: "🎉",
      撒嬌: "🥺",
      擔心: "💙",
      難過: "💧",
      感動: "🥹",
      害羞: "🌹",
    };

    const wsStatusEmoji = document.getElementById("ws-status-emoji");
    const wsStatusVal = document.getElementById("ws-status-val");
    const wsFeelingEmoji = document.getElementById("ws-feeling-emoji");
    const wsFeelingVal = document.getElementById("ws-feeling-val");

    const updateRuntimeDisplay = async () => {
      try {
        const config = await window.modelConfig!.get();
        const syncEnabled = config.runtimeSync === "local" || config.runtimeSync === "llm";
        const state = await window.runtimeState!.get();

        if (onlineLabelEl) {
          onlineLabelEl.textContent = `剛睡醒 · 心情${state.feeling || "平靜"}`;
        }

        if (!syncEnabled) {
          if (wsStatusEmoji) wsStatusEmoji.textContent = "⚙️";
          if (wsStatusVal) wsStatusVal.textContent = "狀態：請到設置裡開啟";
          if (wsFeelingEmoji) wsFeelingEmoji.textContent = "⚙️";
          if (wsFeelingVal) wsFeelingVal.textContent = "心情：請到設置裡開啟";
        } else {
          const status = state.status || "陪伴中";
          const feeling = state.feeling || "平靜";
          if (wsStatusEmoji) wsStatusEmoji.textContent = STATUS_EMOJI[status] || "💬";
          if (wsStatusVal) wsStatusVal.textContent = `狀態：${status}`;
          if (wsFeelingEmoji) wsFeelingEmoji.textContent = FEELING_EMOJI[feeling] || "🌿";
          if (wsFeelingVal) wsFeelingVal.textContent = `心情：${feeling}`;
        }
      } catch (err) {
        console.error("Failed to update runtime display:", err);
      }
    };

    void updateRuntimeDisplay();
    window.runtimeState.onChanged(() => { void updateRuntimeDisplay(); });
    window.modelConfig.onChanged(() => { void updateRuntimeDisplay(); });
  }

  // 5. 數據統計讀取 (今日概覽)
  async function updateTokenUsageStats() {
    try {
      if (!window.tokenUsage) return;
      const tokenData = await window.tokenUsage.get(7);
      let totalTokens = 0;
      tokenData.forEach(d => {
        totalTokens += (d.input + d.output);
      });
      if (statTokensEl) {
        if (totalTokens > 1000) {
          statTokensEl.textContent = `${Math.round(totalTokens / 1000)}K`;
        } else {
          statTokensEl.textContent = String(totalTokens);
        }
      }

      // 5.1 更新日程分頁的 Token 用量與圖表
      const today = new Date();
      const weekdays = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
      
      const scheduleDateTextEl = document.getElementById("schedule-date-text");
      if (scheduleDateTextEl) {
        scheduleDateTextEl.textContent = `📅 ${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日 · ${weekdays[today.getDay()]}`;
      }

      const todayData = tokenData[tokenData.length - 1];
      const todayTotal = todayData ? (todayData.input + todayData.output) : 0;
      
      const tokenUsageTodayValEl = document.getElementById("token-usage-today-val");
      if (tokenUsageTodayValEl) {
        tokenUsageTodayValEl.textContent = todayTotal.toLocaleString();
      }

      const tokenProgressFillBar = document.getElementById("token-progress-fill-bar");
      if (tokenProgressFillBar) {
        const percent = Math.min(100, (todayTotal / 1000000) * 100);
        tokenProgressFillBar.style.width = `${percent}%`;
      }

      let maxTokens = 0;
      let maxDayName = "週日";
      let totalSum = 0;

      // 圖表表示「本週（日～六）」而不是「最近七天」。只用 weekday
      // 配對會把上週六的資料錯畫到本週尚未到來的週六。
      const weekStart = new Date(today);
      weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(today.getDate() - today.getDay());
      const weekDayTotals = weekdays.map((dayName, dayIndex) => {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + dayIndex);
        const dateKey = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const isFuture = date.getTime() > today.getTime();
        const data = isFuture ? undefined : tokenData.find((entry) => entry.date === dateKey);
        return { dayName, total: data ? data.input + data.output : 0 };
      });

      weekDayTotals.slice(0, today.getDay() + 1).forEach(({ dayName, total: sum }) => {
        totalSum += sum;
        if (sum > maxTokens) {
          maxTokens = sum;
          maxDayName = dayName;
        }
      });

      const elapsedDays = today.getDay() + 1;
      const avgTokens = Math.round(totalSum / elapsedDays);
      const avgK = (avgTokens / 1000).toFixed(1);
      const maxK = (maxTokens / 1000).toFixed(1);

      const tokenAvgValEl = document.getElementById("token-avg-val");
      if (tokenAvgValEl) {
        tokenAvgValEl.textContent = `日均 ${avgK}K`;
      }

      const tokenChartPeakDescEl = document.getElementById("token-chart-peak-desc");
      if (tokenChartPeakDescEl) {
        tokenChartPeakDescEl.textContent = `📊 本周 Token 消耗趨勢 | 峰值 ${maxK}K (${maxDayName})`;
      }

      const barItems = document.querySelectorAll(".chart-bar-item");
      barItems.forEach((item) => {
        const fillEl = item.querySelector(".chart-bar-fill") as HTMLElement;
        if (fillEl) {
          const dayIndex = Number((item as HTMLElement).dataset.day);
          const dayTotal = weekDayTotals[dayIndex]?.total ?? 0;
          const heightPercent = maxTokens > 0 ? Math.min(100, (dayTotal / maxTokens) * 100) : 0;
          fillEl.style.height = `${heightPercent}%`;
        }
      });
    } catch (err) {
      console.warn("Failed to load token usage stats:", err);
    }
  }

  // Token 數據來自主進程的持久化用量存儲；定期重讀，讓聊天後的
  // input/output token 累加能在面板仍開啟時同步顯示。
  void updateTokenUsageStats();
  window.setInterval(() => void updateTokenUsageStats(), 10_000);

  function formatCallDuration(ms: number, compact = false): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds > 0 && !compact ? `${seconds} 秒` : compact ? "0分" : "0 分鐘";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours === 0) return compact ? `${minutes}分` : `${minutes} 分鐘`;
    if (compact) return minutes ? `${hours}時 ${minutes}分` : `${hours}時`;
    if (minutes === 0) return `${hours} 小時`;
    return `${hours} 小時 ${minutes} 分`;
  }

  async function updateCallUsageStats() {
    if (!window.callUsage) return;
    try {
      const data = await window.callUsage.get(7);
      const today = new Date();
      const weekdays = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
      const current = data[data.length - 1] ?? { totalMs: 0, desktopMs: 0, discordMs: 0, active: false };

      const todayVal = document.getElementById("call-usage-today-val");
      const sourceDetail = document.getElementById("call-usage-source-detail");
      if (todayVal) todayVal.textContent = formatCallDuration(current.totalMs, true);
      if (sourceDetail) {
        sourceDetail.textContent = `今日 · 桌面 ${formatCallDuration(current.desktopMs, true)} · Discord ${formatCallDuration(current.discordMs, true)}`;
      }
      const liveIndicator = document.getElementById("call-live-indicator");
      if (liveIndicator) liveIndicator.hidden = !current.active;

      const weekStart = new Date(today);
      weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(today.getDate() - today.getDay());
      const week = weekdays.map((weekday, index) => {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + index);
        const key = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const entry = date.getTime() > today.getTime() ? undefined : data.find((item) => item.date === key);
        return { weekday, totalMs: entry?.totalMs ?? 0 };
      });
      const elapsed = week.slice(0, today.getDay() + 1);
      const weekTotal = elapsed.reduce((sum, item) => sum + item.totalMs, 0);
      const peak = elapsed.reduce((best, item) => item.totalMs > best.totalMs ? item : best, { weekday: "週日", totalMs: 0 });
      const average = weekTotal / Math.max(1, elapsed.length);

      const avgEl = document.getElementById("call-avg-val");
      const peakEl = document.getElementById("call-chart-peak-desc");
      if (avgEl) avgEl.textContent = `日均 ${formatCallDuration(average, true)}`;
      if (peakEl) {
        peakEl.textContent = peak.totalMs > 0
          ? `🎙️ 本週累計 ${formatCallDuration(weekTotal, true)} · 最長 ${formatCallDuration(peak.totalMs, true)} (${peak.weekday})`
          : "🎙️ 本週尚無通話紀錄";
      }

      document.querySelectorAll(".call-chart-bar-item").forEach((item) => {
        const dayIndex = Number((item as HTMLElement).dataset.day);
        const fill = item.querySelector(".call-chart-bar-fill") as HTMLElement | null;
        if (!fill) return;
        const duration = week[dayIndex]?.totalMs ?? 0;
        fill.style.height = peak.totalMs > 0 ? `${Math.max(duration > 0 ? 5 : 0, Math.min(100, duration / peak.totalMs * 100))}%` : "0%";
      });
    } catch (err) {
      console.warn("Failed to load call usage stats:", err);
    }
  }

  void updateCallUsageStats();
  window.setInterval(() => void updateCallUsageStats(), 60_000);

  async function updateScheduleVisibility() {
    const summary = document.getElementById("schedule-summary");
    const divider = document.querySelector(".schedule-divider") as HTMLElement | null;
    const tasksSection = document.querySelector(".tasks-section") as HTMLElement | null;
    const countEl = document.getElementById("schedule-todo-count");
    const nextTaskLabel = document.getElementById("next-task-label");
    if (!window.cyreneScheduler) return;

    try {
      const result = await window.cyreneScheduler.list();
      const enabledTasks = result.ok && Array.isArray(result.value)
        ? result.value.filter((task) => task.enabled)
        : [];
      const hasSchedule = enabledTasks.length > 0;
      if (summary) summary.hidden = !hasSchedule;
      if (divider) divider.hidden = !hasSchedule;
      if (tasksSection) tasksSection.hidden = !hasSchedule;
      if (countEl) countEl.textContent = String(enabledTasks.length);
      if (nextTaskLabel && hasSchedule) {
        nextTaskLabel.textContent = enabledTasks
          .map((task) => task.title)
          .join(" · ");
      }
    } catch (err) {
      console.warn("Failed to load schedule summary:", err);
    }
  }

  void updateScheduleVisibility();
  window.tasks?.onSchedulerChanged(() => void updateScheduleVisibility());

  // 定期統計消息數與互動數
  async function updateChatStats() {
    try {
      if (window.chatStore) {
        const sessions = await window.chatStore.list();
        if (agentSessionCountEl) agentSessionCountEl.textContent = `${sessions.length} 個會話`;
        let totalMsgs = 0;
        let totalInteractions = 0; // 用戶發送次數
        
        // 遍歷所有會話統計消息
        for (const s of sessions) {
          // 如果 preload 曝露了 getMessages 則統計，否則用預估/預設值
          if (window.chatStore.getMessages) {
            const msgs = await window.chatStore.getMessages(s.id);
            totalMsgs += msgs.length;
            totalInteractions += msgs.filter(m => m.role === "user").length;
          }
        }
        
        if (statMessagesEl) statMessagesEl.textContent = String(totalMsgs);
        if (statInteractionsEl) statInteractionsEl.textContent = String(totalInteractions);
      }
    } catch (err) {
      console.warn("Failed to load chat message stats:", err);
    }
  }

  updateChatStats();
  setInterval(updateChatStats, 10000);
}

initStatusSync();

async function updateConnectionStatus() {
  if (!connectionStatusList) return;
  if (!window.connectionStatus) {
    connectionStatusList.innerHTML = '<div class="card-empty-content">需要重新啟動程式以同步狀態</div>';
    return;
  }
  try {
    const items = await window.connectionStatus.get();
    connectionStatusList.replaceChildren();
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "conn-item";

      const info = document.createElement("div");
      info.className = "conn-item__info";
      const icon = document.createElement("span");
      icon.className = "conn-item__icon";
      icon.textContent = item.icon;
      const detail = document.createElement("div");
      detail.className = "conn-item__detail";
      const name = document.createElement("span");
      name.className = "conn-item__name";
      name.textContent = item.name;
      const value = document.createElement("span");
      value.className = "conn-item__val";
      value.textContent = item.detail;
      detail.append(name, value);
      info.append(icon, detail);

      const pill = document.createElement("span");
      pill.className = `conn-status-pill conn-status-pill--${item.state === "connected" ? "active" : item.state}`;
      pill.textContent = item.label;
      row.append(info, pill);
      connectionStatusList.appendChild(row);
    }
  } catch (err) {
    console.warn("Failed to sync connection status:", err);
    connectionStatusList.innerHTML = '<div class="card-empty-content">連接狀態讀取失敗</div>';
  }
}

void updateConnectionStatus();
window.setInterval(() => void updateConnectionStatus(), 5_000);

// ── 6. 桌寵停靠與召回管理 ──
let isPetDocked = true; // 預設為停靠狀態

function reportSlotBounds() {
  if (!window.sidebar?.reportSlotBounds) return;
  
  const currentTab = document.querySelector(".sidebar__tab.is-active")?.getAttribute("data-tab");
  const usesFullWidth = currentTab === "notebook" || currentTab === "game-room";

  const activeInfoTab = document.querySelector(".info-tab.is-active")?.textContent?.trim();
  const isOverview = activeInfoTab === "概覽";

  if (usesFullWidth || !isOverview) {
    // 當前分頁不應該顯示桌寵，因此不更新其停靠位置，直接返回以讓其安全隱藏
    return;
  }

  if (!petSlot || petSlot.hidden) return;
  const rect = petSlot.getBoundingClientRect();
  window.sidebar.reportSlotBounds({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    isDocked: isPetDocked
  });
}

// 監聽視窗變動，隨時上報停靠槽的最新座標
window.addEventListener("resize", reportSlotBounds);
// 每當 iframe 頁面載入完成或工作台切換時也重新上報一次
iframe.addEventListener("load", () => {
  setTimeout(reportSlotBounds, 300);
});

// 當桌寵被手動拖走時，接收主進程的通知以更新狀態為「未停靠」
if (window.sidebar?.onPetDockChanged) {
  window.sidebar.onPetDockChanged((docked) => {
    isPetDocked = docked;
    if (petSlot) {
      if (docked) {
        petSlot.classList.add("is-docked");
      } else {
        petSlot.classList.remove("is-docked");
      }
    }
    // 更新座標
    reportSlotBounds();
  });
}

// 初始化時：預設為停靠並上報槽位座標
if (petSlot) {
  petSlot.classList.add("is-docked");
  setTimeout(reportSlotBounds, 800);
}

// 點擊停靠槽：當桌寵在外面時，點擊可以直接將其召回
petSlot?.addEventListener("click", () => {
  if (!isPetDocked) {
    isPetDocked = true;
    petSlot.classList.add("is-docked");
    reportSlotBounds();
  }
});

// ── 7. 最近對話清單渲染與同步 ──
let currentActiveSessionId = "";
const sidebarSessionsList = document.getElementById("sidebar-sessions-list");
const sidebarNewSessionBtn = document.getElementById("sidebar-new-session-btn");
const sessionContextMenu = document.getElementById("session-context-menu") as HTMLDivElement | null;
const sessionContextTitle = document.getElementById("session-context-title");
const sessionDeleteOverlay = document.getElementById("session-delete-overlay") as HTMLDivElement | null;
const sessionDeleteCopy = document.getElementById("session-delete-copy");
const sessionDeleteCancel = document.getElementById("session-delete-cancel") as HTMLButtonElement | null;
const sessionDeleteConfirm = document.getElementById("session-delete-confirm") as HTMLButtonElement | null;
let contextSession: { id: string; title: string; item: HTMLLIElement } | null = null;
let pendingDeleteSession: { id: string; title: string } | null = null;

function closeSessionContextMenu(): void {
  if (sessionContextMenu) sessionContextMenu.hidden = true;
  contextSession?.item.classList.remove("is-menu-open");
  contextSession = null;
}

function openSessionContextMenu(event: MouseEvent | KeyboardEvent, session: { id: string; title: string }, item: HTMLLIElement): void {
  if (!sessionContextMenu) return;
  closeSessionContextMenu();
  contextSession = { ...session, item };
  item.classList.add("is-menu-open");
  if (sessionContextTitle) sessionContextTitle.textContent = session.title || "新對話";
  sessionContextMenu.hidden = false;
  const rect = item.getBoundingClientRect();
  const requestedX = event instanceof MouseEvent ? event.clientX : rect.right - 12;
  const requestedY = event instanceof MouseEvent ? event.clientY : rect.top + 18;
  const menuRect = sessionContextMenu.getBoundingClientRect();
  sessionContextMenu.style.left = `${Math.max(8, Math.min(requestedX, window.innerWidth - menuRect.width - 8))}px`;
  sessionContextMenu.style.top = `${Math.max(8, Math.min(requestedY, window.innerHeight - menuRect.height - 8))}px`;
  sessionContextMenu.querySelector<HTMLButtonElement>("button")?.focus();
}

function beginInlineSessionRename(session: { id: string; title: string }, item: HTMLLIElement): void {
  const title = item.querySelector(".sidebar__session-title") as HTMLSpanElement | null;
  if (!title || item.querySelector("input")) return;
  item.classList.add("is-editing");
  const input = document.createElement("input");
  input.className = "sidebar__session-title-input";
  input.value = session.title || "新對話";
  input.maxLength = 80;
  input.setAttribute("aria-label", "新的對話標題");
  title.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (save: boolean) => {
    if (settled) return;
    settled = true;
    const nextTitle = input.value.trim();
    if (save && nextTitle && nextTitle !== session.title) {
      const renamed = await window.chatStore?.rename(session.id, nextTitle);
      if (!renamed) console.error("Failed to rename session:", session.id);
    }
    item.classList.remove("is-editing");
    await renderSidebarSessionsList();
  };
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); void finish(true); }
    if (event.key === "Escape") { event.preventDefault(); void finish(false); }
  });
  input.addEventListener("blur", () => void finish(true));
}

function openDeleteSessionDialog(session: { id: string; title: string }): void {
  if (!sessionDeleteOverlay) return;
  pendingDeleteSession = session;
  if (sessionDeleteCopy) sessionDeleteCopy.textContent = `「${session.title || "新對話"}」會從這台電腦永久刪除，此動作無法復原。`;
  sessionDeleteOverlay.hidden = false;
  sessionDeleteCancel?.focus();
}

function closeDeleteSessionDialog(): void {
  if (sessionDeleteOverlay) sessionDeleteOverlay.hidden = true;
  pendingDeleteSession = null;
}

function formatSessionTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return "剛剛";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}分鐘前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}小時前`;
  return new Date(timestamp).toLocaleDateString("zh-TW", { month: "short", day: "numeric" });
}

async function renderSidebarSessionsList() {
  if (!sidebarSessionsList || !window.chatStore) return;
  try {
    const list = await window.chatStore.list();
    sidebarSessionsList.innerHTML = "";
    
    list.forEach((session) => {
      const li = document.createElement("li");
      li.className = "sidebar__session-item";
      if (session.id === currentActiveSessionId) {
        li.classList.add("is-active");
      }
      li.dataset.sessionId = session.id;
      li.tabIndex = 0;
      li.setAttribute("aria-haspopup", "menu");
      li.setAttribute("aria-label", `${session.title || "新對話"}，右鍵可管理`);
      
      const title = document.createElement("span");
      title.className = "sidebar__session-title";
      title.textContent = session.title || "新對話";
      
      const time = document.createElement("span");
      time.className = "sidebar__session-time";
      time.textContent = formatSessionTime(session.updatedAt);
      
      li.appendChild(title);
      li.appendChild(time);
      
      const openSession = () => {
        iframe.contentWindow?.postMessage({ type: "switch-session", sessionId: session.id }, "*");
        // 切換 workspace 分頁至「閒聊」
        const chatTab = document.querySelector('.sidebar__tab[data-tab="chat"]') as HTMLElement | null;
        if (chatTab && !chatTab.classList.contains("is-active")) {
          chatTab.click();
        }
      };
      li.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("input")) return;
        openSession();
      });
      li.addEventListener("contextmenu", (event) => {
        if ((event.target as HTMLElement).closest("input")) return;
        event.preventDefault();
        openSessionContextMenu(event, { id: session.id, title: session.title || "新對話" }, li);
      });
      li.addEventListener("keydown", (event) => {
        if (event.key === "Enter") openSession();
        if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
          event.preventDefault();
          openSessionContextMenu(event, { id: session.id, title: session.title || "新對話" }, li);
        }
      });
      
      sidebarSessionsList.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to render sidebar sessions:", err);
  }
}

sessionContextMenu?.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-session-action]");
  if (!button || !contextSession) return;
  const session = contextSession;
  closeSessionContextMenu();
  if (button.dataset.sessionAction === "rename") beginInlineSessionRename(session, session.item);
  if (button.dataset.sessionAction === "delete") openDeleteSessionDialog(session);
});

sessionDeleteCancel?.addEventListener("click", closeDeleteSessionDialog);
sessionDeleteOverlay?.addEventListener("click", (event) => {
  if (event.target === sessionDeleteOverlay) closeDeleteSessionDialog();
});
sessionDeleteConfirm?.addEventListener("click", async () => {
  const session = pendingDeleteSession;
  if (!session || !window.chatStore) return;
  sessionDeleteConfirm.disabled = true;
  try {
    const deleted = await window.chatStore.delete(session.id);
    if (!deleted) throw new Error("對話不存在或無法刪除");
    closeDeleteSessionDialog();
    await renderSidebarSessionsList();
  } catch (error) {
    if (sessionDeleteCopy) sessionDeleteCopy.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sessionDeleteConfirm.disabled = false;
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!sessionContextMenu?.hidden && !sessionContextMenu.contains(event.target as Node)) closeSessionContextMenu();
});
window.addEventListener("blur", closeSessionContextMenu);
window.addEventListener("resize", closeSessionContextMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!sessionContextMenu?.hidden) closeSessionContextMenu();
    else if (!sessionDeleteOverlay?.hidden) closeDeleteSessionDialog();
  }
  if (!sessionContextMenu?.hidden && contextSession) {
    if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      const session = contextSession;
      closeSessionContextMenu();
      beginInlineSessionRename(session, session.item);
    }
    if (event.metaKey && event.key === "Backspace") {
      event.preventDefault();
      const session = contextSession;
      closeSessionContextMenu();
      openDeleteSessionDialog(session);
    }
  }
});

function updateActiveSessionHighlight() {
  const items = document.querySelectorAll(".sidebar__session-item");
  items.forEach((item) => {
    const id = (item as HTMLElement).dataset.sessionId;
    if (id === currentActiveSessionId) {
      item.classList.add("is-active");
    } else {
      item.classList.remove("is-active");
    }
  });
}

// 監聽 iframe 傳回的會話切換事件，以及文字觸發的模式切換事件
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "active-session-changed") {
    currentActiveSessionId = e.data.sessionId || "";
    updateActiveSessionHighlight();
  }
  if (e.data && e.data.type === "mode-updated-by-text") {
    const value = e.data.value;
    const wsMode = value === "collab" ? "chat" : value;
    activeMode = wsMode;
    const modeItems = document.querySelectorAll(".ws-dropdown__item");
    modeItems.forEach((item) => {
      const o = item as HTMLElement;
      if (o.dataset.value === wsMode) {
        modeItems.forEach((i) => i.classList.remove("is-active"));
        o.classList.add("is-active");
        if (modeValEl) {
          modeValEl.textContent = o.textContent?.trim() || "";
        }
        updateTitlebarModeText("chat");
      }
    });
  }
});

// 新建會話按鈕事件
sidebarNewSessionBtn?.addEventListener("click", () => {
  iframe.contentWindow?.postMessage({ type: "create-session" }, "*");
  const chatTab = document.querySelector('.sidebar__tab[data-tab="chat"]') as HTMLElement | null;
  if (chatTab && !chatTab.classList.contains("is-active")) {
    chatTab.click();
  }
});

// 監聽會話資料庫變更事件，隨時重新渲染列表
if (window.chatStore?.onChanged) {
  window.chatStore.onChanged(() => {
    renderSidebarSessionsList();
  });
}

// 首次加載
setTimeout(() => {
  renderSidebarSessionsList();
}, 1000);
