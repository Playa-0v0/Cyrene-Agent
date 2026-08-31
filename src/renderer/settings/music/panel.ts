// Music 面板业务逻辑：网易云登录 / 二维码 / 搜索 / 状态渲染
// 从 settings.ts 抽离。依赖 music DOM 引用（./dom）、musicState（./state）、
// music/types 类型、shared/music-view-state、music-playback（requestTrackPlayback）。

import type {
  MusicApi,
  MusicIpcResult,
  MusicSelectionResult,
} from "./types";
import { musicState } from "./state";
import {
  musicFeedbackEl, musicAccountStatusText,
  musicSearchForm, musicSearchHint,
  musicQrBox, musicQrStatus, musicQrImg, musicQrTip,
  musicLoginBtn, musicCancelBtn, musicDisconnectBtn,
  musicSearchBtn, musicSearchInput, musicSearchResults,
  musicAppIdInput, musicPrivateKeyInput, musicSaveConfigBtn,
  musicOpenPlayerBtn,
} from "./dom";
import {
  deriveNeteaseViewState,
  type MusicStatusSnapshot,
  type NeteaseViewState,
} from "../../../shared/music-view-state";
import { requestTrackPlayback } from "../music-playback";

export function getMusicApi(): MusicApi | null {
  const w = window as unknown as { music?: MusicApi };
  return w.music ?? null;
}

function setMusicFeedback(kind: "info" | "ok" | "err", msg: string): void {
  if (!musicFeedbackEl) return;
  musicFeedbackEl.textContent = msg;
  musicFeedbackEl.className = "music-feedback";
  if (kind === "ok") musicFeedbackEl.classList.add("music-feedback--ok");
  else if (kind === "err") musicFeedbackEl.classList.add("music-feedback--err");
  else musicFeedbackEl.classList.add("music-feedback--info");
}

export function renderMusicStatus(snapshot: MusicStatusSnapshot): void {
  const state = deriveNeteaseViewState(snapshot);
  const labels: Record<NeteaseViewState, string> = {
    backend_starting: "正在读取音乐服务状态…", backend_error: "音乐服务暂不可用", signed_out: "尚未连接",
    creating_qr: "正在等待扫码", waiting_scan: "正在等待扫码", waiting_confirm: "已扫码，请在手机确认",
    login_expired: "二维码已过期", login_failed: "登录失败", connected: "网易云音乐已连接", connected_without_client: "已登录，但 mpv 播放器未就绪",
  };
  if (musicAccountStatusText) musicAccountStatusText.textContent = labels[state];
  const musicStatusDot = document.getElementById("music-status-dot");
  if (musicStatusDot) musicStatusDot.classList.toggle("is-connected", state === "connected" || state === "connected_without_client");
  const actionHost = document.getElementById("music-actions");
  if (actionHost) {
    actionHost.innerHTML = "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = state === "signed_out" || state === "backend_error" ? "btn-primary" : "btn-secondary";
    const actions: Partial<Record<NeteaseViewState, string>> = { signed_out: "连接网易云", creating_qr: "取消登录", waiting_scan: "取消登录", waiting_confirm: "取消登录", login_expired: "重新生成二维码", login_failed: "重新登录", connected: "断开连接", connected_without_client: "断开连接", backend_error: "重新启动音乐服务" };
    if (actions[state]) { button.textContent = actions[state]!; button.addEventListener("click", () => void handleMusicAction(state)); actionHost.appendChild(button); }
  }
  const loggedIn = state === "connected" || state === "connected_without_client";
  musicSearchForm?.classList.toggle("is-hidden", !loggedIn);
  if (musicSearchHint) musicSearchHint.textContent = loggedIn ? "搜索网易云曲库。" : "连接网易云后即可搜索歌曲和获取每日推荐。";
  musicQrBox?.classList.toggle("is-hidden", !(state === "creating_qr" || state === "waiting_scan" || state === "waiting_confirm" || state === "login_expired"));
  if (musicQrStatus) musicQrStatus.textContent = state === "connected" || state === "connected_without_client" ? "当前状态：网易云音乐已连接" : state === "waiting_confirm" ? "当前状态：等待手机确认" : state === "login_expired" ? "当前状态：二维码过期" : "当前状态：等待扫码";
}

