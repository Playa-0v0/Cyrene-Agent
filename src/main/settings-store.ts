import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface UserProfile {
  nickname: string;
  callPreference: string;
  birthday: string;
  timezone: string;
  avatarPath: string;
  /** 默认城市（用于天气等需要地理定位的工具，没填则模型会问用户） */
  defaultCity: string;
  /** 性别：secret(保密) | male(男) | female(女) */
  gender: string;
}

export const DEFAULT_USER_PROFILE: UserProfile = {
  nickname: "",
  callPreference: "",
  birthday: "",
  timezone: "Asia/Shanghai",
  avatarPath: "",
  defaultCity: "",
  gender: "secret",
};

export function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "model-settings.json");
}

export function getGeneralSettingsPath(): string {
  return path.join(app.getPath("userData"), "app-settings.json");
}

export function getUserProfilePath(): string {
  return path.join(app.getPath("userData"), "user-profile.json");
}

export function getAvatarPath(): string {
  return path.join(app.getPath("userData"), "avatar.png");
}

export function getRagStorePath(): string {
  return path.join(app.getPath("userData"), "rag-data", "memory-store.json");
}

export function getStickerSettingsPath(): string {
  return path.join(app.getPath("userData"), "sticker-settings.json");
}

export function loadUserProfile(): UserProfile {
  try {
    const filePath = getUserProfilePath();
    if (!fs.existsSync(filePath)) return DEFAULT_USER_PROFILE;
    return { ...DEFAULT_USER_PROFILE, ...JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<UserProfile> };
  } catch {
    return DEFAULT_USER_PROFILE;
  }
}

export function saveUserProfile(profile: Partial<UserProfile>): UserProfile {
  const existing = loadUserProfile();
  const merged = { ...existing, ...profile };
  const filePath = getUserProfilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
