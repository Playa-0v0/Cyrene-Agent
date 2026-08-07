/**
 * 昔漣手機版 · app.js
 * 純 Vanilla JS，無框架依賴，直接在手機瀏覽器運行。
 *
 * 架構：
 *   - ConnectPage：管理連線設置頁（IP / token 輸入）
 *   - ChatPage：管理聊天頁（WS 連接、消息渲染）
 *   - SessionsDrawer：會話側滑抽屜
 *   - App：頂層協調器
 */

// ══════════════════════════════════════════════════
// 工具函數
// ══════════════════════════════════════════════════

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatTime(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatRelativeDate(updatedAt) {
  const diff = Date.now() - updatedAt;
  if (diff < 60000) return '剛剛';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小時前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// ══════════════════════════════════════════════════
// 持久化配置（localStorage）
// ══════════════════════════════════════════════════

const Config = {
  KEY: 'cyrene.mobile.config.v1',
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  save(data) {
    localStorage.setItem(this.KEY, JSON.stringify(data));
  },
  clear() {
    localStorage.removeItem(this.KEY);
  },
};

// ══════════════════════════════════════════════════
// WebSocket 連線管理
// ══════════════════════════════════════════════════

class CyreneConnection {
  constructor({ host, port, token, onEvent, onConnect, onDisconnect }) {
    this.baseUrl = `ws://${host}:${port}`;
    this.apiBase = `http://${host}:${port}`;
    this.token = token;
    this.onEvent = onEvent;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.ws = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._closed = false;
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const url = `${this.baseUrl}/mobile/chat?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this._reconnectAttempts = 0;
      console.log('[WS] 已連接');
    };

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data);
        if (event.type === 'CONN_ACK') {
          this.onConnect?.();
          return;
        }
        if (event.type === 'ERROR') {
          console.warn('[WS] 服務端錯誤:', event.message);
          return;
        }
        this.onEvent?.(event);
      } catch (err) {
        console.warn('[WS] 解析失敗:', err);
      }
    };

    ws.onerror = (e) => {
      console.warn('[WS] 錯誤:', e);
    };

    ws.onclose = (ev) => {
      this.onDisconnect?.(ev.code);
      if (!this._closed) {
        const delay = Math.min(1000 * Math.pow(1.5, this._reconnectAttempts++), 15000);
        console.log(`[WS] 斷開，${delay}ms 後重連 (code=${ev.code})`);
        this._reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  close() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this.ws?.close();
  }

  /** HTTP API */
  async fetchSessions() {
    const res = await fetch(`${this.apiBase}/api/sessions`, {
      headers: { 'X-Mobile-Token': this.token },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async createSession() {
    const res = await fetch(`${this.apiBase}/api/sessions`, {
      method: 'POST',
      headers: { 'X-Mobile-Token': this.token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async getSession(id) {
    const res = await fetch(`${this.apiBase}/api/sessions/${encodeURIComponent(id)}`, {
      headers: { 'X-Mobile-Token': this.token },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async saveMessages(sessionId, messages) {
    const persistable = messages.filter(m => m.role === 'user' || (m.role === 'model' && m.content && !m.thinking));
    await fetch(`${this.apiBase}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'X-Mobile-Token': this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: persistable }),
    }).catch(() => { /* 保存失敗不影響使用 */ });
  }

  /** 健康檢查：驗證 token + 服務是否在線 */
  async healthCheck() {
    const res = await fetch(`${this.apiBase}/mobile/healthz`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  }
}

// ══════════════════════════════════════════════════
// 連線設置頁
// ══════════════════════════════════════════════════

