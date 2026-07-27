import { DiscordSDK, Events, patchUrlMappings, type Types } from "@discord/embedded-app-sdk";
import { isDiscordActivity, resolveActivityClientId } from "./activity-context";
import {
  deriveRoomAssignment,
  mapGuestInputToPlayerTwo,
  RopeboundRealtimeRoom,
  type RoomPeer,
} from "./multiplayer-room";
import "./style.css";

type LocalRole = "undecided" | "host" | "guest" | "solo";

interface RopeboundGameBridge {
  prepareMode(mode: "solo" | "duo"): void;
  getPhase(): "intro" | "playing";
  getState(): unknown;
  loadRemoteState(state: unknown): void;
  injectInput(code: string, pressed: boolean): void;
}

interface GameBridgeMessage {
  source: "ropebound-game";
  type: "input" | "ready";
  code?: string;
  pressed?: boolean;
}

const gameFrame = document.getElementById("game-frame") as HTMLIFrameElement;
const status = document.getElementById("activity-status") as HTMLParagraphElement;
const lobby = document.getElementById("room-lobby") as HTMLElement;
const connection = document.getElementById("room-connection") as HTMLElement;
const copy = document.getElementById("room-copy") as HTMLElement;
const people = document.getElementById("room-people") as HTMLElement;
const primary = document.getElementById("room-primary") as HTMLButtonElement;
const solo = document.getElementById("room-solo") as HTMLButtonElement;
const note = document.getElementById("room-note") as HTMLElement;
const chip = document.getElementById("room-chip") as HTMLElement;

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
const clientId = crypto.randomUUID();
const joinedAt = Date.now();
let room: RopeboundRealtimeRoom | null = null;
let peers: RoomPeer[] = [];
let role: LocalRole = "undecided";
let stateTimer: number | null = null;
let lastStateAt = 0;

gameFrame.src = import.meta.env.DEV
  ? "../ropebound-original/index.html"
  : "./ropebound-original/index.html";

function gameBridge(): RopeboundGameBridge | null {
  try {
    return (gameFrame.contentWindow as Window & { __ropeboundDiscordBridge?: RopeboundGameBridge })
      .__ropeboundDiscordBridge ?? null;
  } catch {
    return null;
  }
}

function setChip(text: string): void {
  chip.textContent = text;
  chip.hidden = false;
}

function hideLobby(): void { lobby.hidden = true; }

function selectCyreneCompanion(): void {
  try {
    const button = gameFrame.contentDocument?.querySelector<HTMLButtonElement>(
      'button[aria-label="同行夥伴選擇昔漣"]',
    );
    button?.click();
  } catch {
    // The embedded game remains playable if its document is not ready yet.
  }
}

function peerLabel(peer: RoomPeer, index: number): string {
  return peer.displayName === "玩家" ? `玩家 ${index + 1}` : peer.displayName;
}

function renderPeers(): void {
  const assignment = deriveRoomAssignment(peers);
  people.replaceChildren();
  peers.forEach((peer, index) => {
    const badge = document.createElement("span");
    badge.className = `room-person${peer.clientId === assignment.host?.clientId ? " host" : ""}`;
    badge.textContent = `${peer.clientId === assignment.host?.clientId ? "房主 · " : ""}${peerLabel(peer, index)}`;
    people.append(badge);
  });
  if (!assignment.guest) {
    const ai = document.createElement("span");
    ai.className = "room-person ai";
    ai.textContent = "昔漣 AI · Player 2 待命";
    people.append(ai);
  }

  const selfIsHost = assignment.host?.clientId === clientId;
  if (role === "undecided" && selfIsHost) {
    role = "host";
    void room?.setChoice("host");
  }
  if (role === "undecided") {
    primary.textContent = "跟房主一起玩";
    copy.textContent = "接住 Player 2 後，你的按鍵會送到房主的同一條繩索；也可以保留自己的單人進度。";
  } else if (role === "host") {
    primary.textContent = assignment.guest ? "和 Player 2 開始雙人" : "先和昔漣開始";
    copy.textContent = assignment.guest
      ? "Player 2 已接上繩索。開始後由你保存關卡狀態，對方負責第二名角色。"
      : "目前沒有人接 Player 2；現在開始會由昔漣 AI 陪你，其他人仍可自己玩。";
  } else if (role === "guest") {
    primary.textContent = "等待房主開始";
    primary.disabled = true;
    copy.textContent = "已接住 Player 2。房主選好關卡與角色後，你會自動進入同一場。";
  }
}

async function choosePrimary(): Promise<void> {
  if (role === "solo") {
    gameBridge()?.prepareMode("solo");
    setChip("獨立預覽 · 單人模式");
    hideLobby();
    return;
  }
  const assignment = deriveRoomAssignment(peers);
  if (role === "host") {
    const duo = Boolean(assignment.guest);
    if (!duo) selectCyreneCompanion();
    gameBridge()?.prepareMode(duo ? "duo" : "solo");
    setChip(duo ? "真人 Player 2 已連線 · 房主控制共同進度" : "昔漣 AI · Player 2");
    hideLobby();
    startHostStateLoop();
    return;
  }
  role = "guest";
  await room?.setChoice("join");
  primary.disabled = true;
  primary.textContent = "等待房主開始";
  note.textContent = "操作：A / D 移動、W 或空白鍵跳躍、F 技能、E 抓住／投擲。";
  renderPeers();
}