async function handleMusicAction(state: NeteaseViewState): Promise<void> {
  const api = getMusicApi(); if (!api) { setMusicFeedback("err", "音乐 API 未就绪"); return; }
  if (state === "signed_out" || state === "login_expired" || state === "login_failed") return void startMusicLogin();
  if (state === "connected" || state === "connected_without_client") {
    setMusicFeedback("info", "正在断开连接…");
    try {
      const r = await api.logout();
    if (r.ok) setMusicFeedback("ok", "已断开连接");
    else setMusicFeedback("err", "断开失败：" + r.errorCode);
    } catch (err) {
      setMusicFeedback("err", "断开异常：" + (err instanceof Error ? err.message : String(err)));
    }
    return;
  }
  if (state === "creating_qr" || state === "waiting_scan" || state === "waiting_confirm") { await api.cancelLogin?.(); clearMusicQr(); }
}

export function updateMusicActionsForAccount(account: string): void {
  // Login-in-progress 状态：暂时还没有 IPC 通道告诉我们 creating_qr / waiting_scan / waiting_confirm，
  // 所以这里只能根据"是否显示了二维码 + account 状态"来推断。
  // 显示规则：
  //   - account === "signed_in"      → 显示 断开连接
  //   - account === "temporarily_unavailable" → 显示 连接网易云（让用户重试）
  //   - 二维码显示中 → 显示 取消登录
  //   - 其他 → 显示 连接网易云
  const qrVisible = !!musicQrBox && !musicQrBox.classList.contains("is-hidden");
  if (musicLoginBtn) musicLoginBtn.classList.toggle("is-hidden", qrVisible || account === "signed_in");
  if (musicCancelBtn) musicCancelBtn.classList.toggle("is-hidden", !qrVisible);
  if (musicDisconnectBtn) musicDisconnectBtn.classList.toggle("is-hidden", account !== "signed_in");
}

function clearMusicQr(): void {
  if (musicQrImg) { musicQrImg.style.display = "none"; musicQrImg.src = ""; }
  if (musicQrBox) musicQrBox.classList.add("is-hidden");
  if (musicQrTip) musicQrTip.textContent = "请用网易云音乐 App 扫描二维码完成登录";
  musicState.lastQrDataUrl = null;
}

function showMusicQr(dataUrl: string, tip: string): void {
  if (musicQrImg) { musicQrImg.src = dataUrl; musicQrImg.style.display = "block"; }
  if (musicQrTip) musicQrTip.textContent = tip;
  if (musicQrBox) musicQrBox.classList.remove("is-hidden");
  musicState.lastQrDataUrl = dataUrl;
}

export function stopMusicLoginPolling(): void {
  if (musicState.loginPollTimer != null) {
    window.clearInterval(musicState.loginPollTimer);
    musicState.loginPollTimer = null;
  }
}

function stopInitPolling(): void {
  if (musicState.initPollTimer != null) {
    window.clearInterval(musicState.initPollTimer);
    musicState.initPollTimer = null;
  }
}

