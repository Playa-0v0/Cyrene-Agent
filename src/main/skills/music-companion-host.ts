interface CapabilityState {
  skillEnabled: boolean;
  backendAvailable: boolean;
  enabledTools: string[];
}

export interface MusicCompanionRuntimeLike {
  shouldInject(capabilities: CapabilityState): boolean;
}

let runtime: MusicCompanionRuntimeLike | null = null;
let capabilityProbe: (() => CapabilityState) | null = null;

export function configureMusicCompanionHost(
  nextRuntime: MusicCompanionRuntimeLike,
  nextCapabilityProbe: () => CapabilityState,
): void {
  runtime = nextRuntime;
  capabilityProbe = nextCapabilityProbe;
}

export function loadMusicCompanionHost(
  compiledEntryPath: string,
  nextCapabilityProbe: () => CapabilityState,
): void {
  // The compound Skill is compiled separately so its source remains inside
  // skills/cyrene-music-companion rather than being copied into MusicService.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require(compiledEntryPath) as { createMusicCompanionRuntime?: () => MusicCompanionRuntimeLike };
  if (typeof module.createMusicCompanionRuntime !== "function") {
    throw new Error("E_MUSIC_COMPANION_ENTRY_INVALID");
  }
  configureMusicCompanionHost(module.createMusicCompanionRuntime(), nextCapabilityProbe);
}

export function clearMusicCompanionHost(): void {
  runtime = null;
  capabilityProbe = null;
}

export function isMusicCompanionAvailable(): boolean {
  if (!runtime || !capabilityProbe) return false;
  return runtime.shouldInject(capabilityProbe());
}
