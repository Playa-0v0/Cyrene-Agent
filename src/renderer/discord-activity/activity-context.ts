export interface ActivityLocation {
  search: string;
  ancestorOrigins?: ArrayLike<string>;
}

export function isDiscordActivity(location: ActivityLocation): boolean {
  const query = new URLSearchParams(location.search);
  if (query.has("frame_id") && query.has("instance_id")) return true;
  return Array.from(location.ancestorOrigins ?? []).some((origin) => origin === "https://discord.com");
}

export function resolveActivityClientId(envClientId: string | undefined): string | null {
  const value = envClientId?.trim();
  return value && /^\d{17,20}$/.test(value) ? value : null;
}