class ConnectPage {
  constructor({ onConnect }) {
    this.el = document.getElementById('page-connect');
    this.ipInput = document.getElementById('input-ip');
    this.tokenInput = document.getElementById('input-token');
    this.connectBtn = document.getElementById('btn-connect');
    this.errorEl = document.getElementById('connect-error');
    this.savedEl = document.getElementById('connect-saved');
    this.onConnect = onConnect;

    this.connectBtn.addEventListener('click', () => this._submit());
    this.ipInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.tokenInput.focus(); });
    this.tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submit(); });

    // 自動填入上次配置
    const saved = Config.load();
    if (saved) {
      this.ipInput.value = saved.host + (saved.port !== 45678 ? `:${saved.port}` : '');
      this.tokenInput.value = saved.token;
      this.savedEl.innerHTML = '上次已連接的設備 &nbsp;<a id="clear-saved">清除</a>';
      document.getElementById('clear-saved')?.addEventListener('click', () => {
        Config.clear();
        this.ipInput.value = '';
        this.tokenInput.value = '';
        this.savedEl.textContent = '';
      });
    }
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }

  setError(msg) { this.errorEl.textContent = msg; }
  clearError() { this.errorEl.textContent = ''; }

  async _submit() {
    this.clearError();
    const raw = this.ipInput.value.trim();
    const token = this.tokenInput.value.trim().replace(/\s/g, '');

    if (!raw) { this.setError('請輸入電腦的 IP 地址'); this.ipInput.focus(); return; }
    if (!token) { this.setError('請輸入連接 Token'); this.tokenInput.focus(); return; }

    let host = raw, port = 45678;
    const colonIdx = raw.lastIndexOf(':');
    if (colonIdx > 0) {
      const maybePort = parseInt(raw.slice(colonIdx + 1), 10);
      if (!isNaN(maybePort)) {
        host = raw.slice(0, colonIdx);
        port = maybePort;
      }
    }

    this.connectBtn.disabled = true;
    this.connectBtn.textContent = '連接中…';

    try {
      const conn = new CyreneConnection({ host, port, token, onEvent: () => {}, onConnect: () => {}, onDisconnect: () => {} });
      await conn.healthCheck();
      conn.close();

      Config.save({ host, port, token });
      this.onConnect({ host, port, token });
    } catch (err) {
      this.setError(`連接失敗：請確認 IP 和 Token 是否正確（${err.message}）`);
    } finally {
      this.connectBtn.disabled = false;
      this.connectBtn.textContent = '連接昔漣';
    }
  }
}

// ══════════════════════════════════════════════════
// 會話側滑抽屜
// ══════════════════════════════════════════════════

class SessionsDrawer {
  constructor({ onSelectSession, onNewSession }) {
    this.overlay = document.getElementById('drawer-overlay');
    this.drawer = document.getElementById('sessions-drawer');
    this.listEl = document.getElementById('drawer-session-list');
    this.emptyEl = document.getElementById('drawer-empty');
    this.newBtn = document.getElementById('drawer-new-btn');
    this.onSelectSession = onSelectSession;
    this.onNewSession = onNewSession;
    this.currentSessionId = null;
    this.sessions = [];

    this.overlay.addEventListener('click', () => this.close());
    this.newBtn.addEventListener('click', () => {
      this.close();
      this.onNewSession?.();
    });
  }

  open() {
    this.overlay.classList.add('open');
    this.drawer.classList.add('open');
  }

  close() {
    this.overlay.classList.remove('open');
    this.drawer.classList.remove('open');
  }

  async refresh(conn) {
    try {
      this.sessions = await conn.fetchSessions();
    } catch { this.sessions = []; }
    this._render();
  }

  _render() {
    if (this.sessions.length === 0) {
      this.listEl.innerHTML = '';
      this.emptyEl.style.display = 'block';
      return;
    }
    this.emptyEl.style.display = 'none';
    this.listEl.innerHTML = '';

    for (const s of this.sessions) {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === this.currentSessionId ? ' active' : '');
      item.innerHTML = `
        <div class="session-item__title">${escHtml(s.title || '新對話')}</div>
        <div class="session-item__meta">${formatRelativeDate(s.updatedAt)} · ${s.messageCount} 條</div>
      `;
      item.addEventListener('click', () => {
        this.close();
        this.onSelectSession?.(s.id);
      });
      this.listEl.appendChild(item);
    }
  }

  setActiveSession(id) {
    this.currentSessionId = id;
    this._render();
  }
}

// ══════════════════════════════════════════════════
// 聊天頁
// ══════════════════════════════════════════════════

