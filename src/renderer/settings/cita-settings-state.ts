export interface CitaUiSettings {
  enabled?: boolean;
  semanticEngine?: "remote" | "local";
}

export function getCitaUiState(settings: CitaUiSettings) {
  return {
    enabled: settings.enabled === true,
    selectedEngine: "remote" as const,
    localDisabled: true,
  };
}
