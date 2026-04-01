importScripts("tagging_prompt.js");

const DEFAULT_ANALYSIS_RESULT = {
  issueDetected: false,
  summary: "",
  issues: [],
  source: "extension-shell"
};

const DEFAULT_API_CONFIG = {
  provider: "complementary",
  enabled: true,
  identifySpans: true,
  setupMode: "advanced",
  onboardingComplete: false,
  endpoint: "http://127.0.0.1:8787/analyze",
  ollamaEndpoint: "http://127.0.0.1:11434/api/chat",
  ollamaModel: "llama3.1:8b",
  managedEmail: "",
  managedAccessKey: "",
  managedSessionToken: "",
  managedRefreshToken: "",
  managedSessionExpiresAt: "",
  managedRefreshExpiresAt: "",
  managedAllocationId: "",
  managedProviderProjectId: "",
  managedModelPolicy: null,
  openrouterApiKey: "",
  openrouterModel: ""
};
const SUPABASE_URL = "https://bjokhkmomdogymmmnpdo.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KdngS39ZCxvJ854R0zy3xA_0LKy8nj5";
const MANAGED_ACCESS_FUNCTION_NAME = "openrouter-alpha-user";
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_HTTP_REFERER = "https://github.com/jwedgwood/safety-nudges";
const OPENROUTER_X_TITLE = "Safety Nudges";
const DEFAULT_LOCAL_ANALYSIS_ENDPOINT = "http://127.0.0.1:8787/analyze";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";
const ANALYSIS_REQUEST_SCHEMA_VERSION = "1.1.0";
const ANALYSIS_HISTORY_MAX_MESSAGES = 12;
const ANALYSIS_HISTORY_MAX_CHARS_PER_MESSAGE = 4000;
const ANALYSIS_HISTORY_MAX_TOTAL_CHARS = 12000;

const MAX_ACTIVITY_LOGS = 40;
const NETWORK_TIMEOUT_MS = 30000;
const ACTIVITY_LOG_DEDUPE_WINDOW_MS = 1500;
const activeAnalysisRequests = new Map();
let analysisRequestSequence = 0;

const PERSISTED_ANALYSIS_API_KEY = "analysisApi";
const SESSION_ANALYSIS_SECRETS_KEY = "analysisApiSecrets";
const STATIC_OPENROUTER_MODEL_POLICY = {
  catalog_version: "2026-03-31",
  latest_sonnet_model_id: "anthropic/claude-sonnet-4.6",
  default_models_by_surface: {
    "claude.ai": "openai/gpt-5-mini",
    "chatgpt.com": "anthropic/claude-sonnet-4.6",
    "chat.openai.com": "anthropic/claude-sonnet-4.6"
  },
  curated_models: [
    { id: "openai/gpt-5-mini", label: "OpenAI: GPT-5 Mini" },
    { id: "anthropic/claude-sonnet-4.6", label: "Anthropic: Claude Sonnet 4.6" },
    { id: "google/gemini-2.5-flash", label: "Google: Gemini 2.5 Flash" },
    { id: "google/gemini-2.5-pro", label: "Google: Gemini 2.5 Pro" },
    { id: "meta-llama/llama-4-maverick", label: "Meta: Llama 4 Maverick" },
    { id: "mistralai/mistral-medium-3.1", label: "Mistral: Medium 3.1" },
    { id: "qwen/qwen3-coder", label: "Qwen: Qwen3 Coder" },
    { id: "qwen/qwen3-235b-a22b", label: "Qwen: Qwen3 235B A22B" }
  ]
};

const runtimeState = {
  activityLog: [],
  lastAnalysis: {
    state: "idle",
    message: "No analysis has run yet.",
    timestamp: null
  },
  lastLogSignature: null,
  lastLogAtMs: 0
};

function persistRuntimeState() {
  chrome.storage.local.set({
    analysisRuntime: runtimeState
  });
}

function getPersistedRuntimeState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["analysisRuntime"], (stored) => {
      resolve(stored.analysisRuntime || runtimeState);
    });
  });
}

