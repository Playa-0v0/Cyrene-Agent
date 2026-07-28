import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MusicMcpClient } from "./music-mcp-client";
import { ProtocolDetector } from "./protocol-detector";
import { CookieVault } from "./cookie-vault";
import { LoginOrchestrator } from "./login-orchestrator";
import { SelectionSetCache } from "./selection-set-cache";
import { MusicInputError } from "./types";
import { MusicRouter } from "./music-router";
import { NeteaseMusicProvider, NETEASE_PROVIDER_ID } from "./netease-music-provider";
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
  CandidatePlaybackRequest,
} from "./types";

	import type { MusicStatusSnapshot } from "../../shared/music-view-state";
	
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
  private readonly vault: CookieVault;
  private readonly orchestrator: LoginOrchestrator;
  private readonly cache: SelectionSetCache;
  private readonly paths: MusicPaths;
  private readonly router: MusicRouter;

  private backendListeners = new Set<StateListener<MusicBackendState>>();
  private accountListeners = new Set<StateListener<MusicAccountState>>();
  private playerListeners = new Set<StateListener<MusicPlayerState>>();
  private flowListeners = new Set<StateListener<LoginFlowState>>();
  private stateListeners = new Set<StateListener<MusicStatusSnapshot>>();

  constructor(paths: MusicPaths) {
    this.paths = paths;
    this.client = new MusicMcpClient(paths.vendorDir, paths.runtimeDir);
    this.detector = new ProtocolDetector();
    const netease = new NeteaseMusicProvider(this.client);
    this.router = new MusicRouter(new Map([[netease.id, netease]]), () => NETEASE_PROVIDER_ID);
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
    // 1. Cancel any in-flight login flow (background polling) before tearing down
    //    the MCP client, so no further cyrene_music_login_check RPCs are issued.
    try { await this.orchestrator.shutdown(); } catch { /* ignore */ }
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

  getLatestSelectionSet(
    conversationId: string,
    source?: MusicSelectionSet["source"],
  ): MusicSelectionSet | null {
    return this.cache.latest(conversationId, source);
  }

  // ── Login poll passthrough (smoke harness + future orchestrators) ──

  /** Drive one login-state check against the MCP auth server. */
  async pollOnce(): Promise<unknown> {
    const result = await this.orchestrator.pollOnce();
    this.emitStateChange();
    return result;
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

  /** Subscribe to full-snapshot changes (one unified callback for any axis). */
  onStateChange(listener: StateListener<MusicStatusSnapshot>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Build a snapshot of every state axis plus profile. */
  getSnapshot(): MusicStatusSnapshot {
    return {
      backend: this.backendState,
      account: this.getAccountState(),
      player: this.playerState,
      flow: this.getLoginFlowState(),
      profile: this.activeProfile,
    };
  }

  private emitStateChange(): void {
    const snapshot = this.getSnapshot();
    for (const l of this.stateListeners) l(snapshot);
  }

  // ── Login ──────────────────────────────────────────────────

  async beginLogin() {
    this.requireReady();
    return this.orchestrator.beginLogin();
  }

  async cancelLogin() {
    await this.orchestrator.cancelLogin();
    this.emitStateChange();
  }

  async logout(): Promise<void> {
    await this.orchestrator.cancelLogin();
    await this.vault.delete();
    await fs.rm(path.join(this.paths.runtimeDir, "cookies.json"), { force: true });
    this.activeProfile = null;
    this.orchestrator.setAccountState("signed_out");
    this.emitAccountChange("signed_out");
  }

  // ── Data ───────────────────────────────────────────────────

  async getDailyRecommendations(
    conversationId: string,
    options: { provider?: string; resolutionRunId?: string } = {},
  ): Promise<MusicSelectionSet> {
    this.requireReady();
    this.requireSignedIn();
    const provider = this.router.resolve(options.provider);
    const tracks = await provider.getDailyRecommendations();
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      provider: provider.id,
      source: "daily_recommendation",
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      resolutionRunId: options.resolutionRunId,
      resolutionPurpose: "discover",
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async searchTracks(
    keyword: string,
    conversationId: string,
    limit?: number,
    options: { provider?: string; resolutionRunId?: string; purpose?: "discover" | "play" } = {},
  ): Promise<MusicSelectionSet> {
    this.requireReady();
    const trimmed = (typeof keyword === "string" ? keyword : "").trim();
    if (trimmed.length === 0) throw new MusicInputError("E_INVALID_KEYWORD_EMPTY");
    if (trimmed.length > 100) throw new MusicInputError("E_INVALID_KEYWORD_TOO_LONG");
    const clampedLimit = Math.max(1, Math.min(limit ?? 20, 20));
    const provider = this.router.resolve(options.provider);
    const tracks = (await provider.searchTracks(trimmed)).slice(0, clampedLimit);
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      provider: provider.id,
      source: "search",
      query: trimmed,
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      resolutionRunId: options.resolutionRunId,
      resolutionPurpose: options.purpose ?? "discover",
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
    const cardRef = `cyrene:music:${setId}:${trackIds.join(":")}`;
    return { cardRef };
  }

  markTracksPresented(setId: string, conversationId: string, trackIds: string[]): void {
    const set = this.cache.get(setId, conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    const available = new Set(set.tracks.map((track) => track.id));
    if (trackIds.length === 0 || trackIds.some((trackId) => !available.has(trackId))) {
      throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    this.cache.markPresented(setId, conversationId, trackIds);
  }

  // ── Playback ───────────────────────────────────────────────

  async playTrack(input: CandidatePlaybackRequest): Promise<PlaybackDispatchResult> {
    const trackId = input.trackId;
    if (!/^\d+$/.test(trackId)) throw new MusicInputError("E_INVALID_ID_FORMAT");
    const set = this.cache.get(input.setId, input.conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    if (set.provider !== input.provider) throw new MusicInputError("E_PROVIDER_MISMATCH");
    if (!set.tracks.some((track) => track.id === trackId)) {
      throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    const wasPresented = set.presentedTrackIds?.includes(trackId) === true;
    const resolvedForThisRun = set.resolutionPurpose === "play"
      && Boolean(input.runId)
      && set.resolutionRunId === input.runId;
    if (!wasPresented && !resolvedForThisRun) {
      throw new MusicInputError("E_TRACK_NOT_PLAYABLE");
    }
    return this.router.resolve(input.provider).playTrack(trackId);
  }

  /** Trusted renderer path: card/settings IDs originate from MusicService results. */
  async playTrackFromUi(trackId: string): Promise<PlaybackDispatchResult> {
    if (!/^\d+$/.test(trackId)) throw new MusicInputError("E_INVALID_ID_FORMAT");
    return this.router.resolve().playTrack(trackId);
  }

  async playPlaylist(playlistId: string): Promise<PlaybackDispatchResult> {
    if (!/^\d+$/.test(playlistId)) throw new MusicInputError("E_INVALID_ID_FORMAT");
    return this.router.resolve().playPlaylist(playlistId);
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
      return await this.client.callAuthTool(
        "cyrene_music_validate_session",
        {},
      ) as { state: string; profile?: MusicProfile };
    } catch {
      return { state: "temporarily_unavailable" };
    }
  }

  private emitBackendChange(s: MusicBackendState): void {
    for (const l of this.backendListeners) l(s);
    this.emitStateChange();
  }
  private emitAccountChange(s: MusicAccountState): void {
    for (const l of this.accountListeners) l(s);
    this.emitStateChange();
  }
  private emitPlayerChange(s: MusicPlayerState): void {
    for (const l of this.playerListeners) l(s);
    this.emitStateChange();
  }
  private emitFlowChange(s: LoginFlowState): void {
    for (const l of this.flowListeners) l(s);
    this.emitStateChange();
  }
}