function startMusicLoginPolling(pollIntervalMs = 2000): void {
  stopMusicLoginPolling();
  const api = getMusicApi();
  if (!api) return;
  musicState.loginPollTimer = window.setInterval(async () => {
    try {
      const r = await api.getStatus();
      if (r.ok) {
        renderMusicStatus(r.data);
        if (r.data.account === "signed_in") {
          // 登录成功 → 关闭 QR 面板、停止轮询
          clearMusicQr();
          stopMusicLoginPolling();
          setMusicFeedback("ok", "已连接到网易云音乐");
        } else if (r.data.flow === "expired" || r.data.flow === "failed" || r.data.flow === "cancelled") {
          stopMusicLoginPolling();
          if (r.data.flow !== "expired") clearMusicQr();
          setMusicFeedback("err", r.data.flow === "expired" ? "二维码已过期，请重新生成" : "登录未完成，请重试");
        } else if (
          // 登录流程进行中（waiting_scan 等）时，account 的 expired /
          // temporarily_unavailable 描述的是上一轮会话的旧 token，不是本次
          // 扫码的结果——此时清二维码会让"300 秒有效期的码只显示几秒"。
          // 只有流程不在进行中（idle 等）才把账户状态当成失败依据。
          (r.data.account === "temporarily_unavailable" || r.data.account === "expired") &&
          r.data.flow !== "creating_qr" && r.data.flow !== "waiting_scan" && r.data.flow !== "waiting_confirm"
        ) {
          stopMusicLoginPolling();
          clearMusicQr();
          setMusicFeedback("err", "登录失败：账户状态 " + r.data.account);
        }
      }
    } catch (err) {
      console.warn("[music] login poll failed", err);
    }
  }, Math.max(1000, pollIntervalMs));
}

async function startMusicLogin(): Promise<void> {
  const api = getMusicApi();
  if (!api) {
    setMusicFeedback("err", "window.music 未就绪，请确认 music plugin 已注册");
    return;
  }
  setMusicFeedback("info", "正在生成二维码…");
  try {
    const r = await api.beginLogin();
    if (!r.ok) {
      setMusicFeedback("err", "启动登录失败：" + r.errorCode);
      // 把错误状态同步渲染出来
      const snapshot: MusicStatusSnapshot = {
        backend: r.backendState ?? "unknown",
        account: r.accountState ?? "unknown",
        player: r.playerState ?? "unknown",
      };
      renderMusicStatus(snapshot);
      return;
    }
    // 无 qrContent：上一次会话其实已完成手机授权（主进程吃掉了 803），
    // 不需要画二维码，直接轮询等 signed_in。
    if (!r.data.qrContent) {
      setMusicFeedback("info", "正在确认登录状态…");
      startMusicLoginPolling(r.data.pollIntervalMs);
      return;
    }
    // 用 qrcode 包把 qrContent 渲染成 PNG dataURL
    let dataUrl = "";
    try {
      // qrcode 包没有官方 d.ts；用 require 形式确保 esbuild 能解析
      // （renderer 走 Vite，import 形式也 OK；下面用动态 import 兼容两种打包器）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qrcodeMod: any = await import(/* @vite-ignore */ "qrcode");
      dataUrl = await qrcodeMod.toDataURL(r.data.qrContent, { width: 240, margin: 1 });
    } catch (qrErr) {
      console.error("[music] QR 渲染失败", qrErr);
      setMusicFeedback("err", "二维码渲染失败");
      return;
    }
    showMusicQr(dataUrl, "请用网易云音乐 App 扫描二维码完成登录");
    setMusicFeedback("info", "等待扫码…");
    updateMusicActionsForAccount("signed_out"); // 切到"取消登录"显示
    startMusicLoginPolling(r.data.pollIntervalMs);
  } catch (err) {
    console.error("[music] beginLogin threw", err);
    setMusicFeedback("err", "启动登录异常：" + (err instanceof Error ? err.message : String(err)));
  }
}

async function cancelMusicLogin(): Promise<void> {
  const api = getMusicApi();
  if (!api) return;
  stopMusicLoginPolling();
  clearMusicQr();
  setMusicFeedback("info", "已取消登录");
  try {
    await api.cancelLogin();
  } catch (err) {
    console.warn("[music] cancelLogin threw", err);
  }
  // 重新拉一次 status 让 UI 回到初始态
  try {
    const r = await api.getStatus();
    if (r.ok) renderMusicStatus(r.data);
  } catch (err) {
    console.warn("[music] getStatus after cancel failed", err);
  }
}

async function disconnectMusic(): Promise<void> {
  // 暂时没有正式的 disconnect API；先用 cancelLogin 作为近似（它会清掉 loginSession），
  // 并把 UI 切回"未连接"。后续会接 music.disconnect。
  setMusicFeedback("info", "正在断开…");
  await cancelMusicLogin();
  setMusicFeedback("ok", "已断开（当前仅清空登录会话，详见说明）");
}