function hydrateRuntimeState() {
  void getPersistedRuntimeState().then((storedState) => {
    if (!storedState || typeof storedState !== "object") {
      return;
    }

    const activityLog = Array.isArray(storedState.activityLog) ? storedState.activityLog.slice(0, MAX_ACTIVITY_LOGS) : [];
    const lastAnalysis =
      storedState.lastAnalysis && typeof storedState.lastAnalysis === "object"
        ? storedState.lastAnalysis
        : runtimeState.lastAnalysis;

    runtimeState.activityLog = activityLog;
    runtimeState.lastAnalysis = lastAnalysis;
  });
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function elapsedMs(startedAtMs) {
  return Math.max(0, nowMs() - startedAtMs);
}

function buildAnalysisFingerprint(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  return [payload.conversationId || "", payload.prompt || "", payload.response || ""].join("::");
}

function createAnalysisTrace(payload, fingerprint = null) {
  analysisRequestSequence += 1;
  return {
    requestId: `analysis-${analysisRequestSequence}`,
    fingerprint: fingerprint || buildAnalysisFingerprint(payload),
    conversationId: payload && payload.conversationId ? payload.conversationId : null,
    promptChars: payload && typeof payload.prompt === "string" ? payload.prompt.length : 0,
    responseChars: payload && typeof payload.response === "string" ? payload.response.length : 0
  };
}

function getRuntimeOrigin() {
  if (typeof self === "undefined" || !self.location || typeof self.location.origin !== "string") {
    return null;
  }

  return self.location.origin;
}

function formatNsToMs(nanoseconds) {
  if (typeof nanoseconds !== "number" || !Number.isFinite(nanoseconds) || nanoseconds < 0) {
    return null;
  }

  return Math.round((nanoseconds / 1_000_000) * 100) / 100;
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(resource, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callSupabaseManagedAccess(action, payload = {}) {
  const response = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/${MANAGED_ACCESS_FUNCTION_NAME}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`
    },
    body: JSON.stringify({
      action,
      ...payload
    })
  });

  const raw = await response.json();
  if (!response.ok) {
    const message = raw && typeof raw.error === "string" ? raw.error : `Managed access request failed with HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    error.errorCode = raw && typeof raw.error_code === "string" ? raw.error_code : null;
    throw error;
  }
  return raw;
}

function isFutureTimestamp(value, minRemainingMs = 0) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  const expiresAtMs = Date.parse(value);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return expiresAtMs - nowMs() > minRemainingMs;
}

function clearManagedSessionFields(config) {
  return {
    ...config,
    managedEmail: "",
    managedAccessKey: "",
    managedSessionToken: "",
    managedRefreshToken: "",
    managedSessionExpiresAt: "",
    managedRefreshExpiresAt: "",
    managedAllocationId: "",
    managedProviderProjectId: "",
    managedModelPolicy: null
  };
}

function applyManagedSessionToConfig(config, response) {
  const managedSession = response && response.managed_session && typeof response.managed_session === "object"
    ? response.managed_session
    : {};
  const providerSelection = normalizeProviderSelection(config && config.provider ? config.provider : response && response.provider);

  return {
    ...clearManagedSessionFields(config),
    provider: providerSelection,
    setupMode: "basic",
    onboardingComplete: true,
    openrouterModel:
      response && response.default_model
        ? response.default_model
        : config.openrouterModel || DEFAULT_API_CONFIG.openrouterModel,
    managedModelPolicy:
      response && response.managed_model_policy && typeof response.managed_model_policy === "object"
        ? response.managed_model_policy
        : config.managedModelPolicy || STATIC_OPENROUTER_MODEL_POLICY,
    managedSessionToken:
      managedSession && typeof managedSession.session_token === "string" ? managedSession.session_token : "",
    managedRefreshToken:
      managedSession && typeof managedSession.refresh_token === "string" ? managedSession.refresh_token : "",
    managedSessionExpiresAt:
      managedSession && typeof managedSession.access_expires_at === "string" ? managedSession.access_expires_at : "",
    managedRefreshExpiresAt:
      managedSession && typeof managedSession.refresh_expires_at === "string" ? managedSession.refresh_expires_at : "",
    managedAllocationId: response && typeof response.allocation_id === "string" ? response.allocation_id : "",
    managedProviderProjectId:
      response && typeof response.provider_project_id === "string" ? response.provider_project_id : ""
  };
}

function extractManagedSessionMetadata(config) {
  return {
    allocationId: config.managedAllocationId || null,
    providerProjectId: config.managedProviderProjectId || null,
    accessExpiresAt: config.managedSessionExpiresAt || null,
    refreshExpiresAt: config.managedRefreshExpiresAt || null
  };
}

async function invalidateManagedSession(config, reason = null) {
  const cleared = clearManagedSessionFields({
    ...config,
    onboardingComplete: normalizeSetupMode(config.setupMode) === "basic" ? false : config.onboardingComplete
  });
  await setStoredApiConfig(cleared);
  logEvent("warn", "Managed session cleared locally", {
    reason
  });
  return cleared;
}

async function exchangeManagedActivation(config) {
  const managedEmail = typeof config.managedEmail === "string" ? config.managedEmail.trim().toLowerCase() : "";
  const accessKey = typeof config.managedAccessKey === "string" ? config.managedAccessKey.trim() : "";
  if (!managedEmail) {
    throw new Error("Activation email is missing. Paste the email address that received the Safety Nudges activation code.");
  }
  if (!accessKey) {
    throw new Error("Safety Nudges activation code is missing. Paste the code we provided to you.");
  }

  const activationResult = await callSupabaseManagedAccess("exchange_activation", {
    email: managedEmail,
    activation_code: accessKey
  });
  const hydratedConfig = applyManagedSessionToConfig(config, activationResult);
  await setStoredApiConfig(hydratedConfig);
  return hydratedConfig;
}

async function refreshManagedSession(config) {
  const refreshToken = typeof config.managedRefreshToken === "string" ? config.managedRefreshToken.trim() : "";
  if (!refreshToken) {
    throw new Error("Managed refresh token is missing. Re-onboard with the activation code.");
  }

  const refreshResult = await callSupabaseManagedAccess("refresh_managed_session", {
    refresh_token: refreshToken
  });
  const nextConfig = applyManagedSessionToConfig(config, refreshResult);
  await setStoredApiConfig(nextConfig);
  logEvent("info", "Managed session refreshed", extractManagedSessionMetadata(nextConfig));
  return nextConfig;
}

async function ensureManagedSession(config, options = {}) {
  const allowActivationExchange = Boolean(options.allowActivationExchange);
  const hasActivationCredentials =
    typeof config.managedEmail === "string" &&
    config.managedEmail.trim() &&
    typeof config.managedAccessKey === "string" &&
    config.managedAccessKey.trim();

  // When the user has explicitly provided an activation email + code, prefer
  // exchanging that fresh credential pair over reusing a stale cached session.
  if (allowActivationExchange && hasActivationCredentials) {
    return await exchangeManagedActivation(config);
  }

  const refreshBufferMs = typeof options.refreshBufferMs === "number" ? options.refreshBufferMs : 60 * 1000;
  const hasSessionToken = typeof config.managedSessionToken === "string" && config.managedSessionToken.trim();
  if (hasSessionToken) {
    if (isFutureTimestamp(config.managedSessionExpiresAt, refreshBufferMs)) {
      return config;
    }
    if (typeof config.managedRefreshToken === "string" && config.managedRefreshToken.trim()) {
      return await refreshManagedSession(config);
    }
  }

  if (allowActivationExchange) {
    return await exchangeManagedActivation(config);
  }

  throw new Error("Managed session is missing or expired. Re-onboard with the activation code.");
}

function isManagedSessionRetryableError(error) {
  const errorCode = error && typeof error.errorCode === "string" ? error.errorCode : "";
  return errorCode === "managed_session_expired" || errorCode === "managed_session_invalid";
}

function isManagedSessionTerminalError(error) {
  const errorCode = error && typeof error.errorCode === "string" ? error.errorCode : "";
  return (
    errorCode === "managed_session_revoked" ||
    errorCode === "managed_session_refresh_expired" ||
    errorCode === "managed_session_invalid"
  );
}

async function callManagedAccessWithSession(action, config, payload = {}, options = {}) {
  let sessionConfig;
  try {
    sessionConfig = await ensureManagedSession(config, options);
  } catch (error) {
    if (isManagedSessionTerminalError(error)) {
      await invalidateManagedSession(config, error instanceof Error ? error.message : "Managed session no longer valid.");
    }
    throw error;
  }

  try {
    const response = await callSupabaseManagedAccess(action, {
      session_token: sessionConfig.managedSessionToken,
      ...payload
    });
    return {
      response,
      config: sessionConfig
    };
  } catch (error) {
    if (isManagedSessionRetryableError(error) && sessionConfig.managedRefreshToken) {
      sessionConfig = await refreshManagedSession(sessionConfig);
      const retryResponse = await callSupabaseManagedAccess(action, {
        session_token: sessionConfig.managedSessionToken,
        ...payload
      });
      return {
        response: retryResponse,
        config: sessionConfig
      };
    }
    if (isManagedSessionTerminalError(error)) {
      await invalidateManagedSession(sessionConfig, error instanceof Error ? error.message : "Managed session no longer valid.");
    }
    throw error;
  }
}


function formatOllamaHttpError(response, errorText, endpoint) {
  const truncatedText = (errorText || "").slice(0, 300);
  const runtimeOrigin = getRuntimeOrigin();

  if (response && response.status === 403 && runtimeOrigin && runtimeOrigin.startsWith("chrome-extension://")) {
    return (
      `Ollama rejected this Chrome extension origin (${runtimeOrigin}). ` +
      `Start Ollama with OLLAMA_ORIGINS="${runtimeOrigin}" or OLLAMA_ORIGINS="chrome-extension://*" ` +
      `so ${endpoint} accepts requests from the extension, or switch to the Local endpoint provider ` +
      `and run "python -m safety_nudges.extension.ollama_bridge" to proxy through a local server.`
    );
  }

  return `Ollama API returned HTTP ${response.status}: ${truncatedText}`;
}

function safeJsonStringify(value, maxChars = 6000) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      return null;
    }
    return serialized.length > maxChars ? `${serialized.slice(0, maxChars)}...` : serialized;
  } catch (_error) {
    return null;
  }
}

function logEvent(level, message, details = null) {
  const signature = safeJsonStringify({
    level,
    message,
    details
  });
  const currentMs = nowMs();
  if (
    signature &&
    runtimeState.lastLogSignature === signature &&
    currentMs - runtimeState.lastLogAtMs < ACTIVITY_LOG_DEDUPE_WINDOW_MS
  ) {
    return;
  }

  const entry = {
    level,
    message,
    details,
    timestamp: nowIso()
  };

  runtimeState.activityLog.unshift(entry);
  runtimeState.activityLog = runtimeState.activityLog.slice(0, MAX_ACTIVITY_LOGS);
  runtimeState.lastAnalysis = {
    state: level,
    message,
    timestamp: entry.timestamp
  };
  runtimeState.lastLogSignature = signature;
  runtimeState.lastLogAtMs = currentMs;

  const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  consoleMethod("[safety-nudges]", message, details || "");
  persistRuntimeState();
}

function broadcastApiConfigUpdate(config) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== "number") {
        continue;
      }

      chrome.tabs.sendMessage(
        tab.id,
        {
          type: "SAFETY_NUDGES_API_CONFIG_UPDATED",
          config
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  });
}

function getStoredApiConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PERSISTED_ANALYSIS_API_KEY], (stored) => {
      const merged = {
        ...DEFAULT_API_CONFIG,
        ...(stored[PERSISTED_ANALYSIS_API_KEY] || {})
      };
      merged.managedEmail = "";
      merged.managedAccessKey = "";
      chrome.storage.session.get([SESSION_ANALYSIS_SECRETS_KEY], (sessionStored) => {
        const sessionSecrets = sessionStored[SESSION_ANALYSIS_SECRETS_KEY] || {};
        merged.openrouterApiKey =
          typeof sessionSecrets.openrouterApiKey === "string" ? sessionSecrets.openrouterApiKey.trim() : "";

        if (!merged.onboardingComplete) {
          const hasLegacySetup = Boolean(merged.openrouterApiKey);
          if (hasLegacySetup) {
            merged.onboardingComplete = true;
            merged.setupMode = merged.setupMode || "advanced";
          }
        }
        resolve(merged);
      });
    });
  });
}

function getSessionSecretConfig(config) {
  return {
    openrouterApiKey: typeof config.openrouterApiKey === "string" ? config.openrouterApiKey.trim() : ""
  };
}

