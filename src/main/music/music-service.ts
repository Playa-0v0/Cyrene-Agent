import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MusicMcpClient } from "./music-mcp-client";
import { ProtocolDetector } from "./protocol-detector";
import { PlaybackDispatcher } from "./playback-dispatcher";
import { CookieVault } from "./cookie-vault";
import { LoginOrchestrator } from "./login-orchestrator";
import { SelectionSetCache } from "./selection-set-cache";
import { normalizeDailyRecommendations, normalizeSearchResults } from "./result-normalizer";
import { MusicInputError } from "./types";
import type { MusicPaths } from "./paths";
import type {
  MusicSelectionSet,
  PlaybackDispatchResult,
  MusicBackendState,
  MusicAccountState,
  MusicPlayerState,
  LoginFlowState,
  MusicProfile,
  MusicShutdownReport,
} from "./types";

const SET_TTL_MS = 30 * 60_000;

export interface PresentResult {
  cardRef: string;
}

type StateListener<T> = (state: T) => void;

export class MusicService {
  private backendState: MusicBackendState = "stopped";
  private playerState: MusicPlayerState = "unknown";
  private activeProfile: MusicProfile | null = null;
  private shuttingDown = false;

  private readonly client: MusicMcpClient;
  private readonly detector: ProtocolDetector;
  private readonly dispatcher: PlaybackDispatcher;
  private readonly vault: CookieVault;
  private readonly orchestrator: LoginOrchestrator;
  private readonly cache: SelectionSetCache;
  private readonly paths: MusicPaths;

  private backendListeners = new Set<StateListener<MusicBackendState>>();
  private accountListeners = new Set<StateListener<MusicAccountState>>();
  private playerListeners = new Set<StateListener<MusicPlayerState>>();
  private flowListeners = new Set<StateListener<LoginFlowState>>();

  constructor(paths: MusicPaths) {
    this.paths = paths;
    this.client = new MusicMcpClient(paths.vendorDir, paths.runtimeDir);
    this.detector = new ProtocolDetector();
    this.dispatcher = new PlaybackDispatcher(this.detector);
    this.vault = new CookieVault(path.dirname(paths.accountPath));
    this.orchestrator = new LoginOrchestrator({
      client: this.client,
      runtimeDir: paths.runtimeDir,
      vault: this.vault,
    });
    this.cache = new SelectionSetCache();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    this.backendState = "starting";
    try {
      await this.client.connect();
      const contract = await this.client.verifyContractOnConnect();
      if (!contract.ok) {
        this.backendState = "incompatible";
        return;
      }

      const protocolOk = await this.detector.isRegistered();
      this.playerState = protocolOk ? "available" : "unavailable";

      // Restore saved account session into runtime cookies
      try {
        const blob = await this.vault.load();
        if (blob) {
          const payload = await this.vault.decrypt(blob);
          const cookiesPath = path.join(this.paths.runtimeDir, "cookies.json");
          await fs.mkdir(this.paths.runtimeDir, { recursive: true });
          await fs.writeFile(cookiesPath, JSON.stringify(payload.cookies), "utf8");
          this.orchestrator.setAccountState("validating");
          this.emitAccountChange("validating");
          // Three-state validation per spec §8.3
          const r = await this.validateSessionThreeState();
          switch (r.state) {
            case "valid":
              this.orchestrator.setAccountState("signed_in");
              this.activeProfile = r.profile ?? null;
              this.emitAccountChange("signed_in");
              break;
            case "invalid_credentials":
              await fs.rm(this.paths.accountPath, { force: true }).catch(() => {});
              this.activeProfile = null;
              this.orchestrator.setAccountState("signed_out");
              this.emitAccountChange("signed_out");
              break;
            case "temporarily_unavailable":
              this.orchestrator.setAccountState("temporarily_unavailable");
              this.emitAccountChange("temporarily_unavailable");
              break;
          }
        } else {
          this.orchestrator.setAccountState("signed_out");
          this.emitAccountChange("signed_out");
        }
      } catch {
        this.orchestrator.setAccountState("signed_out");
        this.emitAccountChange("signed_out");
      }

      this.backendState = "ready";
      this.emitBackendChange("ready");
    } catch (err) {
      this.backendState = "failed";
      this.emitBackendChange("failed");
      throw err;
    }
  }

  async shutdown(): Promise<MusicShutdownReport> {
    if (this.shuttingDown) {
      return {
        rootProcessPid: undefined,
        transportClosed: true,
        processTreeExited: true,
        runtimeRemoved: true,
      };
    }
    this.shuttingDown = true;
    const rootProcessPid = this.client.getRootPid();
    let transportClosed = true;
    try {
      await this.client.close();
    } catch {
      transportClosed = false;
    }
    let processTreeExited = true;
    if (rootProcessPid !== undefined) {
      try {
        process.kill(rootProcessPid, 0);
        processTreeExited = false;
      } catch {
        processTreeExited = true;
      }
    }
    let runtimeRemoved = true;
    try {
      await fs.rm(this.paths.runtimeDir, { recursive: true, force: true });
    } catch {
      runtimeRemoved = false;
    }
    this.backendState = "stopped";
    this.emitBackendChange("stopped");
    return { rootProcessPid, transportClosed, processTreeExited, runtimeRemoved };
  }

  // ── State accessors ────────────────────────────────────────

  getBackendState(): MusicBackendState { return this.backendState; }
  getAccountState(): MusicAccountState { return this.orchestrator.getAccountState(); }
  getPlayerState(): MusicPlayerState { return this.playerState; }
  getLoginFlowState(): LoginFlowState { return this.orchestrator.getFlowState(); }
  getActiveProfile(): MusicProfile | null { return this.activeProfile; }

