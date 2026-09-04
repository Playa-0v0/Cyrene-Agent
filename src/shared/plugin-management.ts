export type PluginRuntimeStatus =
  | "disabled"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  apiVersion: number;
  source: "builtin" | "user";
  path: string;
  defaultEnabled: boolean;
  configuredEnabled: boolean;
  enabled: boolean;
  status: PluginRuntimeStatus;
  error?: string;
  hasUnregister: boolean;
  canOpen: boolean;
  /** Icon as a data URL when the plugin provides a valid image file. */
  icon?: string;
}

export interface PluginScanIssue {
  root: string;
  path?: string;
  source: "builtin" | "user";
  message: string;
}

export interface PluginOverview {
  plugins: PluginListEntry[];
  issues: PluginScanIssue[];
}

export interface PluginManagementApi {
  list(): Promise<PluginOverview | PluginListEntry[]>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  open(id: string): Promise<{ ok: boolean; error?: string }>;
  rescan(): Promise<PluginOverview>;
  importZip(): Promise<{
    ok: boolean;
    canceled?: boolean;
    error?: string;
    plugin?: { id: string; name: string; version: string };
    overview?: PluginOverview;
  }>;
  uninstall(id: string): Promise<{ ok: boolean; error?: string; overview?: PluginOverview }>;
}