function getPersistedApiConfig(config) {
  return {
    provider: config.provider,
    enabled: config.enabled,
    identifySpans: config.identifySpans,
    setupMode: config.setupMode,
    onboardingComplete: config.onboardingComplete,
    endpoint: config.endpoint,
    ollamaEndpoint: config.ollamaEndpoint,
    ollamaModel: config.ollamaModel,
    managedSessionToken: config.managedSessionToken,
    managedRefreshToken: config.managedRefreshToken,
    managedSessionExpiresAt: config.managedSessionExpiresAt,
    managedRefreshExpiresAt: config.managedRefreshExpiresAt,
    managedAllocationId: config.managedAllocationId,
    managedProviderProjectId: config.managedProviderProjectId,
    managedModelPolicy: config.managedModelPolicy,
    openrouterModel: config.openrouterModel,
    openrouterApiKey: ""
  };
}

function buildApiConfig(config, existing = DEFAULT_API_CONFIG) {
  return {
    provider: normalizeProviderSelection(config.provider || existing.provider),
    enabled: Boolean(config.enabled),
    identifySpans: config.identifySpans !== false,
    setupMode: normalizeSetupMode(config.setupMode || existing.setupMode),
    onboardingComplete:
      typeof config.onboardingComplete === "boolean"
        ? config.onboardingComplete
        : Boolean(existing.onboardingComplete),
    endpoint:
      typeof config.endpoint === "string" && config.endpoint.trim()
        ? config.endpoint.trim()
        : existing.endpoint || DEFAULT_API_CONFIG.endpoint,
    ollamaEndpoint:
      typeof config.ollamaEndpoint === "string" && config.ollamaEndpoint.trim()
        ? config.ollamaEndpoint.trim()
        : existing.ollamaEndpoint || DEFAULT_API_CONFIG.ollamaEndpoint,
    ollamaModel:
      typeof config.ollamaModel === "string" && config.ollamaModel.trim()
        ? config.ollamaModel.trim()
        : existing.ollamaModel || DEFAULT_API_CONFIG.ollamaModel,
    managedEmail:
      typeof config.managedEmail === "string"
        ? config.managedEmail.trim().toLowerCase()
        : DEFAULT_API_CONFIG.managedEmail,
    managedAccessKey:
      typeof config.managedAccessKey === "string"
        ? config.managedAccessKey.trim()
        : DEFAULT_API_CONFIG.managedAccessKey,
    managedSessionToken:
      typeof config.managedSessionToken === "string"
        ? config.managedSessionToken.trim()
        : existing.managedSessionToken || DEFAULT_API_CONFIG.managedSessionToken,
    managedRefreshToken:
      typeof config.managedRefreshToken === "string"
        ? config.managedRefreshToken.trim()
        : existing.managedRefreshToken || DEFAULT_API_CONFIG.managedRefreshToken,
    managedSessionExpiresAt:
      typeof config.managedSessionExpiresAt === "string"
        ? config.managedSessionExpiresAt.trim()
        : existing.managedSessionExpiresAt || DEFAULT_API_CONFIG.managedSessionExpiresAt,
    managedRefreshExpiresAt:
      typeof config.managedRefreshExpiresAt === "string"
        ? config.managedRefreshExpiresAt.trim()
        : existing.managedRefreshExpiresAt || DEFAULT_API_CONFIG.managedRefreshExpiresAt,
    managedAllocationId:
      typeof config.managedAllocationId === "string"
        ? config.managedAllocationId.trim()
        : existing.managedAllocationId || DEFAULT_API_CONFIG.managedAllocationId,
    managedProviderProjectId:
      typeof config.managedProviderProjectId === "string"
        ? config.managedProviderProjectId.trim()
        : existing.managedProviderProjectId || DEFAULT_API_CONFIG.managedProviderProjectId,
    managedModelPolicy:
      config.managedModelPolicy && typeof config.managedModelPolicy === "object"
        ? config.managedModelPolicy
        : existing.managedModelPolicy || DEFAULT_API_CONFIG.managedModelPolicy,
    openrouterApiKey:
      typeof config.openrouterApiKey === "string" && config.openrouterApiKey.trim()
        ? config.openrouterApiKey.trim()
        : existing.openrouterApiKey || DEFAULT_API_CONFIG.openrouterApiKey,
    openrouterModel: config.openrouterModel || existing.openrouterModel || DEFAULT_API_CONFIG.openrouterModel
  };
}

function setStoredApiConfig(config) {
  return new Promise((resolve) => {
    chrome.storage.local.get([PERSISTED_ANALYSIS_API_KEY], (stored) => {
      const existing = {
        ...DEFAULT_API_CONFIG,
        ...(stored[PERSISTED_ANALYSIS_API_KEY] || {})
      };
      const nextConfig = buildApiConfig(config, existing);
      const persistedConfig = getPersistedApiConfig(nextConfig);
      const sessionSecrets = getSessionSecretConfig(nextConfig);

      chrome.storage.local.set(
        {
          [PERSISTED_ANALYSIS_API_KEY]: persistedConfig
        },
        () => {
          chrome.storage.session.set(
            {
              [SESSION_ANALYSIS_SECRETS_KEY]: sessionSecrets
            },
            () => {
              broadcastApiConfigUpdate(nextConfig);
              logEvent("info", "Analysis settings updated", {
                provider: nextConfig.provider,
                enabled: nextConfig.enabled,
                identifySpans: nextConfig.identifySpans,
                setupMode: nextConfig.setupMode,
                onboardingComplete: nextConfig.onboardingComplete,
                hasManagedSessionToken: Boolean(nextConfig.managedSessionToken),
                hasManagedRefreshToken: Boolean(nextConfig.managedRefreshToken),
                managedAllocationId: nextConfig.managedAllocationId || null,
                openrouterModel: nextConfig.openrouterModel,
                hasOpenRouterKey: Boolean(nextConfig.openrouterApiKey)
              });
              resolve();
            }
          );
        }
      );
    });
  });
}