function renderMusicSearchResults(r: MusicIpcResult<MusicSelectionResult>, kw: string): void {
  if (!musicSearchResults) return;
  musicSearchResults.innerHTML = "";
  if (!r.ok) {
    const div = document.createElement("div");
    div.className = "music-feedback music-feedback--err";
    div.textContent = "搜索失败：" + r.errorCode;
    musicSearchResults.appendChild(div);
    return;
  }
  const tracks = r.data.tracks ?? [];
  if (tracks.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-hint";
    // 安全转义
    const safeKw = kw.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    p.textContent = `暂无结果，关键词 '${safeKw}' 未匹配到歌曲`;
    musicSearchResults.appendChild(p);
    return;
  }
  for (const t of tracks) {
    const row = document.createElement("div");
    row.className = "music-search-row";

    const main = document.createElement("div");
    main.className = "music-search-row__main";
    const name = document.createElement("div");
    name.className = "music-search-row__name";
    name.textContent = t.name;
    const meta = document.createElement("div");
    meta.className = "music-search-row__meta";
    const artistStr = (t.artists ?? []).join(" / ");
    meta.textContent = [artistStr, t.album].filter(Boolean).join(" · ");
    main.appendChild(name);
    main.appendChild(meta);

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "btn-secondary music-search-row__play";
    playBtn.textContent = "▶ 播放";
    playBtn.addEventListener("click", async () => {
      const api = getMusicApi();
      if (!api) {
        setMusicFeedback("err", "window.music 未就绪");
        return;
      }
      playBtn.disabled = true;
      try {
        const feedback = await requestTrackPlayback(api, t);
        setMusicFeedback(feedback.kind, feedback.message);
      } catch (err) {
        setMusicFeedback("err", "播放请求异常：" + (err instanceof Error ? err.message : String(err)));
      } finally {
        playBtn.disabled = false;
      }
    });

    row.appendChild(main);
    row.appendChild(playBtn);
    musicSearchResults.appendChild(row);
  }
}

async function runMusicSearch(): Promise<void> {
  const api = getMusicApi();
  if (!api) {
    setMusicFeedback("err", "window.music 未就绪");
    return;
  }
  const kw = (musicSearchInput?.value ?? "").trim();
  if (!kw) {
    setMusicFeedback("info", "请输入搜索关键词");
    return;
  }
  if (musicSearchResults) musicSearchResults.innerHTML = '<p class="empty-hint">搜索中…</p>';
  try {
    const r = await api.search(kw, 20);
    renderMusicSearchResults(r, kw);
  } catch (err) {
    console.error("[music] search threw", err);
    if (musicSearchResults) musicSearchResults.innerHTML = "";
    setMusicFeedback("err", "搜索异常：" + (err instanceof Error ? err.message : String(err)));
  }
}

