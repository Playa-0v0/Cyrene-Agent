import { useEffect, useState } from "react";

interface UserProfile {
  nickname?: string;
  callPreference?: string;
}

interface UserProfileApi {
  getProfile: () => Promise<UserProfile | null>;
  onProfileChanged: (callback: (profile: UserProfile) => void) => () => void;
}

function userProfileApi(): UserProfileApi | undefined {
  return (window as typeof window & { user?: UserProfileApi }).user;
}

function normalizeProfileField(
  profile: UserProfile | null | undefined,
  field: keyof UserProfile,
  fallback: string,
): string {
  const value = profile?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function useUserProfileField(field: keyof UserProfile, fallback: string): string {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    let active = true;
    const api = userProfileApi();

    void api?.getProfile()
      .then((profile) => {
        if (active) setValue(normalizeProfileField(profile, field, fallback));
      })
      .catch(() => {
        if (active) setValue(fallback);
      });

    const unsubscribe = api?.onProfileChanged((profile) => {
      if (active) setValue(normalizeProfileField(profile, field, fallback));
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [fallback, field]);

  return value;
}

export function useUserNickname(): string {
  return useUserProfileField("nickname", "");
}

export function useUserCallPreference(): string {
  return useUserProfileField("callPreference", "伙伴");
}