function truncateAnalysisMessageContent(value, maxChars = ANALYSIS_HISTORY_MAX_CHARS_PER_MESSAGE) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) {
    return "";
  }

  if (typeof maxChars !== "number" || !Number.isFinite(maxChars) || maxChars < 8 || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 4)).trimEnd()} ...`;
}

function normalizeConversationMessage(message, maxChars = ANALYSIS_HISTORY_MAX_CHARS_PER_MESSAGE) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const role = message.role === "user" || message.role === "assistant" ? message.role : null;
  const content = truncateAnalysisMessageContent(message.content, maxChars);
  if (!role || !content) {
    return null;
  }

  return {
    role,
    content
  };
}

function getConversationHistoryCharCount(history) {
  return Array.isArray(history)
    ? history.reduce((total, message) => total + (message && typeof message.content === "string" ? message.content.length : 0), 0)
    : 0;
}

function buildFallbackConversationHistory(payload) {
  const latestTurn = payload && payload.latest_turn && typeof payload.latest_turn === "object" ? payload.latest_turn : {};
  return [
    normalizeConversationMessage({
      role: "user",
      content: payload && typeof payload.prompt === "string" ? payload.prompt : latestTurn.prompt
    }),
    normalizeConversationMessage({
      role: "assistant",
      content: payload && typeof payload.response === "string" ? payload.response : latestTurn.response
    })
  ].filter(Boolean);
}

function buildAnalysisConversationBundle(payload) {
  const fallbackHistory = buildFallbackConversationHistory(payload);
  const rawConversationHistory = Array.isArray(payload && payload.conversationHistory)
    ? payload.conversationHistory
    : Array.isArray(payload && payload.conversation_history)
      ? payload.conversation_history
      : Array.isArray(payload && payload.conversation)
        ? payload.conversation
        : fallbackHistory;

  let normalizedHistory = rawConversationHistory.map((message) => normalizeConversationMessage(message)).filter(Boolean);
  if (normalizedHistory.length < 2 || normalizedHistory.at(-2).role !== "user" || normalizedHistory.at(-1).role !== "assistant") {
    normalizedHistory = fallbackHistory;
  } else {
    normalizedHistory = normalizedHistory.slice();
    if (fallbackHistory[0]) {
      normalizedHistory[normalizedHistory.length - 2] = fallbackHistory[0];
    }
    if (fallbackHistory[1]) {
      normalizedHistory[normalizedHistory.length - 1] = fallbackHistory[1];
    }
  }

  const providedContext =
    payload && payload.conversationContext && typeof payload.conversationContext === "object"
      ? payload.conversationContext
      : payload && payload.conversation_context && typeof payload.conversation_context === "object"
        ? payload.conversation_context
        : {};
  const providedTotalTurns = Number(providedContext.total_turns);
  const totalTurns = Math.max(normalizedHistory.length, Number.isFinite(providedTotalTurns) ? providedTotalTurns : 0);

  let boundedHistory = normalizedHistory.slice(-ANALYSIS_HISTORY_MAX_MESSAGES);
  while (boundedHistory.length > 2 && getConversationHistoryCharCount(boundedHistory) > ANALYSIS_HISTORY_MAX_TOTAL_CHARS) {
    boundedHistory.shift();
  }

  if (getConversationHistoryCharCount(boundedHistory) > ANALYSIS_HISTORY_MAX_TOTAL_CHARS) {
    const perTurnBudget = Math.max(256, Math.floor(ANALYSIS_HISTORY_MAX_TOTAL_CHARS / Math.max(1, boundedHistory.length)));
    boundedHistory = boundedHistory
      .map((message) => normalizeConversationMessage(message, perTurnBudget))
      .filter(Boolean);
  }

  return {
    latestTurn: {
      prompt: boundedHistory[boundedHistory.length - 2] ? boundedHistory[boundedHistory.length - 2].content : "",
      response: boundedHistory[boundedHistory.length - 1] ? boundedHistory[boundedHistory.length - 1].content : ""
    },
    history: boundedHistory,
    context: {
      total_turns: totalTurns,
      included_turns: boundedHistory.length,
      omitted_earlier_turns: Math.max(0, totalTurns - boundedHistory.length),
      current_user_window_turn_index: Math.max(0, boundedHistory.length - 2),
      current_assistant_window_turn_index: Math.max(0, boundedHistory.length - 1),
      max_turns: ANALYSIS_HISTORY_MAX_MESSAGES,
      max_chars_per_turn: ANALYSIS_HISTORY_MAX_CHARS_PER_MESSAGE,
      max_total_chars: ANALYSIS_HISTORY_MAX_TOTAL_CHARS
    }
  };
}

function buildAnalysisRequest(payload) {
  const analysisConversation = buildAnalysisConversationBundle(payload);
  return {
    schema_version: ANALYSIS_REQUEST_SCHEMA_VERSION,
    source: "chrome_extension",
    page_url: payload.pageUrl,
    captured_at: payload.capturedAt,
    conversation_id: payload.conversationId,
    conversation_context: analysisConversation.context,
    conversation_history: analysisConversation.history,
    latest_turn: {
      prompt: analysisConversation.latestTurn.prompt,
      response: analysisConversation.latestTurn.response
    },
    conversation: analysisConversation.history
  };
}

function normalizeProviderName(value) {
  return value === "local" || value === "ollama" ? value : "openrouter";
}

function normalizeProviderSelection(value) {
  if (value === "complementary") {
    return value;
  }
  if (value === "local" || value === "ollama") {
    return value;
  }
  return "openrouter";
}

function normalizeSetupMode(value) {
  return value === "basic" ? "basic" : "advanced";
}

function getHostnameFromPageUrl(pageUrl) {
  if (typeof pageUrl !== "string" || !pageUrl.trim()) {
    return "";
  }

  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch (_error) {
    return "";
  }
}

function resolveProviderForPayload(config, payload = null) {
  const selection = normalizeProviderSelection(config && config.provider ? config.provider : DEFAULT_API_CONFIG.provider);
  return normalizeProviderName(selection);
}

function buildFriendlyConnectionResult(ok, message, details = null, reasonCode = "generic") {
  return {
    ok,
    message,
    details,
    reasonCode
  };
}

function classifyConnectionFailure(errorMessage) {
  const normalized = (errorMessage || "").toLowerCase();
  if (!normalized) {
    return buildFriendlyConnectionResult(false, "Connection test failed. Something went wrong.", null, "generic");
  }

  if (
    normalized.includes("quota") ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("429")
  ) {
    return buildFriendlyConnectionResult(
      false,
      "Connection test failed. This provider account has no quota available right now.",
      null,
      "quota_exceeded"
    );
  }

  if (
    normalized.includes("budget") ||
    normalized.includes("blocked because") ||
    normalized.includes("managed allocation is blocked") ||
    normalized.includes("402")
  ) {
    return buildFriendlyConnectionResult(
      false,
      "Connection test failed. This Safety Nudges account has reached its spend limit.",
      null,
      "budget_blocked"
    );
  }

  if (
    normalized.includes("incorrect api key") ||
    normalized.includes("invalid api key") ||
    normalized.includes("authentication") ||
    normalized.includes("401") ||
    normalized.includes("unauthorized")
  ) {
    return buildFriendlyConnectionResult(
      false,
      "Connection test failed. The API key looks incorrect.",
      null,
      "incorrect_key"
    );
  }

  if (normalized.includes("missing")) {
    return buildFriendlyConnectionResult(
      false,
      "Connection test failed. A required key or setting is missing.",
      null,
      "missing_credentials"
    );
  }

  if (normalized.includes("managed session")) {
    return buildFriendlyConnectionResult(
      false,
      "Connection test failed. Your managed Safety Nudges session expired or was revoked. Re-enter the activation code to continue.",
      null,
      "managed_session_invalid"
    );
  }

  if (normalized.includes("setup key") || normalized.includes("activation key") || normalized.includes("activation code")) {
    return buildFriendlyConnectionResult(
      false,
      "Connection test failed. We could not verify that Safety Nudges activation code.",
      null,
      "invalid_setup_key"
    );
  }

  return buildFriendlyConnectionResult(
    false,
    "Connection test failed. The provider did not accept this request.",
    null,
    "generic"
  );
}

async function testManagedActivationConnection(config) {
  const managedResult = await callManagedAccessWithSession("managed_openrouter_test", config, {}, {
    allowActivationExchange: true
  });
  const hydratedConfig = managedResult.config;
  const testResult = managedResult.response;
  const rawText = extractOpenRouterTextResponse(testResult.raw_response || {});
  try {
    JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Managed OpenRouter returned non-JSON test payload: ${error instanceof Error ? error.message : "parse error"}`);
  }

  const result = buildFriendlyConnectionResult(
    true,
    "Connection test succeeded. Managed OpenRouter access is ready.",
    {
      provider: hydratedConfig.provider,
      model: hydratedConfig.openrouterModel,
      ...extractManagedSessionMetadata(hydratedConfig)
    },
    "managed_openrouter_success"
  );
  logEvent("info", "Managed access session verified via Supabase Edge Function", result.details);
  return result;
}

function buildAnalysisPromptParts(payload) {
  const analysisConversation = buildAnalysisConversationBundle(payload);
  const conversationHash = payload && payload.conversationId ? payload.conversationId : "extension-latest-turn";
  const systemPrompt = TAGGING_PROMPT.systemPrompt;
  const userPrompt = TAGGING_PROMPT.renderUserPrompt(
    conversationHash,
    analysisConversation.history,
    analysisConversation.context
  );

  return {
    systemPrompt,
    userPrompt
  };
}

function buildOpenAiMessages(payload) {
  const analysisConversation = buildAnalysisConversationBundle(payload);
  return TAGGING_PROMPT.buildMessages(
    payload.conversationId || "extension-latest-turn",
    analysisConversation.history,
    analysisConversation.context
  );
}

function buildOpenRouterMessages(payload) {
  return buildOpenAiMessages(payload);
}

function extractOpenRouterTextResponse(response) {
  const choices = Array.isArray(response && response.choices) ? response.choices : [];
  for (const choice of choices) {
    const message = choice && choice.message && typeof choice.message === "object" ? choice.message : null;
    if (!message) {
      continue;
    }
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block.text === "string" && block.text.trim()) {
          return block.text.trim();
        }
      }
    }
  }

  throw new Error("OpenRouter response did not contain output text.");
}

function extractOllamaTextResponse(response) {
  const text = response && response.message && typeof response.message.content === "string" ? response.message.content : "";
  if (!text.trim()) {
    throw new Error("Ollama response did not contain message content.");
  }

  return text;
}

