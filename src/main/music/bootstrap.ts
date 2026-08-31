import type { MusicPaths } from "./paths";
import { MusicService } from "./music-service";
import { registerMusicIpcHandlers } from "./ipc-handlers";
import { buildMusicTools } from "../orchestrator/tools/music-tools";
import { toolRegistry } from "../orchestrator/tool-registry";
import type { MusicShutdownReport } from "./types";

export interface MusicBootstrap {
  service: MusicService;
  isShuttingDown(): boolean;
  shutdown(): Promise<MusicShutdownReport>;
}

export function bootstrapMusicService(paths: MusicPaths): MusicBootstrap {
  const service = new MusicService(paths);
  const ipcDisposer = registerMusicIpcHandlers(service);
  const tools = buildMusicTools(service);
  for (const tool of tools) toolRegistry.register(tool);
  // Do not start the music backend here.  It is connected lazily by the first
  // real music action (ensureReady) so an idle Cyrene window never holds a
  // network session merely because the extension is installed.

  let shuttingDown = false;
  return {
    service,
    isShuttingDown: () => shuttingDown,
    shutdown: async () => {
      if (shuttingDown) {
        return {
          rootProcessPid: undefined,
          transportClosed: true,
          processTreeExited: true,
          runtimeRemoved: true,
        };
      }
      shuttingDown = true;
      const report = await service.shutdown();
      ipcDisposer();
      for (const t of tools) toolRegistry.unregister(t.id);
      return report;
    },
  };
}