class ChatPage {
  constructor({ conn, drawer, onDisconnect }) {
    this.el = document.getElementById('page-chat');
    this.messagesEl = document.getElementById('chat-messages');
    this.emptyEl = document.getElementById('chat-empty');
    this.inputEl = document.getElementById('composer-input');
    this.sendBtn = document.getElementById('composer-send');
    this.cancelBtn = document.getElementById('composer-cancel');
    this.statusEl = document.getElementById('chat-status');
    this.menuBtn = document.getElementById('chat-menu-btn');
    this.newBtn = document.getElementById('chat-new-btn');

    this.conn = conn;
    this.drawer = drawer;
    this.onDisconnect = onDisconnect;

    this.messages = [];
    this.currentSessionId = null;
    this.isRunning = false;
    this._streamMsgId = null;
    this._streamContent = '';
    this._streamToolBuffer = ''; // 工具調用緩衝

    this._bindEvents();
    this._initWs();
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }

  _bindEvents() {
    this.inputEl.addEventListener('input', () => autoGrow(this.inputEl));
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
      }
    });
    this.sendBtn.addEventListener('click', () => this._sendMessage());
    this.cancelBtn.addEventListener('click', () => this._cancel());
    this.menuBtn.addEventListener('click', () => {
      this.drawer.refresh(this.conn);
      this.drawer.open();
    });
    this.newBtn.addEventListener('click', () => this._newSession());
  }

  _initWs() {
    this.conn.onEvent = (event) => this._handleEvent(event);
    this.conn.onConnect = () => {
      this.statusEl.textContent = '已連接';
      this.statusEl.className = 'chat__status';
      document.getElementById('connection-banner').classList.remove('show');
    };
    this.conn.onDisconnect = (code) => {
      this.statusEl.textContent = '重新連接中…';
      this.statusEl.className = 'chat__status offline';
      if (code === 4001) {
        // token 無效
        this.onDisconnect?.();
        return;
      }
      document.getElementById('connection-banner').classList.add('show');
    };
    this.conn.connect();
  }

  async init() {
    try {
      const sessions = await this.conn.fetchSessions();
      if (sessions.length > 0) {
        await this.loadSession(sessions[0].id);
      } else {
        await this._newSession();
      }
    } catch (err) {
      console.warn('[ChatPage] init 失敗:', err);
      showToast('無法讀取會話記錄', true);
    }
  }

  async loadSession(id) {
    try {
      const session = await this.conn.getSession(id);
      this.currentSessionId = session.id;
      this.messages = (session.messages || []).map(m => ({ ...m }));
      this.drawer.setActiveSession(id);
      this._render();
    } catch (err) {
      console.warn('[ChatPage] loadSession 失敗:', err);
      showToast('載入會話失敗', true);
    }
  }

  async _newSession() {
    try {
      const session = await this.conn.createSession();
      this.currentSessionId = session.id;
      this.messages = [];
      this.drawer.setActiveSession(session.id);
      this._render();
    } catch (err) {
      console.warn('[ChatPage] _newSession 失敗:', err);
      showToast('建立新會話失敗', true);
    }
  }

  _sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text || this.isRunning) return;

    // 添加用戶消息
    const userMsg = { id: `u-${Date.now()}`, role: 'user', content: text, at: Date.now() };
    this.messages.push(userMsg);

    // 添加模型佔位消息（打字動畫）
    const modelMsgId = `m-${Date.now()}`;
    this._streamMsgId = modelMsgId;
    this._streamContent = '';
    this.messages.push({ id: modelMsgId, role: 'model', content: '', at: Date.now(), thinking: true });

    this._render();
    this.inputEl.value = '';
    this.inputEl.style.height = '';

    // 發送 AG-UI run
    const payload = {
      type: 'run',
      sessionId: this.currentSessionId,
      messages: this.messages
        .filter(m => !m.thinking && (m.role === 'user' || m.role === 'model') && m.content)
        .slice(0, -1) // 去掉剛加的 thinking 佔位
        .concat([userMsg])
        .map(m => ({ role: m.role, content: m.content })),
      style: '01_default.md',
    };

    const sent = this.conn.send(payload);
    if (!sent) {
      showToast('連接中斷，請稍後重試', true);
      this.messages.pop(); // 移除 thinking 佔位
      this._render();
      return;
    }

    this.isRunning = true;
    this._setRunningUI(true);
  }

  _cancel() {
    this.conn.send({ type: 'cancel' });
    // 移除 thinking 佔位
    const thinkingIdx = this.messages.findIndex(m => m.thinking);
    if (thinkingIdx >= 0) this.messages.splice(thinkingIdx, 1);
    this._finishRun();
  }

  _finishRun() {
    this.isRunning = false;
    this._streamMsgId = null;
    this._streamContent = '';
    this._setRunningUI(false);
    // 保存到後端
    if (this.currentSessionId) {
      this.conn.saveMessages(this.currentSessionId, this.messages);
    }
  }

  _setRunningUI(running) {
    this.sendBtn.style.display = running ? 'none' : 'flex';
    this.cancelBtn.classList.toggle('visible', running);
    this.inputEl.disabled = running;
  }

  _handleEvent(event) {
    const type = event.type;

    if (type === 'TEXT_MESSAGE_START') {
      // 確保有 thinking 佔位
      if (this._streamMsgId && !this.messages.find(m => m.id === this._streamMsgId)) {
        this.messages.push({ id: this._streamMsgId, role: 'model', content: '', at: Date.now(), thinking: true });
      }
    }

    if (type === 'TEXT_MESSAGE_CONTENT' && event.delta) {
      const msg = this.messages.find(m => m.id === this._streamMsgId);
      if (msg) {
        msg.thinking = false;
        msg.content = (msg.content || '') + event.delta;
        this._updateStreamBubble(msg);
      }
    }

    if (type === 'TOOL_CALL_START') {
      this._streamToolBuffer = event.toolCallName || '工具';
      this._updateToolCallBubble(this._streamToolBuffer, '執行中…');
    }

    if (type === 'TOOL_CALL_ARGS_DELTA') {
      // 忽略 args 細節，只顯示工具名
    }

    if (type === 'TOOL_CALL_END') {
      this._updateToolCallBubble(this._streamToolBuffer, '✓ 完成');
    }

    if (type === 'CYRENE_STICKER' && event.sticker) {
      // 在最後一條 model 消息下附加貼紙
      const last = [...this.messages].reverse().find(m => m.role === 'model' && !m.thinking);
      if (last) {
        last.sticker = event.sticker;
        this._render();
      }
    }

    // AG-UI CUSTOM 事件（cyrene.sticker）
    if (type === 'CUSTOM' && event.name === 'cyrene.sticker' && event.value) {
      const last = [...this.messages].reverse().find(m => m.role === 'model' && !m.thinking);
      if (last) {
        last.sticker = String(event.value);
        this._render();
      }
    }

    if (type === 'RUN_FINISHED') {
      const msg = this.messages.find(m => m.id === this._streamMsgId);
      if (msg) { msg.thinking = false; }
      this._render();
      this._finishRun();
    }

    if (type === 'RUN_ERROR') {
      const msg = this.messages.find(m => m.id === this._streamMsgId);
      if (msg) {
        msg.thinking = false;
        if (!msg.content) msg.content = `⚠️ 出錯了：${event.error || '未知錯誤'}`;
      }
      this._render();
      this._finishRun();
      showToast(event.error || '請求失敗', true);
    }
  }

  /** 流式更新泡泡，避免全量重渲染 */
  _updateStreamBubble(msg) {
    const bubbleEl = this.messagesEl.querySelector(`[data-msg-id="${msg.id}"] .msg__bubble`);
    if (bubbleEl) {
      bubbleEl.textContent = msg.content;
      this._scrollToBottom();
    } else {
      this._render();
    }
  }

  /** 工具調用提示（在最後一條 model 消息的 thinking 中追加） */
  _updateToolCallBubble(toolName, status) {
    const thinkingEl = this.messagesEl.querySelector(`[data-msg-id="${this._streamMsgId}"] .msg__thinking`);
    if (thinkingEl) {
      thinkingEl.innerHTML = `<span class="msg__tool">⚙️ ${escHtml(toolName)} ${escHtml(status)}</span>`;
    }
  }

  _render() {
    const hasMessages = this.messages.some(m => !m.thinking || m.content);
    this.emptyEl.style.display = hasMessages ? 'none' : 'flex';
    this.messagesEl.innerHTML = '';

    for (const msg of this.messages) {
      const el = this._buildMsgEl(msg);
      this.messagesEl.appendChild(el);
    }

    this._scrollToBottom();
  }

  _buildMsgEl(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = `msg msg--${msg.role}`;
    wrapper.dataset.msgId = msg.id;

    // 頭像
    const avatar = document.createElement('div');
    avatar.className = 'msg__avatar';
    avatar.textContent = msg.role === 'model' ? '🌸' : '👤';

    // Body
    const body = document.createElement('div');
    body.className = 'msg__body';

    // 泡泡
    const bubble = document.createElement('div');
    bubble.className = 'msg__bubble';

    if (msg.thinking && !msg.content) {
      // 打字動畫
      bubble.innerHTML = `<div class="msg__thinking"><span></span><span></span><span></span></div>`;
    } else {
      bubble.textContent = msg.content;
    }
    body.appendChild(bubble);

    // 貼紙
    if (msg.sticker) {
      const stickerEl = document.createElement('img');
      stickerEl.className = 'msg__sticker';
      stickerEl.src = `/stickers/${msg.sticker}.png`;
      stickerEl.alt = msg.sticker;
      stickerEl.onerror = () => { stickerEl.style.display = 'none'; };
      body.appendChild(stickerEl);
    }

    // 時間
    if (msg.at && !msg.thinking) {
      const timeEl = document.createElement('div');
      timeEl.className = 'msg__time';
      timeEl.textContent = formatTime(msg.at);
      body.appendChild(timeEl);
    }

    if (msg.role === 'model') {
      wrapper.appendChild(avatar);
      wrapper.appendChild(body);
    } else {
      wrapper.appendChild(body);
      wrapper.appendChild(avatar);
    }

    return wrapper;
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }
}