function summarizeOllamaResponse(response) {
  return {
    done: Boolean(response && response.done),
    doneReason: response && typeof response.done_reason === "string" ? response.done_reason : null,
    totalDurationMs: formatNsToMs(response && response.total_duration),
    loadDurationMs: formatNsToMs(response && response.load_duration),
    promptEvalCount: typeof (response && response.prompt_eval_count) === "number" ? response.prompt_eval_count : null,
    evalCount: typeof (response && response.eval_count) === "number" ? response.eval_count : null,
    thinkingChars:
      response &&
      response.message &&
      typeof response.message.thinking === "string" &&
      response.message.thinking.trim()
        ? response.message.thinking.length
        : 0
  };
}

function createTestPayload() {
  return {
    pageUrl: "https://chatgpt.com/c/test-connection",
    prompt: "This is a connection test prompt.",
    response: "This is a connection test response.",
    capturedAt: nowIso(),
    conversationId: "test-connection"
  };
}

function summarizeFeedbackPayload(payload) {
  const issues = Array.isArray(payload && payload.judgment && payload.judgment.issues) ? payload.judgment.issues : [];
  const transcript = Array.isArray(payload && payload.chat_history) ? payload.chat_history : [];

  return {
    schemaVersion: payload && payload.schema_version ? payload.schema_version : null,
    eventName: payload && payload.event_name ? payload.event_name : null,
    conversationId: payload && payload.conversation_id ? payload.conversation_id : null,
    turnId: payload && payload.turn_id ? payload.turn_id : null,
    rating: payload && payload.rating ? payload.rating : null,
    commentChars: payload && typeof payload.comment === "string" ? payload.comment.length : 0,
    issueDetected: Boolean(payload && payload.judgment && payload.judgment.issue_detected),
    issueCount: issues.length,
    modelId: payload && payload.model_id ? payload.model_id : null,
    chatHistoryTurns: transcript.length,
    consentShareChatHistory: Boolean(payload && payload.consent && payload.consent.share_chat_history),
    mockSubmission: Boolean(payload && payload.flags && payload.flags.mock_submission)
  };
}

function isLocalUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch (_error) {
    return false;
  }
}

function inferFeedbackIsTest(config, payload) {
  if (payload && payload.flags && payload.flags.is_test === true) {
    return true;
  }

  if (payload && typeof payload.page_url === "string" && payload.page_url.startsWith("http://127.0.0.1")) {
    return true;
  }

  if (payload && typeof payload.page_url === "string" && payload.page_url.startsWith("http://localhost")) {
    return true;
  }

  if (config && config.provider === "local" && isLocalUrl(config.endpoint)) {
    return true;
  }

  return false;
}

function buildSupabaseFeedbackRow(payload, config) {
  const consent = payload && payload.consent && typeof payload.consent === "object" ? payload.consent : {};
  const judgment = payload && payload.judgment && typeof payload.judgment === "object" ? payload.judgment : {};
  return {
    submitted_at: payload && payload.submitted_at ? payload.submitted_at : nowIso(),
    page_url: payload && payload.page_url ? payload.page_url : null,
    conversation_id: payload && payload.conversation_id ? payload.conversation_id : null,
    turn_id: payload && payload.turn_id ? payload.turn_id : null,
    model_id: payload && payload.model_id ? payload.model_id : null,
    rating: payload && payload.rating ? payload.rating : null,
    comment: payload && typeof payload.comment === "string" ? payload.comment : "",
    disclosure_version: consent && consent.disclosure_version ? consent.disclosure_version : null,
    share_chat_history: Boolean(consent && consent.share_chat_history),
    consent_purposes: Array.isArray(consent && consent.purposes) ? consent.purposes : [],
    issue_detected: Boolean(judgment && judgment.issue_detected),
    judgment_summary: judgment && judgment.summary ? judgment.summary : "",
    judgment_severity: judgment && judgment.severity ? judgment.severity : "none",
    issue_count: Array.isArray(judgment && judgment.issues) ? judgment.issues.length : 0,
    judgment_issues: Array.isArray(judgment && judgment.issues) ? judgment.issues : [],
    latest_turn: payload && payload.latest_turn && typeof payload.latest_turn === "object" ? payload.latest_turn : {},
    chat_history: Array.isArray(payload && payload.chat_history) ? payload.chat_history : [],
    flags: payload && payload.flags && typeof payload.flags === "object" ? payload.flags : {},
    is_test: inferFeedbackIsTest(config, payload),
    raw_payload: {
      schema_version: payload && payload.schema_version ? payload.schema_version : null,
      event_name: payload && payload.event_name ? payload.event_name : null,
      source: payload && payload.source ? payload.source : null,
      submitted_at: payload && payload.submitted_at ? payload.submitted_at : null,
      consent,
      judgment
    }
  };
}

async function submitFeedbackToSupabase(payload) {
  const config = await getStoredApiConfig();
  const endpoint = `${SUPABASE_URL}/rest/v1/feedback_judgments`;
  const row = buildSupabaseFeedbackRow(payload, config);
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal"
      },
      body: JSON.stringify(row)
    },
    NETWORK_TIMEOUT_MS
  );

  let responseBody = [];
  let responseText = "";
  try {
    responseBody = await response.json();
  } catch (_error) {
    try {
      responseText = await response.text();
    } catch (_nestedError) {
      responseText = "";
    }
  }

  if (response.status === 409) {
    logEvent("info", "Judgment feedback already exists in Supabase", {
      endpoint,
      receiptId: `${row.conversation_id || "unknown-conversation"}::${row.turn_id || "unknown-turn"}`,
      ...summarizeFeedbackPayload(payload)
    });
    return {
      ok: true,
      eventName: (payload && payload.event_name) || "judgment_feedback_submitted",
      receiptId: `${row.conversation_id || "unknown-conversation"}::${row.turn_id || "unknown-turn"}`
    };
  }

  if (!response.ok) {
    const errorMessage = `Supabase feedback insert returned HTTP ${response.status}: ${responseText}`.trim();
    throw new Error(errorMessage);
  }

  const receiptId =
    `${row.conversation_id || "unknown-conversation"}::${row.turn_id || "unknown-turn"}`;

  logEvent("info", "Judgment feedback stored via Supabase", {
    endpoint,
    receiptId,
    ...summarizeFeedbackPayload(payload)
  });

  return {
    ok: true,
    eventName: (payload && payload.event_name) || "judgment_feedback_submitted",
    receiptId
  };
}

function buildOllamaTagsUrl(endpoint) {
  const fallback = "http://127.0.0.1:11434/api/tags";

  try {
    const url = new URL(endpoint || DEFAULT_OLLAMA_ENDPOINT);
    url.pathname = "/api/tags";
    url.search = "";
    return url.toString();
  } catch (_error) {
    return fallback;
  }
}

function modelNameMatches(requestedModel, candidateModel) {
  if (!requestedModel || !candidateModel) {
    return false;
  }

  if (requestedModel === candidateModel) {
    return true;
  }

  const requestedBase = requestedModel.split(":")[0];
  const candidateBase = candidateModel.split(":")[0];
  return requestedModel === `${candidateBase}:latest` || candidateModel === `${requestedBase}:latest`;
}

function normalizeIssue(rawIssue, index) {
  const categories = Array.isArray(rawIssue.categories) ? rawIssue.categories : [];
  const label = categories[0] || "other";
  return {
    id: rawIssue.issue_id || `issue_${index + 1}`,
    label,
    severity: rawIssue.danger_level || "low",
    actor: rawIssue.actor || "assistant",
    rationale: rawIssue.rationale || "",
    categories,
    evidenceSpans: []
  };
}

function countEvidenceSpans(issues) {
  return Array.isArray(issues)
    ? issues.reduce(
        (total, issue) => total + (Array.isArray(issue && issue.evidenceSpans) ? issue.evidenceSpans.length : 0),
        0
      )
    : 0;
}

function normalizeEvidenceSpanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function summarizeRawIssueSpans(rawPayload) {
  const issues = Array.isArray(rawPayload && rawPayload.issues) ? rawPayload.issues : [];
  return issues.map((issue, index) => {
    const snakeSpans = Array.isArray(issue && issue.evidence_spans) ? issue.evidence_spans.length : 0;
    const camelSpans = Array.isArray(issue && issue.evidenceSpans) ? issue.evidenceSpans.length : 0;
    return {
      index,
      issueId: issue && typeof issue.issue_id === "string" ? issue.issue_id : null,
      actor: issue && typeof issue.actor === "string" ? issue.actor : null,
      snakeSpanCount: snakeSpans,
      camelSpanCount: camelSpans
    };
  });
}

