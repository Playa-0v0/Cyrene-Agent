import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { MusicInputError, type MusicBackendState, type MusicAccountState, type MusicPlayerState } from "./types";
import type { MusicService } from "./music-service";
import { sanitizeLogLine } from "./log-sanitizer";

export type MusicIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: string; backendState?: MusicBackendState;
      accountState?: MusicAccountState; playerState?: MusicPlayerState };

function wrap<T>(
  fn: () => Promise<T>,
  service: MusicService,
): Promise<MusicIpcResult<T>> {
  return fn().then(
    (data) => ({ ok: true as const, data }),
    (err: unknown) => {
      if (err instanceof MusicInputError) {
        return {
          ok: false as const,
          errorCode: err.code,
          backendState: service.getBackendState(),
          accountState: service.getAccountState(),
          playerState: service.getPlayerState(),
        };
      }
      console.error("[music] IPC handler failed", sanitizeLogLine(String(err)));
      return { ok: false as const, errorCode: "E_INTERNAL_ERROR" };
    },
  );
}

export function registerMusicIpcHandlers(service: MusicService): () => void {
  const channels: string[] = [];

  ipcMain.handle(IPC.MUSIC_GET_STATUS, () =>
    wrap(async () => {
      const flow = service.getLoginFlowState();
      if (flow === "creating_qr" || flow === "waiting_scan" || flow === "waiting_confirm") {
        await service.pollOnce();
      }
      return {
        backend: service.getBackendState(),
        account: service.getAccountState(),
        player: service.getPlayerState(),
        flow: service.getLoginFlowState(),
      };
    }, service),
  );
  channels.push(IPC.MUSIC_GET_STATUS);

  ipcMain.handle(IPC.MUSIC_BEGIN_LOGIN, () => wrap(() => service.beginLogin(), service));
  channels.push(IPC.MUSIC_BEGIN_LOGIN);

  ipcMain.handle(IPC.MUSIC_CANCEL_LOGIN, () => wrap(() => service.cancelLogin(), service));
  channels.push(IPC.MUSIC_CANCEL_LOGIN);

  ipcMain.handle(IPC.MUSIC_LOGOUT, () => wrap(() => service.logout(), service));
  channels.push(IPC.MUSIC_LOGOUT);

  ipcMain.handle(IPC.MUSIC_GET_DAILY, () =>
    wrap(() => service.getDailyRecommendations("default"), service),
  );
  channels.push(IPC.MUSIC_GET_DAILY);

  ipcMain.handle(IPC.MUSIC_SEARCH, (_e, payload: { keyword: string; limit?: number }) =>
    wrap(() => service.searchTracks(payload.keyword, "default", payload.limit), service),
  );
  channels.push(IPC.MUSIC_SEARCH);

  ipcMain.handle(IPC.MUSIC_PRESENT_TRACKS, (_e, args) =>
    wrap(() => service.presentTracks(args as Parameters<typeof service.presentTracks>[0]), service),
  );
  channels.push(IPC.MUSIC_PRESENT_TRACKS);

  ipcMain.handle(IPC.MUSIC_PLAY_TRACK, (_e, trackId: string) =>
    wrap(() => service.playTrackFromUi(trackId), service),
  );
  channels.push(IPC.MUSIC_PLAY_TRACK);

  ipcMain.handle(IPC.MUSIC_PLAY_PLAYLIST, (_e, playlistId: string) =>
    wrap(() => service.playPlaylist(playlistId), service),
  );
  channels.push(IPC.MUSIC_PLAY_PLAYLIST);

  ipcMain.handle(IPC.MUSIC_DETECT_PLAYER, () =>
    wrap(async () => service.getPlayerState(), service),
  );
  channels.push(IPC.MUSIC_DETECT_PLAYER);

  // ── 状态变更推送：任何 state 轴变化都广播到所有窗口 ──────────
  const unsubState = service.onStateChange((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.MUSIC_STATE_CHANGED, snapshot);
    }
  });

  return function dispose() {
    for (const ch of channels) ipcMain.removeHandler(ch);
    unsubState();
  };
}
