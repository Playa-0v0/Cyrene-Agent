import type { CitaSettings } from "./contracts";

export type NormalizedCitaSettings = CitaSettings & { semanticEngine: "remote" };

export const DEFAULT_CITA_SETTINGS: NormalizedCitaSettings = {
  enabled: false,
  semanticEngine: "remote",
};

export function normalizeCitaSettings(value: unknown): NormalizedCitaSettings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: record.enabled === true,
    semanticEngine: "remote",
  };
}