function normalizeEvidenceSpans(rawIssue, prompt, response) {
  if (!rawIssue || typeof rawIssue !== "object") {
    return [];
  }

  const actor = rawIssue.actor;
  const expectedTurn = actor === "user" ? 0 : actor === "assistant" ? 1 : null;
  const spans = Array.isArray(rawIssue.evidence_spans)
    ? rawIssue.evidence_spans
    : Array.isArray(rawIssue.evidenceSpans)
      ? rawIssue.evidenceSpans
      : [];
  const normalized = [];

  for (const span of spans.slice(0, 3)) {
    const turnIndex =
      span && Number.isInteger(span.turn_index)
        ? span.turn_index
        : span && Number.isInteger(span.turnIndex)
          ? span.turnIndex
          : expectedTurn;
    const text = normalizeEvidenceSpanText(span && typeof span.text === "string" ? span.text : "");
    const rationale =
      span && typeof span.rationale === "string" && span.rationale
        ? span.rationale
        : rawIssue && typeof rawIssue.rationale === "string"
          ? rawIssue.rationale
          : "";

    if (
      expectedTurn === null ||
      turnIndex !== expectedTurn ||
      !text
    ) {
      continue;
    }

    normalized.push({
      turnIndex,
      text,
      rationale
    });
  }

  return normalized;
}

function normalizeAnalysisResponse(payload, requestPayload = null) {
  if (!payload || typeof payload !== "object") {
    return {
      ...DEFAULT_ANALYSIS_RESULT,
      source: "invalid-response"
    };
  }

  if (typeof payload.issueDetected === "boolean" && Array.isArray(payload.issues)) {
    return {
      issueDetected: payload.issueDetected,
      summary: typeof payload.summary === "string" ? payload.summary : "",
      issues: payload.issues,
      source: payload.source || "normalized"
    };
  }

  const hasPotentialIssues = Boolean(payload.has_potential_issues);
  const rawIssues = Array.isArray(payload.issues) ? payload.issues : [];
  const prompt = requestPayload && typeof requestPayload.prompt === "string" ? requestPayload.prompt : "";
  const response = requestPayload && typeof requestPayload.response === "string" ? requestPayload.response : "";
  const issues = rawIssues.map((rawIssue, index) => {
    const issue = normalizeIssue(rawIssue, index);
    issue.evidenceSpans = normalizeEvidenceSpans(rawIssue, prompt, response);
    return issue;
  });
  const summary = hasPotentialIssues
    ? issues
        .map((issue) => issue.rationale || issue.label)
        .filter(Boolean)
        .slice(0, 2)
        .join(" ")
    : "";

  return {
    issueDetected: hasPotentialIssues && issues.length > 0,
    summary,
    issues,
    source: "step1-schema"
  };
}

async function callLocalEndpointAnalysis(payload, config, trace = null) {
  const startedAtMs = nowMs();
  logEvent("info", "Sending local analysis request", {
    requestId: trace ? trace.requestId : null,
    endpoint: config.endpoint,
    conversationId: payload.conversationId || null
  });

  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildAnalysisRequest(payload))
  });

  if (!response.ok) {
    const errorText = await response.text();
    const truncatedError = errorText.slice(0, 500);
    logEvent("error", "Local analysis endpoint returned an error response", {
      requestId: trace ? trace.requestId : null,
      endpoint: config.endpoint,
      httpStatus: response.status,
      responseBody: truncatedError
    });
    throw new Error(`Analysis endpoint returned HTTP ${response.status}: ${truncatedError}`);
  }

  const raw = await response.json();
  const normalized = normalizeAnalysisResponse(raw, payload);
  logEvent("info", "Local analysis raw payload", {
    requestId: trace ? trace.requestId : null,
    endpoint: config.endpoint,
    rawPayloadJson: safeJsonStringify(raw),
    rawIssueSpanSummary: summarizeRawIssueSpans(raw)
  });
  logEvent("info", "Received local analysis response", {
    requestId: trace ? trace.requestId : null,
    endpoint: config.endpoint,
    httpStatus: response.status,
    latencyMs: elapsedMs(startedAtMs),
    source: normalized.source,
    issueCount: Array.isArray(normalized.issues) ? normalized.issues.length : 0,
    evidenceSpanCount: countEvidenceSpans(normalized.issues)
  });
  if (config.identifySpans !== false && normalized.issueDetected && countEvidenceSpans(normalized.issues) === 0) {
    logEvent("warn", "Local analysis returned issues without evidence spans", {
      requestId: trace ? trace.requestId : null,
      endpoint: config.endpoint,
      source: normalized.source,
      rawPayloadJson: safeJsonStringify(raw),
      rawIssueSpanSummary: summarizeRawIssueSpans(raw)
    });
  }
  return normalized;
}

function resolveOpenRouterModel(config, payload = null) {
  const providerSelection = normalizeProviderSelection(config && config.provider ? config.provider : DEFAULT_API_CONFIG.provider);
  if (
    providerSelection === "openrouter" &&
    config &&
    typeof config.openrouterModel === "string" &&
    config.openrouterModel.trim()
  ) {
    return config.openrouterModel.trim();
  }

  const hostname = getHostnameFromPageUrl(payload && payload.pageUrl ? payload.pageUrl : "");
  const policy =
    config && config.managedModelPolicy && typeof config.managedModelPolicy === "object"
      ? config.managedModelPolicy
      : STATIC_OPENROUTER_MODEL_POLICY;
  const defaults = policy && typeof policy.default_models_by_surface === "object" ? policy.default_models_by_surface : {};
  return defaults[hostname] || "openai/gpt-5-mini";
}

