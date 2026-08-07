import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { DiscordMusicTrack } from "./music-source";

export interface PersistedDiscordMusicSession {
  current: DiscordMusicTrack & { queueOrder: number };
  queue: Array<DiscordMusicTrack & { queueOrder: number }>;
  history: Array<DiscordMusicTrack & { queueOrder: number }>;
  ownerId: string | null;
  volume: number;
  repeat: "off" | "track" | "queue";
  shuffle: boolean;
  autoplay: boolean;
  elapsed: number;
  savedAt: string;
}

interface ResumeData {
  version: 1;
  session?: PersistedDiscordMusicSession;
  controller?: { channelId: string; messageId: string };
}

let writeQueue: Promise<void> = Promise.resolve();

export function getDiscordMusicResumePath(): string {
  try {
    return path.join(app.getPath("userData"), "discord", "music-resume.json");
  } catch {
    return path.join(process.cwd(), "music-resume.json");
  }
}

export async function loadDiscordMusicResumeData(filePath = getDiscordMusicResumePath()): Promise<ResumeData> {
  const fallback: ResumeData = { version: 1 };
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as ResumeData;
    return parsed?.version === 1 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function updateResumeData(patch: (data: ResumeData) => void, filePath: string): Promise<void> {
  const operation = writeQueue.catch(() => undefined).then(async () => {
    const data = await loadDiscordMusicResumeData(filePath);
    patch(data);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(temporary, filePath);
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
}

export async function saveDiscordMusicResumeSession(session: PersistedDiscordMusicSession, filePath = getDiscordMusicResumePath()): Promise<void> {
  await updateResumeData((data) => { data.session = session; }, filePath);
}

export async function clearDiscordMusicResumeSession(filePath = getDiscordMusicResumePath()): Promise<void> {
  await updateResumeData((data) => { delete data.session; }, filePath);
}

export async function saveDiscordMusicControllerReference(channelId: string, messageId: string, filePath = getDiscordMusicResumePath()): Promise<void> {
  await updateResumeData((data) => { data.controller = { channelId, messageId }; }, filePath);
}