  getSelectionSet(setId: string, conversationId: string): MusicSelectionSet | null {
    return this.cache.get(setId, conversationId);
  }

  // ── Event listeners ────────────────────────────────────────

  onBackendStateChange(listener: StateListener<MusicBackendState>): () => void {
    this.backendListeners.add(listener);
    return () => this.backendListeners.delete(listener);
  }
  onAccountStateChange(listener: StateListener<MusicAccountState>): () => void {
    this.accountListeners.add(listener);
    return () => this.accountListeners.delete(listener);
  }
  onPlayerStateChange(listener: StateListener<MusicPlayerState>): () => void {
    this.playerListeners.add(listener);
    return () => this.playerListeners.delete(listener);
  }
  onLoginFlowStateChange(listener: StateListener<LoginFlowState>): () => void {
    this.flowListeners.add(listener);
    return () => this.flowListeners.delete(listener);
  }

  // ── Login ──────────────────────────────────────────────────

  async beginLogin() {
    this.requireReady();
    return this.orchestrator.beginLogin();
  }

  async cancelLogin() {
    return this.orchestrator.cancelLogin();
  }

  // ── Data ───────────────────────────────────────────────────

  async getDailyRecommendations(conversationId: string): Promise<MusicSelectionSet> {
    this.requireReady();
    this.requireSignedIn();
    const raw = await this.client.callDataTool("cloud_music_get_daily_recommend", {});
    const tracks = normalizeDailyRecommendations(this.unwrapContent(raw));
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      source: "daily_recommendation",
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async searchTracks(keyword: string, conversationId: string, limit?: number): Promise<MusicSelectionSet> {
    this.requireReady();
    const trimmed = (typeof keyword === "string" ? keyword : "").trim();
    if (trimmed.length === 0) throw new MusicInputError("E_INVALID_KEYWORD_EMPTY");
    if (trimmed.length > 100) throw new MusicInputError("E_INVALID_KEYWORD_TOO_LONG");
    const clampedLimit = Math.max(1, Math.min(limit ?? 20, 20));
    const raw = await this.client.callDataTool("cloud_music_search", { keyword: trimmed, limit: clampedLimit });
    const tracks = normalizeSearchResults(this.unwrapContent(raw));
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      source: "search",
      query: trimmed,
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async presentTracks(params: {
    setId: string;
    conversationId: string;
    trackIds: string[];
    reasons?: string[];
  }): Promise<PresentResult> {
    const { setId, conversationId, trackIds, reasons } = params;
    const set = this.cache.get(setId, conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    if (trackIds.length === 0 || trackIds.length > 5) throw new MusicInputError("E_TOO_MANY_SELECTED");
    if (reasons) {
      if (reasons.length !== trackIds.length) throw new MusicInputError("E_REASONS_MISMATCH");
      for (const r of reasons) {
        if (r.length > 50) throw new MusicInputError("E_REASON_TOO_LONG");
      }
      if (reasons.join("").length > 500) throw new MusicInputError("E_REASONS_TOTAL_TOO_LONG");
    }
    const setTrackIds = new Set(set.tracks.map((t) => t.id));
    for (const tid of trackIds) {
      if (!setTrackIds.has(tid)) throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    this.cache.touch(setId);
    const cardRef = `cyrene:music:${setId}:${trackIds.join(":")}`;
    return { cardRef };
  }

  // ── Playback ───────────────────────────────────────────────

  async playTrack(trackId: string): Promise<PlaybackDispatchResult> {
    if (!/^\d+$/.test(trackId)) throw new MusicInputError("E_INVALID_ID");
    return this.dispatcher.dispatch("song", trackId);
  }

  async playPlaylist(playlistId: string): Promise<PlaybackDispatchResult> {
    if (!/^\d+$/.test(playlistId)) throw new MusicInputError("E_INVALID_ID");
    return this.dispatcher.dispatch("playlist", playlistId);
  }

  // ── Helpers ────────────────────────────────────────────────

  private requireReady(): void {
    if (this.backendState !== "ready" && this.backendState !== "degraded") {
      throw new MusicInputError("E_BACKEND_NOT_READY");
    }
  }

  private requireSignedIn(): void {
    if (this.orchestrator.getAccountState() !== "signed_in") {
      throw new MusicInputError("E_ACCOUNT_REQUIRED");
    }
  }

  private async validateSessionThreeState(): Promise<{ state: string; profile?: MusicProfile }> {
    try {
      const raw = await this.client.callAuthTool("cyrene_music_login_check", { session_id: "validation-only" });
      const r = raw as { status?: string; profile?: MusicProfile };
      if (r.status === "authorized") return { state: "valid", profile: r.profile };
      return { state: "invalid_credentials" };
    } catch {
      return { state: "temporarily_unavailable" };
    }
  }

  private unwrapContent(result: unknown): unknown {
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r.content)) {
        const first = (r.content as Array<Record<string, unknown>>)[0];
        if (first && first.type === "text" && typeof first.text === "string") {
          try { return JSON.parse(first.text); } catch { return result; }
        }
      }
    }
    return result;
  }

  private emitBackendChange(s: MusicBackendState): void {
    for (const l of this.backendListeners) l(s);
  }
  private emitAccountChange(s: MusicAccountState): void {
    for (const l of this.accountListeners) l(s);
  }
  private emitPlayerChange(s: MusicPlayerState): void {
    for (const l of this.playerListeners) l(s);
  }
  private emitFlowChange(s: LoginFlowState): void {
    for (const l of this.flowListeners) l(s);
  }
}