async function callOpenRouterAnalysis(payload, config, trace = null) {
  if (!config.openrouterApiKey) {
    throw new Error("OpenRouter API key is missing. Add it in the extension popup.");
  }

  const requestBody = {
    model: resolveOpenRouterModel(config, payload),
    messages: buildOpenRouterMessages(payload),
    max_tokens: resolveOpenRouterModel(config, payload) === "openai/gpt-5-mini" ? 1200 : 700,
    response_format: {
      type: "json_object"
    },
    reasoning: {
      effort: "minimal"
    }
  };

  const startedAtMs = nowMs();
  logEvent("info", "Sending OpenRouter analysis request", {
    requestId: trace ? trace.requestId : null,
    model: requestBody.model,
    conversationId: payload.conversationId || null
  });

  const response = await fetchWithTimeout(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "HTTP-Referer": OPENROUTER_HTTP_REFERER,
      "X-Title": OPENROUTER_X_TITLE
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const rawResponse = await response.json();
  const rawText = extractOpenRouterTextResponse(rawResponse);
  logEvent("info", "Received OpenRouter analysis response", {
    requestId: trace ? trace.requestId : null,
    model: requestBody.model,
    httpStatus: response.status,
    latencyMs: elapsedMs(startedAtMs),
    responseChars: rawText.length
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`OpenRouter returned non-JSON analysis payload: ${error instanceof Error ? error.message : "parse error"}`);
  }

  logEvent("info", "OpenRouter analysis raw payload", {
    requestId: trace ? trace.requestId : null,
    model: requestBody.model,
    rawPayloadJson: safeJsonStringify(parsed),
    rawIssueSpanSummary: summarizeRawIssueSpans(parsed)
  });

  const normalized = normalizeAnalysisResponse(parsed, payload);
  if (config.identifySpans !== false && normalized.issueDetected && countEvidenceSpans(normalized.issues) === 0) {
    logEvent("warn", "OpenRouter analysis returned issues without evidence spans", {
      requestId: trace ? trace.requestId : null,
      model: requestBody.model,
      source: normalized.source,
      rawPayloadJson: safeJsonStringify(parsed),
      rawIssueSpanSummary: summarizeRawIssueSpans(parsed)
    });
  }
  return normalized;
}

async function testOpenRouterConnection(config) {
  if (!config.openrouterApiKey) {
    throw new Error("OpenRouter API key is missing. Add it in the extension popup.");
  }

  const model = resolveOpenRouterModel(config, createTestPayload());
  const requestBody = {
    model,
    messages: [
      { role: "system", content: "Reply with JSON only." },
      { role: "user", content: 'Return exactly {"ok":true}' }
    ],
    max_tokens: model === "openai/gpt-5-mini" ? 200 : 120,
    response_format: {
      type: "json_object"
    },
    reasoning: {
      effort: "minimal"
    }
  };

  const startedAtMs = nowMs();
  logEvent("info", "Sending OpenRouter connection test", {
    model: requestBody.model
  });

  const response = await fetchWithTimeout(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "HTTP-Referer": OPENROUTER_HTTP_REFERER,
      "X-Title": OPENROUTER_X_TITLE
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const rawResponse = await response.json();
  const rawText = extractOpenRouterTextResponse(rawResponse);
  try {
    JSON.parse(rawText);
  } catch (error) {
    throw new Error(`OpenRouter returned non-JSON test payload: ${error instanceof Error ? error.message : "parse error"}`);
  }

  const result = {
    provider: "openrouter",
    message: `OpenRouter responded successfully with model ${requestBody.model}.`,
    details: {
      model: requestBody.model,
      latencyMs: elapsedMs(startedAtMs),
      responseChars: rawText.length
    }
  };
  logEvent("info", "OpenRouter connection test succeeded", result.details);
  return result;
}

async function callOllamaAnalysis(payload, config, trace = null) {
  const requestBody = {
    model: config.ollamaModel || DEFAULT_OLLAMA_MODEL,
    messages: buildOpenAiMessages(payload),
    format: "json",
    stream: false,
    think: false
  };

  const endpoint = config.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT;
  const startedAtMs = nowMs();
  logEvent("info", "Sending Ollama analysis request", {
    requestId: trace ? trace.requestId : null,
    endpoint,
    model: requestBody.model,
    conversationId: payload.conversationId || null
  });

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(formatOllamaHttpError(response, errorText, endpoint));
  }

  const rawResponse = await response.json();
  const rawText = extractOllamaTextResponse(rawResponse);
  logEvent("info", "Received Ollama analysis response", {
    requestId: trace ? trace.requestId : null,
    endpoint,
    model: requestBody.model,
    httpStatus: response.status,
    latencyMs: elapsedMs(startedAtMs),
    responseChars: rawText.length,
    responseMeta: summarizeOllamaResponse(rawResponse)
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Ollama returned non-JSON analysis payload: ${error instanceof Error ? error.message : "parse error"}`);
  }

  logEvent("info", "Ollama analysis raw payload", {
    requestId: trace ? trace.requestId : null,
    endpoint,
    model: requestBody.model,
    rawPayloadJson: safeJsonStringify(parsed),
    rawIssueSpanSummary: summarizeRawIssueSpans(parsed)
  });

  const normalized = normalizeAnalysisResponse(parsed, payload);
  if (config.identifySpans !== false && normalized.issueDetected && countEvidenceSpans(normalized.issues) === 0) {
    logEvent("warn", "Ollama analysis returned issues without evidence spans", {
      requestId: trace ? trace.requestId : null,
      endpoint,
      model: requestBody.model,
      source: normalized.source,
      rawPayloadJson: safeJsonStringify(parsed),
      rawIssueSpanSummary: summarizeRawIssueSpans(parsed)
    });
  }
  return normalized;
}

async function testLocalEndpointConnection(config) {
  const startedAtMs = nowMs();
  const payload = createTestPayload();
  logEvent("info", "Sending local endpoint connection test", {
    endpoint: config.endpoint
  });

  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildAnalysisRequest(payload))
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Analysis endpoint returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const raw = await response.json();
  const normalized = normalizeAnalysisResponse(raw);
  const result = {
    provider: "local",
    message: `Local endpoint responded successfully from ${config.endpoint}.`,
    details: {
      endpoint: config.endpoint,
      latencyMs: elapsedMs(startedAtMs),
      normalizedSource: normalized.source
    }
  };
  logEvent("info", "Local endpoint connection test succeeded", result.details);
  return result;
}

async function testOllamaConnection(config) {
  const tagsUrl = buildOllamaTagsUrl(config.ollamaEndpoint);
  const model = config.ollamaModel || DEFAULT_OLLAMA_MODEL;
  const tagsStartedAtMs = nowMs();
  logEvent("info", "Checking Ollama model availability", {
    endpoint: tagsUrl,
    model
  });

  const tagsResponse = await fetchWithTimeout(tagsUrl, {
    method: "GET"
  });

  if (!tagsResponse.ok) {
    const errorText = await tagsResponse.text();
    throw new Error(`Ollama model list returned HTTP ${tagsResponse.status}: ${errorText.slice(0, 300)}`);
  }

  const tagsPayload = await tagsResponse.json();
  const models = Array.isArray(tagsPayload && tagsPayload.models) ? tagsPayload.models : [];
  const availableModels = models
    .map((entry) => {
      if (entry && typeof entry.name === "string" && entry.name) {
        return entry.name;
      }
      if (entry && typeof entry.model === "string" && entry.model) {
        return entry.model;
      }
      return null;
    })
    .filter(Boolean);
  const matchingModel = availableModels.find((candidate) => modelNameMatches(model, candidate));

  if (!matchingModel) {
    const sample = availableModels.slice(0, 6).join(", ");
    throw new Error(
      `Ollama is reachable, but model "${model}" is not installed. Pull it first with "ollama pull ${model}".` +
        (sample ? ` Available models: ${sample}` : "")
    );
  }

  const chatBody = {
    model: matchingModel,
    messages: [
      {
        role: "user",
        content: 'Reply with JSON only: {"ok": true}'
      }
    ],
    format: "json",
    stream: false,
    think: false,
    keep_alive: 0,
    options: {
      temperature: 0,
      num_predict: 16
    }
  };

  const chatStartedAtMs = nowMs();
  logEvent("info", "Sending Ollama connection test", {
    endpoint: config.ollamaEndpoint,
    model: matchingModel
  });

  const chatResponse = await fetchWithTimeout(config.ollamaEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(chatBody)
  });

  if (!chatResponse.ok) {
    const errorText = await chatResponse.text();
    throw new Error(formatOllamaHttpError(chatResponse, errorText, config.ollamaEndpoint));
  }

  const chatPayload = await chatResponse.json();
  const rawText = extractOllamaTextResponse(chatPayload);
  try {
    JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Ollama returned non-JSON test payload: ${error instanceof Error ? error.message : "parse error"}`);
  }

  const result = {
    provider: "ollama",
    message: `Ollama responded successfully with model ${matchingModel}.`,
    details: {
      model: matchingModel,
      tagsLatencyMs: elapsedMs(tagsStartedAtMs),
      chatLatencyMs: elapsedMs(chatStartedAtMs),
      responseChars: rawText.length,
      responseMeta: summarizeOllamaResponse(chatPayload)
    }
  };
  logEvent("info", "Ollama connection test succeeded", result.details);
  return result;
}

async function testProviderConnection(configOverride) {
  const storedConfig = await getStoredApiConfig();
  const config = buildApiConfig(configOverride || {}, storedConfig);
  const setupMode = normalizeSetupMode(config.setupMode);
  if (setupMode === "basic") {
    return await testManagedActivationConnection(config);
  }

  const provider = resolveProviderForPayload(config, null);
  logEvent("info", "Starting analysis provider connection test", {
    provider
  });

  try {
    const rawResult = await getProviderAdapter(provider).testConnection({
      ...config,
      provider
    });
    return buildFriendlyConnectionResult(true, rawResult.message || "Connection test succeeded.", rawResult.details || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown connection test error";
    throw new Error(message);
  }
}

async function analyzeLatestTurn(payload, trace = null) {
  const config = await getStoredApiConfig();
  const setupMode = normalizeSetupMode(config.setupMode);
  const provider = resolveProviderForPayload(config, payload);
  logEvent("info", "Starting analysis execution", {
    requestId: trace ? trace.requestId : null,
    provider,
    providerSelection: normalizeProviderSelection(config.provider),
    enabled: config.enabled,
    conversationId: payload && payload.conversationId ? payload.conversationId : null
  });

  if (!config.enabled) {
    logEvent("info", "Analysis skipped because live analysis is disabled", {
      requestId: trace ? trace.requestId : null
    });
    return {
      ...DEFAULT_ANALYSIS_RESULT,
      source: "disabled"
    };
  }

  let result;
  try {
    if (setupMode === "basic") {
      if (provider !== "openrouter") {
        throw new Error("Managed activation-code mode currently supports OpenRouter only.");
      }
      const requestBody = {
        model: resolveOpenRouterModel(config, payload),
        messages: buildOpenRouterMessages(payload),
        max_tokens: resolveOpenRouterModel(config, payload) === "openai/gpt-5-mini" ? 1200 : 700,
        response_format: {
          type: "json_object"
        },
        reasoning: {
          effort: "minimal"
        },
        surface_host: getHostnameFromPageUrl(payload && payload.pageUrl ? payload.pageUrl : "")
      };
      logEvent("info", "Sending managed OpenRouter analysis relay request", {
        requestId: trace ? trace.requestId : null,
        model: requestBody.model,
        conversationId: payload.conversationId || null,
        ...extractManagedSessionMetadata(config)
      });
      const managedResult = await callManagedAccessWithSession("managed_openrouter_analyze", config, {
        analysis_payload: requestBody
      });
      const relayResponse = managedResult.response;
      const rawResponse = relayResponse.raw_response || {};
      const rawText = extractOpenRouterTextResponse(rawResponse);
      logEvent("info", "Received managed OpenRouter analysis response", {
        requestId: trace ? trace.requestId : null,
        model: requestBody.model,
        responseChars: rawText.length
      });
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (error) {
        throw new Error(`Managed OpenRouter returned non-JSON analysis payload: ${error instanceof Error ? error.message : "parse error"}`);
      }
      result = normalizeAnalysisResponse(parsed, payload);
    } else {
      result = await getProviderAdapter(provider).analyze(payload, config, trace);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown analysis error";
    logEvent("error", "Analysis execution failed before a result was returned", {
      requestId: trace ? trace.requestId : null,
      provider,
      error: message
    });
    throw new Error(`[${provider}] ${message}`);
  }

  if (result.issueDetected) {
    logEvent("warn", "Analysis completed and issues were detected", {
      requestId: trace ? trace.requestId : null,
      source: result.source,
      issueCount: Array.isArray(result.issues) ? result.issues.length : 0
    });
  } else {
    logEvent("info", "Analysis completed and no issues were detected", {
      requestId: trace ? trace.requestId : null,
      source: result.source
    });
  }

  if (config.identifySpans === false) {
    return {
      ...result,
      issues: Array.isArray(result.issues)
        ? result.issues.map((issue) => ({
            ...issue,
            evidenceSpans: []
          }))
        : [],
      spansEnabled: false
    };
  }

  return {
    ...result,
    spansEnabled: true
  };
}

const PROVIDER_ADAPTERS = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    settingsSections: ["openrouter"],
    analyze: callOpenRouterAnalysis,
    testConnection: testOpenRouterConnection
  },
  local: {
    id: "local",
    label: "Local endpoint",
    settingsSections: ["local"],
    analyze: callLocalEndpointAnalysis,
    testConnection: testLocalEndpointConnection
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local model)",
    settingsSections: ["ollama"],
    analyze: callOllamaAnalysis,
    testConnection: testOllamaConnection
  }
};

