export interface CacheStatistics {
  hit: number;
  miss: number;
  requests: number;
  cacheUsageRequests: number;
}

/** 只根据模型服务商明确返回的缓存统计计算命中率。 */
export function formatCacheRate(summary: CacheStatistics): string {
  const cacheableInput = Math.max(0, summary.hit) + Math.max(0, summary.miss);
  if (summary.cacheUsageRequests <= 0 || cacheableInput <= 0) {
    return "模型未提供缓存统计";
  }
  const rate = Math.max(0, summary.hit) / cacheableInput * 100;
  return `${rate.toFixed(1)}%（已统计 ${summary.cacheUsageRequests} / ${summary.requests} 次请求）`;
}
