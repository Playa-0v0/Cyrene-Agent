import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

export type RoomChoice = "waiting" | "host" | "join" | "solo";

export interface RoomPeer {
  clientId: string;
  joinedAt: number;
  choice: RoomChoice;
  displayName: string;
}

export interface RoomAssignment {
  host: RoomPeer | null;
  guest: RoomPeer | null;
  waiting: RoomPeer[];
}

export interface RopeboundBroadcast {
  event: "input" | "state";
  payload: Record<string, unknown>;
}

export function deriveRoomAssignment(peers: RoomPeer[]): RoomAssignment {
  const available = peers
    .filter((peer) => peer.choice !== "solo")
    .sort((left, right) => left.joinedAt - right.joinedAt || left.clientId.localeCompare(right.clientId));
  const host = available[0] ?? null;
  const guest = available.find((peer) => peer.clientId !== host?.clientId && peer.choice === "join") ?? null;
  const waiting = available.filter((peer) => peer.clientId !== host?.clientId && peer.clientId !== guest?.clientId);
  return { host, guest, waiting };
}

export function mapGuestInputToPlayerTwo(code: string): string | null {
  return ({
    KeyA: "ArrowLeft",
    KeyD: "ArrowRight",
    KeyW: "ArrowUp",
    Space: "ArrowUp",
    KeyF: "Slash",
    KeyE: "Enter",
    KeyQ: "KeyQ",
  } as Record<string, string>)[code] ?? null;
}

function flattenPresence(raw: Record<string, unknown[]>): RoomPeer[] {
  const peers: RoomPeer[] = [];
  for (const entries of Object.values(raw)) {
    for (const value of entries) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Partial<RoomPeer>;
      if (typeof candidate.clientId !== "string" || typeof candidate.joinedAt !== "number") continue;
      const choice: RoomChoice = ["waiting", "host", "join", "solo"].includes(candidate.choice ?? "")
        ? candidate.choice as RoomChoice
        : "waiting";
      peers.push({
        clientId: candidate.clientId,
        joinedAt: candidate.joinedAt,
        choice,
        displayName: typeof candidate.displayName === "string" ? candidate.displayName.slice(0, 40) : "玩家",
      });
    }
  }
  return peers;
}

export class RopeboundRealtimeRoom {
  private readonly client: SupabaseClient;
  private readonly channel: RealtimeChannel;
  private choice: RoomChoice = "waiting";
  private peers: RoomPeer[] = [];

  constructor(
    url: string,
    publishableKey: string,
    private readonly topic: string,
    private readonly identity: Omit<RoomPeer, "choice">,
    private readonly onPeers: (peers: RoomPeer[]) => void,
    private readonly onBroadcast: (message: RopeboundBroadcast) => void,
  ) {
    this.client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    this.channel = this.client.channel(topic, {
      config: {
        broadcast: { ack: true, self: false },
        presence: { key: identity.clientId },
      },
    });
  }

  async connect(): Promise<void> {
    this.channel
      .on("presence", { event: "sync" }, () => {
        this.peers = flattenPresence(this.channel.presenceState() as Record<string, unknown[]>);
        this.onPeers(this.peers);
      })
      .on("broadcast", { event: "input" }, ({ payload }) => this.onBroadcast({ event: "input", payload }))
      .on("broadcast", { event: "state" }, ({ payload }) => this.onBroadcast({ event: "state", payload }));

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("Realtime 房間連線逾時")), 10_000);
      this.channel.subscribe(async (status, error) => {
        if (status === "SUBSCRIBED") {
          window.clearTimeout(timer);
          await this.track();
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          window.clearTimeout(timer);
          reject(error ?? new Error(`Realtime 房間狀態：${status}`));
        }
      });
    });
  }

  getPeers(): RoomPeer[] { return this.peers; }

  async setChoice(choice: RoomChoice): Promise<void> {
    this.choice = choice;
    await this.track();
  }

  async send(event: RopeboundBroadcast["event"], payload: Record<string, unknown>): Promise<void> {
    const result = await this.channel.send({ type: "broadcast", event, payload });
    if (result !== "ok") throw new Error(`Realtime 傳送失敗：${result}`);
  }

  async disconnect(): Promise<void> {
    await this.client.removeChannel(this.channel);
  }

  private async track(): Promise<void> {
    await this.channel.track({ ...this.identity, choice: this.choice });
  }
}