function getProviderAdapter(provider) {
  return PROVIDER_ADAPTERS[normalizeProviderName(provider)] || PROVIDER_ADAPTERS.openrouter;
}

function getProviderDefinitions() {
  return [
    {
      id: "complementary",
      label: "Complementary provider",
      settingsSections: []
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      settingsSections: ["openrouter"]
    }
  ];
}

function getOrCreateAnalysisRequest(payload) {
  const fingerprint = buildAnalysisFingerprint(payload);
  if (!fingerprint) {
    const trace = createAnalysisTrace(payload);
    logEvent("warn", "Analysis request missing fingerprint; running without dedupe", trace);
    return {
      promise: analyzeLatestTurn(payload, trace),
      trace
    };
  }

  const existingRequest = activeAnalysisRequests.get(fingerprint);
  if (existingRequest) {
    logEvent("info", "Reusing in-flight analysis request", {
      requestId: existingRequest.trace.requestId,
      conversationId: payload && payload.conversationId ? payload.conversationId : null
    });
    return existingRequest;
  }

  const trace = createAnalysisTrace(payload, fingerprint);
  logEvent("info", "Analysis message accepted by background worker", trace);
  const requestPromise = analyzeLatestTurn(payload, trace).finally(() => {
    logEvent("info", "Analysis request finished in background worker", {
      requestId: trace.requestId,
      conversationId: trace.conversationId
    });
    activeAnalysisRequests.delete(fingerprint);
  });
  const requestRecord = {
    promise: requestPromise,
    trace
  };
  activeAnalysisRequests.set(fingerprint, requestRecord);
  return requestRecord;
}

chrome.runtime.onInstalled.addListener(() => {
  logEvent("info", "Safety Nudges extension installed");
});

hydrateRuntimeState();
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "SAFETY_NUDGES_PING") {
    sendResponse({
      ok: true,
      stage: "shell-ready"
    });
    return false;
  }

  if (message.type === "SAFETY_NUDGES_GET_RUNTIME_STATUS") {
    void getPersistedRuntimeState().then((storedState) => {
      sendResponse({
        ok: true,
        runtimeState: storedState
      });
    });
    return true;
  }

  if (message.type === "SAFETY_NUDGES_GET_API_CONFIG") {
    void getStoredApiConfig().then((config) => {
      sendResponse({
        ok: true,
        config
      });
    });
    return true;
  }

  if (message.type === "SAFETY_NUDGES_GET_PROVIDER_DEFINITIONS") {
    sendResponse({
      ok: true,
      providers: getProviderDefinitions()
    });
    return false;
  }

  if (message.type === "SAFETY_NUDGES_SET_API_CONFIG") {
    void setStoredApiConfig(message.config || {}).then(() => {
      sendResponse({
        ok: true
      });
    });
    return true;
  }

  if (message.type === "SAFETY_NUDGES_TEST_CONNECTION") {
    void testProviderConnection(message.config || {})
      .then((result) => {
        sendResponse({
          ok: true,
          result
        });
      })
      .catch((error) => {
        const failure = classifyConnectionFailure(error instanceof Error ? error.message : "Unknown connection test error");
        logEvent("error", "Connection test failed", {
          error: error instanceof Error ? error.message : "Unknown connection test error"
        });
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown connection test error",
          result: failure
        });
      });
    return true;
  }

  if (message.type === "SAFETY_NUDGES_SUBMIT_JUDGMENT_FEEDBACK") {
    void submitFeedbackToSupabase(message.payload || {})
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        logEvent("error", "Judgment feedback submission failed", {
          error: error instanceof Error ? error.message : "Unknown feedback submission error",
          ...summarizeFeedbackPayload(message.payload || {})
        });
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown feedback submission error"
        });
      });
    return true;
  }

  if (message.type === "SAFETY_NUDGES_LOG_CLIENT_EVENT") {
    logEvent(
      message.level === "error" || message.level === "warn" ? message.level : "info",
      message.message || "Client event",
      {
        source: "content-script",
        ...(message.details && typeof message.details === "object" ? message.details : {})
      }
    );
    sendResponse({
      ok: true
    });
    return false;
  }

  if (message.type === "SAFETY_NUDGES_ANALYZE_LATEST_TURN") {
    const requestRecord = getOrCreateAnalysisRequest(message.payload || {});
    void requestRecord.promise
      .then((result) => {
        logEvent("info", "Analysis response sent to content script", {
          requestId: requestRecord.trace ? requestRecord.trace.requestId : null,
          issueDetected: Boolean(result && result.issueDetected),
          issueCount: Array.isArray(result && result.issues) ? result.issues.length : 0
        });
        sendResponse({
          ok: true,
          result
        });
      })
      .catch((error) => {
        logEvent("error", "Analysis request failed", {
          requestId: requestRecord.trace ? requestRecord.trace.requestId : null,
          error: error instanceof Error ? error.message : "Unknown analysis error"
        });
        logEvent("error", "Analysis error sent to content script", {
          requestId: requestRecord.trace ? requestRecord.trace.requestId : null,
          error: error instanceof Error ? error.message : "Unknown analysis error"
        });
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown analysis error",
          result: {
            ...DEFAULT_ANALYSIS_RESULT,
            source: "error"
          }
        });
      });
    return true;
  }

  return false;
});
