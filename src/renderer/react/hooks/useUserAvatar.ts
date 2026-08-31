import { useEffect, useState } from "react";

interface UserAvatarApi {
  getAvatar: () => Promise<string | null>;
  onAvatarChanged: (callback: () => void) => () => void;
}

function userAvatarApi(): UserAvatarApi | undefined {
  return (window as typeof window & { user?: UserAvatarApi }).user;
}

export function useUserAvatar(): string | null {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const api = userAvatarApi();

    async function refresh() {
      try {
        const nextAvatar = await api?.getAvatar();
        if (active) setAvatarUrl(nextAvatar ?? null);
      } catch {
        if (active) setAvatarUrl(null);
      }
    }

    void refresh();
    const unsubscribe = api?.onAvatarChanged(() => { void refresh(); });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return avatarUrl;
}