// ══════════════════════════════════════════════════
// App 頂層協調器
// ══════════════════════════════════════════════════

class App {
  constructor() {
    this.connectPage = null;
    this.chatPage = null;
    this.sessionsDrawer = null;
    this.conn = null;
  }

  init() {
    this.connectPage = new ConnectPage({
      onConnect: ({ host, port, token }) => this._enterChat({ host, port, token }),
    });

    this.sessionsDrawer = new SessionsDrawer({
      onSelectSession: (id) => this.chatPage?.loadSession(id),
      onNewSession: () => this.chatPage?._newSession(),
    });

    // 判斷是否有已保存的設定
    const saved = Config.load();
    if (saved) {
      this._tryAutoConnect(saved);
    } else {
      this.connectPage.show();
    }
  }

  async _tryAutoConnect(config) {
    const conn = new CyreneConnection({ ...config, onEvent: () => {}, onConnect: () => {}, onDisconnect: () => {} });
    try {
      await conn.healthCheck();
      conn.close();
      this._enterChat(config);
    } catch {
      conn.close();
      this.connectPage.show();
    }
  }

  async _enterChat({ host, port, token }) {
    this.connectPage.hide();

    this.conn = new CyreneConnection({
      host, port, token,
      onEvent: () => {},    // 由 ChatPage 接管
      onConnect: () => {},  // 由 ChatPage 接管
      onDisconnect: () => {},
    });

    this.chatPage = new ChatPage({
      conn: this.conn,
      drawer: this.sessionsDrawer,
      onDisconnect: () => {
        // token 失效，回到連線頁
        this.conn?.close();
        this.chatPage?.hide();
        showToast('Token 失效，請重新連接', true);
        Config.clear();
        setTimeout(() => {
          this.connectPage.ipInput.value = '';
          this.connectPage.tokenInput.value = '';
          this.connectPage.show();
        }, 800);
      },
    });

    this.chatPage.show();
    await this.chatPage.init();
  }
}

// ══════════════════════════════════════════════════
// 啟動
// ══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
