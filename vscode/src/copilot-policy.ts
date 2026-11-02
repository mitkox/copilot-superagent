/** GitHub-owned inference destinations only; there is no configurable provider URL. */
export function copilotGithubHost(value = 'github.com'): string {
  if (value !== 'github.com' && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/.test(value)) {
    throw new Error('Copilot-only: use github.com or your enterprise subdomain on ghe.com')
  }
  return value
}

export function assertCopilotModel(value: unknown): asserts value is string {
  // Custom registry models are provider-qualified (provider/model); URLs are never model IDs.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value)) {
    throw new Error('Copilot-only: select an unqualified model ID available through GitHub Copilot')
  }
}

export function assertCopilotEndpoint(value: string, transport: 'http' | 'websocket', githubHost = 'github.com'): void {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Copilot-only: invalid inference destination') }
  const approved = githubHost === 'github.com'
    ? /^(?:[a-z0-9-]+\.)+(?:business|enterprise)\.githubcopilot\.com$/.test(url.hostname)
    : url.hostname === `copilot-api.${copilotGithubHost(githubHost)}`
  if (!approved || url.protocol !== (transport === 'http' ? 'https:' : 'wss:') || url.port || url.username || url.password || url.hash) {
    throw new Error('Copilot-only: inference requires an approved GitHub Copilot Business or Enterprise endpoint')
  }
}

const inherited = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'TERM',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
])

export function copilotEnvironment(providerRegistry: string, githubHost: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key.toUpperCase()))),
    COPILOT_GH_HOST: copilotGithubHost(githubHost), GH_HOST: githubHost,
    COPILOT_PROVIDERS_CONFIG: providerRegistry,
    COPILOT_AUTO_UPDATE: 'false', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true',
    COPILOT_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true',
    OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none',
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
  }
}
