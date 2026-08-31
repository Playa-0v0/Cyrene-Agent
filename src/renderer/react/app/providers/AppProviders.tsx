import type { ReactNode } from "react";
import { useChatAppearance } from "../../hooks/useChatAppearance";

interface AppProvidersProps {
  children: ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
  useChatAppearance();
  return <>{children}</>;
}