export async function loadMusicPanel(): Promise<void> {
  if (musicState.panelInitialized) return;
  musicState.panelInitialized = true;

  // 平台按钮（网易云 → 切到 music panel）的点击处理在文件下方模块初始化时已绑定，
  // 这里不再重复 attach，避免多次进入面板造成重复监听。

  musicLoginBtn?.addEventListener("click", () => void startMusicLogin());
  musicCancelBtn?.addEventListener("click", () => void cancelMusicLogin());
  musicDisconnectBtn?.addEventListener("click", () => void disconnectMusic());

  // 搜索
  musicSearchBtn?.addEventListener("click", () => void runMusicSearch());
  musicSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runMusicSearch();
  });

  // 订阅状态推送（忽略 backend_starting，搜索探测已处理初始状态）
  const api = getMusicApi();
  if (api && typeof api.onStateChanged === "function") {
    const unsub = api.onStateChanged((s) => {
      const state = deriveNeteaseViewState(s);
      if (state === "backend_starting") return; // 不覆盖搜索探测结果
      renderMusicStatus(s);
    });
    if (typeof unsub === "function") musicState.stateUnsub = unsub;
  }

  // 用搜索探测登录态：搜索成功 = token 有效 = 已登录；失败 = 需要扫码。
  if (api) {
    try {
      const r = await api.search("a", 1);
      if (r.ok) {
        setMusicFeedback("ok", "已连接到网易云音乐");
        if (musicAccountStatusText) musicAccountStatusText.textContent = "网易云音乐已连接";
        const dot = document.getElementById("music-status-dot");
        if (dot) dot.classList.add("is-connected");
      } else {
        setMusicFeedback("info", "尚未登录，请扫码");
        if (musicAccountStatusText) musicAccountStatusText.textContent = "尚未连接";
      }
    } catch (err) {
      console.warn("[music] 探测失败", err);
      setMusicFeedback("info", "尚未登录，请扫码");
    }
  } else {
    setMusicFeedback("err", "window.music 未就绪");
  }

  // OpenAPI 配置表单（appId + privateKey）
  void loadOpenapiConfigForm();
  musicSaveConfigBtn?.addEventListener("click", () => void saveOpenapiConfig());

  // 打开独立播放器窗口
  musicOpenPlayerBtn?.addEventListener("click", async () => {
    const api = getMusicApi();
    if (!api?.openPlayer) {
      setMusicFeedback("err", "音乐 API 未就绪");
      return;
    }
    try {
      await api.openPlayer();
      setMusicFeedback("ok", "播放器窗口已打开");
    } catch (err) {
      setMusicFeedback("err", "打开播放器失败：" + (err instanceof Error ? err.message : String(err)));
    }
  });
}

// ── OpenAPI 配置表单 ───────────────────────────────────────
async function loadOpenapiConfigForm(): Promise<void> {
  const api = getMusicApi();
  if (!api?.getOpenapiConfig) return;
  try {
    const r = await api.getOpenapiConfig();
    if (!r.ok) {
      setMusicFeedback("err", "读取配置失败：" + r.errorCode);
      return;
    }
    if (r.data && musicAppIdInput) {
      // privateKey 被后端 mask 成空串，只回填 appId；privateKey 留空让用户
      // 决定是否覆盖（保存时若 privateKey 为空则保留旧值，见下方）。
      musicAppIdInput.value = r.data.appId;
    }
  } catch (err) {
    console.warn("[music] loadOpenapiConfig failed", err);
  }
}

async function saveOpenapiConfig(): Promise<void> {
  const api = getMusicApi();
  if (!api?.saveOpenapiConfig) {
    setMusicFeedback("err", "window.music 未就绪");
    return;
  }
  const appId = musicAppIdInput?.value.trim() ?? "";
  const privateKey = musicPrivateKeyInput?.value.trim() ?? "";
  if (!appId) {
    setMusicFeedback("err", "请填写 appId");
    return;
  }
  // privateKey 为空 → 视为保留旧值（仅在已有配置时允许）
  if (!privateKey) {
    setMusicFeedback("err", "请填写 privateKey（首次配置必填）");
    return;
  }
  setMusicFeedback("info", "正在保存配置…");
  try {
    const r = await api.saveOpenapiConfig({ appId, privateKey });
    if (r.ok) {
      setMusicFeedback("ok", "OpenAPI 配置已保存，后端状态：" + r.data.backend);
      // 清空 privateKey 输入框（安全）
      if (musicPrivateKeyInput) musicPrivateKeyInput.value = "";
    } else {
      setMusicFeedback("err", "保存失败：" + r.errorCode);
    }
  } catch (err) {
    setMusicFeedback("err", "保存异常：" + (err as Error).message);
  }
}

export function disposeMusicPanel(): void {
  // 离开面板时：停止轮询、取消订阅、清掉 QR dataURL 释放内存
  stopMusicLoginPolling();
  if (musicState.stateUnsub) {
    try { musicState.stateUnsub(); } catch { /* ignore */ }
    musicState.stateUnsub = null;
  }
  clearMusicQr();
  setMusicFeedback("info", "");
}