async function chooseSolo(): Promise<void> {
  role = "solo";
  await room?.setChoice("solo");
  gameBridge()?.prepareMode("solo");
  setChip("自己的單人旅途 · 其他人的進度不會影響你");
  hideLobby();
}

function startHostStateLoop(): void {
  if (stateTimer !== null) return;
  stateTimer = window.setInterval(() => {
    if (role !== "host" || !room) return;
    const bridge = gameBridge();
    if (!bridge || bridge.getPhase() !== "playing") return;
    const now = performance.now();
    if (now - lastStateAt < 160) return;
    lastStateAt = now;
    void room.send("state", { from: clientId, state: bridge.getState(), sentAt: Date.now() }).catch((error) => {
      console.warn("Realtime 狀態同步失敗", error);
    });
  }, 80);
}

function handleBroadcast(event: "input" | "state", payload: Record<string, unknown>): void {
  const assignment = deriveRoomAssignment(peers);
  if (event === "input" && role === "host" && payload.from === assignment.guest?.clientId) {
    const code = typeof payload.code === "string" ? mapGuestInputToPlayerTwo(payload.code) : null;
    if (code) gameBridge()?.injectInput(code, payload.pressed === true);
    return;
  }
  if (event === "state" && role === "guest" && payload.from === assignment.host?.clientId && payload.state) {
    const bridge = gameBridge();
    if (!bridge) return;
    bridge.loadRemoteState(payload.state);
    hideLobby();
    setChip("你是 Player 2 · 畫面與房主同步中");
  }
}

function handleGameInput(event: MessageEvent<GameBridgeMessage>): void {
  if (event.source !== gameFrame.contentWindow || event.data?.source !== "ropebound-game") return;
  if (event.data.type === "ready") {
    document.documentElement.dataset.gameBridge = "ready";
    return;
  }
  if (event.data.type !== "input" || typeof event.data.code !== "string") return;
  if (role !== "guest" || !room) return;
  void room.send("input", {
    from: clientId,
    code: event.data.code,
    pressed: event.data.pressed,
  }).catch((error) => console.warn("Player 2 操作同步失敗", error));
}

async function connectDiscord(): Promise<void> {
  if (!isDiscordActivity(window.location)) {
    connection.textContent = "獨立預覽模式";
    status.textContent = "獨立預覽模式";
    role = "solo";
    primary.textContent = "開始預覽";
    return;
  }

  const discordClientId = resolveActivityClientId(import.meta.env.VITE_DISCORD_CLIENT_ID);
  if (!discordClientId || !supabaseUrl || !supabaseKey) throw new Error("Discord 或 Realtime 環境設定不完整");

  if (!import.meta.env.DEV) {
    patchUrlMappings([{ prefix: "/supabase", target: new URL(supabaseUrl).host }]);
  }
  const discord = new DiscordSDK(discordClientId, { disableConsoleLogOverride: true });
  await discord.ready();

  const updateDiscordParticipants = (participants: Types.User[]): void => {
    document.documentElement.dataset.discordParticipants = String(participants.length);
    status.textContent = `Discord Activity 已連線，共 ${participants.length} 人`;
    connection.textContent = `同一場 Activity · ${participants.length} 人在線`;
  };
  const initial = await discord.commands.getInstanceConnectedParticipants();
  updateDiscordParticipants(initial.participants);
  await discord.subscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, (event) => {
    updateDiscordParticipants(event.participants);
  });

  const topic = `ropebound:${discord.instanceId}`;
  room = new RopeboundRealtimeRoom(
    supabaseUrl,
    supabaseKey,
    topic,
    { clientId, joinedAt, displayName: "玩家" },
    (nextPeers) => { peers = nextPeers; renderPeers(); },
    ({ event, payload }) => handleBroadcast(event, payload),
  );
  await room.connect();
  connection.textContent = `房間已連線 · ${initial.participants.length} 人在線`;
  renderPeers();
}

primary.addEventListener("click", () => void choosePrimary());
solo.addEventListener("click", () => void chooseSolo());
window.addEventListener("message", handleGameInput);
window.addEventListener("beforeunload", () => {
  if (stateTimer !== null) window.clearInterval(stateTimer);
  void room?.disconnect();
});

void connectDiscord().catch((error) => {
  connection.textContent = "多人房間連線失敗";
  copy.textContent = "仍可選擇自己玩；重新開啟 Activity 後會再次連線。";
  primary.hidden = true;
  status.textContent = "Discord Activity 多人連線失敗";
  console.error("Discord Activity 初始化失敗", error);
});
