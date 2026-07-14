const ALLOW = new Set([
  "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOME",
  "LANG", "LC_ALL", "LC_CTYPE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "PYTHONIOENCODING", "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE",
  "UV_PROJECT_ENVIRONMENT", "UV_PYTHON",
]);

export function buildChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOW) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
