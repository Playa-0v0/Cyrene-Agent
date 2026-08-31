import { getAdapterForConfig } from "./index";
import type { ChatVendorAdapter, TestConnectionResult, VendorConfig } from "./types";

type AdapterResolver = (config: VendorConfig) => ChatVendorAdapter;

/** Use the same config-aware adapter path as the Agent runtime. */
export async function testVendorConnection(
  config: VendorConfig,
  resolveAdapter: AdapterResolver = getAdapterForConfig,
): Promise<TestConnectionResult> {
  const adapter = resolveAdapter(config);
  console.log(
    `[Cyrene] test connection: provider=${config.provider} transport=${adapter.transport} model=${config.model}`,
  );
  const result = await adapter.testConnection(config);
  console.log("[Cyrene] test connection result:", JSON.stringify(result));
  return result;
}
