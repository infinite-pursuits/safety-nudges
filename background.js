importScripts("tagging_prompt.js");

const DEFAULT_ANALYSIS_RESULT = {
  issueDetected: false,
  summary: "",
  issues: [],
  source: "extension-shell"
};

const DEFAULT_API_CONFIG = {
  provider: "complementary",
  enabled: false,
  analysisSensitivity: "standard",
  identifySpans: true,
  setupMode: "basic",
  onboardingComplete: false,
  managedEmail: "",
  managedAccessKey: "",
  managedSessionToken: "",
  managedRefreshToken: "",
  managedSessionExpiresAt: "",
  managedRefreshExpiresAt: "",
  managedAllocationId: "",
  managedPilotFeedbackEnabled: false,
  managedFeedbackParticipantId: "",
  managedProviderProjectId: "",
  managedModelPolicy: null,
  directModel: "",
  endpoint: ""
};
const SUPABASE_URL = "https://bjokhkmomdogymmmnpdo.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KdngS39ZCxvJ854R0zy3xA_0LKy8nj5";
// Historical deployed function name. New extension builds call only the direct-provider actions.
const MANAGED_ACCESS_FUNCTION_NAME = "openrouter-alpha-user";
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
const STATIC_DIRECT_MODEL_POLICY = {
  catalog_version: "2026-05-08-direct",
  relay_provider: "direct",
  latest_sonnet_model_id: "claude-sonnet-4-6",
  default_models_by_surface: {
    "claude.ai": "gpt-5-mini",
    "chatgpt.com": "claude-sonnet-4-6",
    "chat.openai.com": "claude-sonnet-4-6"
  },
  curated_models: [
    { id: "gpt-5-mini", label: "OpenAI: GPT-5 Mini" },
    { id: "claude-sonnet-4-6", label: "Anthropic: Claude Sonnet 4.6" }
  ]
};
const DIRECT_MODEL_IDS = new Set(STATIC_DIRECT_MODEL_POLICY.curated_models.map((entry) => entry.id));

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
    managedPilotFeedbackEnabled: false,
    managedFeedbackParticipantId: "",
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
    directModel: response && response.default_model ? response.default_model : config.directModel || DEFAULT_API_CONFIG.directModel,
    managedModelPolicy:
      response && response.managed_model_policy && typeof response.managed_model_policy === "object"
        ? response.managed_model_policy
        : config.managedModelPolicy || STATIC_DIRECT_MODEL_POLICY,
    managedSessionToken:
      managedSession && typeof managedSession.session_token === "string" ? managedSession.session_token : "",
    managedRefreshToken:
      managedSession && typeof managedSession.refresh_token === "string" ? managedSession.refresh_token : "",
    managedSessionExpiresAt:
      managedSession && typeof managedSession.access_expires_at === "string" ? managedSession.access_expires_at : "",
    managedRefreshExpiresAt:
      managedSession && typeof managedSession.refresh_expires_at === "string" ? managedSession.refresh_expires_at : "",
    managedAllocationId: response && typeof response.allocation_id === "string" ? response.allocation_id : "",
    managedPilotFeedbackEnabled: Boolean(response && response.pilot_feedback_enabled),
    managedFeedbackParticipantId:
      response && typeof response.feedback_participant_id === "string" ? response.feedback_participant_id : "",
    managedProviderProjectId:
      response && typeof response.provider_project_id === "string" ? response.provider_project_id : ""
  };
}

function extractManagedSessionMetadata(config) {
  const policy =
    config && config.managedModelPolicy && typeof config.managedModelPolicy === "object"
      ? config.managedModelPolicy
      : {};
  const relayProvider = typeof policy.relay_provider === "string" ? policy.relay_provider : "direct";
  return {
    allocationId: config.managedAllocationId || null,
    relayProvider,
    pilotFeedbackEnabled: Boolean(config.managedPilotFeedbackEnabled),
    feedbackParticipantId: config.managedFeedbackParticipantId || null,
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

function sanitizeDirectModelPolicy(policy) {
  if (!policy || typeof policy !== "object" || policy.relay_provider !== "direct") {
    return STATIC_DIRECT_MODEL_POLICY;
  }
  const curatedModels = Array.isArray(policy.curated_models) ? policy.curated_models : [];
  const hasOnlyDirectModels = curatedModels.every((entry) => entry && DIRECT_MODEL_IDS.has(entry.id));
  return hasOnlyDirectModels ? policy : STATIC_DIRECT_MODEL_POLICY;
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
      merged.managedModelPolicy = sanitizeDirectModelPolicy(merged.managedModelPolicy);
      chrome.storage.session.get([SESSION_ANALYSIS_SECRETS_KEY], () => {
        resolve(merged);
      });
    });
  });
}

function getSessionSecretConfig(config) {
  void config;
  return {};
}

function getPersistedApiConfig(config) {
  return {
    provider: config.provider,
    enabled: config.enabled,
    analysisSensitivity: config.analysisSensitivity,
    identifySpans: config.identifySpans,
    setupMode: config.setupMode,
    onboardingComplete: config.onboardingComplete,
    managedSessionToken: config.managedSessionToken,
    managedRefreshToken: config.managedRefreshToken,
    managedSessionExpiresAt: config.managedSessionExpiresAt,
    managedRefreshExpiresAt: config.managedRefreshExpiresAt,
    managedAllocationId: config.managedAllocationId,
    managedPilotFeedbackEnabled: Boolean(config.managedPilotFeedbackEnabled),
    managedFeedbackParticipantId: config.managedFeedbackParticipantId,
    managedProviderProjectId: config.managedProviderProjectId,
    managedModelPolicy: config.managedModelPolicy,
    directModel: config.directModel,
    endpoint: config.endpoint
  };
}

function buildApiConfig(config, existing = DEFAULT_API_CONFIG) {
  return {
    provider: normalizeProviderSelection(config.provider || existing.provider),
    enabled: Boolean(config.enabled),
    analysisSensitivity: TAGGING_PROMPT.normalizeAnalysisSensitivity(
      config.analysisSensitivity || existing.analysisSensitivity
    ),
    identifySpans: config.identifySpans !== false,
    setupMode: normalizeSetupMode(config.setupMode || existing.setupMode),
    onboardingComplete:
      typeof config.onboardingComplete === "boolean"
        ? config.onboardingComplete
        : Boolean(existing.onboardingComplete),
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
    managedPilotFeedbackEnabled:
      typeof config.managedPilotFeedbackEnabled === "boolean"
        ? config.managedPilotFeedbackEnabled
        : Boolean(existing.managedPilotFeedbackEnabled),
    managedFeedbackParticipantId:
      typeof config.managedFeedbackParticipantId === "string"
        ? config.managedFeedbackParticipantId.trim()
        : existing.managedFeedbackParticipantId || DEFAULT_API_CONFIG.managedFeedbackParticipantId,
    managedProviderProjectId:
      typeof config.managedProviderProjectId === "string"
        ? config.managedProviderProjectId.trim()
        : existing.managedProviderProjectId || DEFAULT_API_CONFIG.managedProviderProjectId,
    managedModelPolicy:
      config.managedModelPolicy && typeof config.managedModelPolicy === "object"
        ? sanitizeDirectModelPolicy(config.managedModelPolicy)
        : sanitizeDirectModelPolicy(existing.managedModelPolicy || DEFAULT_API_CONFIG.managedModelPolicy),
    directModel:
      config.directModel ||
      existing.directModel ||
      DEFAULT_API_CONFIG.directModel,
    endpoint:
      typeof config.endpoint === "string" && config.endpoint.trim()
        ? config.endpoint.trim()
        : existing.endpoint || DEFAULT_API_CONFIG.endpoint
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
                directModel: nextConfig.directModel
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
    analysis_policy:
      payload && payload.analysisPolicy && typeof payload.analysisPolicy === "object" ? payload.analysisPolicy : {},
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
  if (value === "local") {
    return "local";
  }
  return "direct";
}

function normalizeProviderSelection(value) {
  if (value === "local") {
    return "local";
  }
  if (value === "direct") {
    return "direct";
  }
  return "complementary";
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

function resolveProviderForPayload(config, _payload = null) {
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

  if (
    normalized.includes("openai_api_key") ||
    normalized.includes("anthropic_api_key") ||
    normalized.includes("provider credential") ||
    normalized.includes("provider credentials")
  ) {
    return buildFriendlyConnectionResult(
      false,
      "Connection test failed. Safety Nudges managed infrastructure is missing a provider credential. This is not something to add in the extension popup.",
      null,
      "managed_provider_credentials_missing"
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
  const managedResult = await callManagedAccessWithSession("managed_provider_test", config, {}, {
    allowActivationExchange: true
  });
  const hydratedConfig = managedResult.config;
  const testResult = managedResult.response;
  const rawText = extractProviderTextResponse(testResult.raw_response || {});
  try {
    JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Managed provider returned non-JSON test payload: ${error instanceof Error ? error.message : "parse error"}`);
  }

  const result = buildFriendlyConnectionResult(
    true,
    "Connection test succeeded. Managed Safety Nudges access is ready.",
    {
      provider: hydratedConfig.provider,
      relayProvider: "direct",
      model: hydratedConfig.directModel,
      ...extractManagedSessionMetadata(hydratedConfig)
    },
    "managed_provider_success"
  );
  logEvent("info", "Managed access session verified via Supabase Edge Function", result.details);
  return result;
}

function buildAnalysisPromptParts(payload) {
  const analysisConversation = buildAnalysisConversationBundle(payload);
  const conversationHash = payload && payload.conversationId ? payload.conversationId : "extension-latest-turn";
  const systemPrompt = TAGGING_PROMPT.systemPrompt;
  const userPrompt = TAGGING_PROMPT.appendAnalysisSensitivityInstruction(
    TAGGING_PROMPT.renderUserPrompt(conversationHash, analysisConversation.history, analysisConversation.context),
    payload && payload.analysisPolicy ? payload.analysisPolicy.sensitivity : null
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
    analysisConversation.context,
    {
      analysisSensitivity: payload && payload.analysisPolicy ? payload.analysisPolicy.sensitivity : null
    }
  );
}

function buildManagedMessages(payload) {
  return buildOpenAiMessages(payload);
}

function extractProviderTextResponse(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response && response.output) ? response.output : [];
  for (const item of output) {
    const content = item && Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (block && typeof block.text === "string" && block.text.trim()) {
        return block.text.trim();
      }
    }
  }

  const anthropicContent = Array.isArray(response && response.content) ? response.content : [];
  for (const block of anthropicContent) {
    if (block && typeof block.text === "string" && block.text.trim()) {
      return block.text.trim();
    }
  }

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

  throw new Error("Provider response did not contain output text.");
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

function inferFeedbackIsTest(config, payload) {
  if (payload && payload.flags && payload.flags.is_test === true) {
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
    participant_id:
      config && config.managedPilotFeedbackEnabled && typeof config.managedFeedbackParticipantId === "string" && config.managedFeedbackParticipantId.trim()
        ? config.managedFeedbackParticipantId.trim()
        : null,
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

function resolveDirectModel(config, payload = null) {
  const providerSelection = normalizeProviderSelection(config && config.provider ? config.provider : DEFAULT_API_CONFIG.provider);
  if (
    providerSelection === "direct" &&
    config &&
    typeof config.directModel === "string" &&
    config.directModel.trim()
  ) {
    return config.directModel.trim();
  }

  const hostname = getHostnameFromPageUrl(payload && payload.pageUrl ? payload.pageUrl : "");
  const policy =
    config && config.managedModelPolicy && typeof config.managedModelPolicy === "object"
      ? config.managedModelPolicy
      : STATIC_DIRECT_MODEL_POLICY;
  const defaults = policy && typeof policy.default_models_by_surface === "object" ? policy.default_models_by_surface : {};
  return defaults[hostname] || "gpt-5-mini";
}

async function callLocalAnalysis(payload, config, trace = null) {
  if (!config.endpoint) {
    throw new Error("Local analyzer endpoint is missing.");
  }

  const startedAtMs = nowMs();
  const requestBody = {
    ...payload,
    conversation_id: payload.conversationId || null,
    prompt: payload.prompt || "",
    response: payload.response || "",
    page_url: payload.pageUrl || "",
    captured_at: payload.capturedAt || null
  };

  logEvent("info", "Sending local analyzer request", {
    requestId: trace ? trace.requestId : null,
    endpoint: config.endpoint,
    conversationId: payload.conversationId || null
  });

  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Local analyzer returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const rawResponse = await response.json();
  logEvent("info", "Received local analyzer response", {
    requestId: trace ? trace.requestId : null,
    latencyMs: elapsedMs(startedAtMs)
  });
  return normalizeAnalysisResponse(rawResponse, payload);
}

async function testLocalConnection(config) {
  if (!config.endpoint) {
    throw new Error("Local analyzer endpoint is missing.");
  }

  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      conversation_id: "test-connection",
      prompt: "This is a connection test prompt.",
      response: "This is a connection test response."
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Local analyzer returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }
  await response.json();
  return {
    provider: "local",
    message: "Local analyzer responded successfully.",
    details: {
      endpoint: config.endpoint
    }
  };
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
    const analysisPayload = {
      ...payload,
      analysisPolicy: {
        sensitivity: config.analysisSensitivity
      }
    };
    if (setupMode === "basic") {
      const requestBody = {
        model: resolveDirectModel(config, analysisPayload),
        messages: buildManagedMessages(analysisPayload),
        max_tokens: resolveDirectModel(config, analysisPayload) === "gpt-5-mini" ? 1200 : 700,
        max_output_tokens: resolveDirectModel(config, analysisPayload) === "gpt-5-mini" ? 1200 : 700,
        response_format: {
          type: "json_object"
        },
        reasoning: {
          effort: "minimal"
        },
        surface_host: getHostnameFromPageUrl(payload && payload.pageUrl ? payload.pageUrl : ""),
        analysis_policy: analysisPayload.analysisPolicy
      };
      logEvent("info", "Sending managed provider analysis relay request", {
        requestId: trace ? trace.requestId : null,
        relayProvider: "direct",
        model: requestBody.model,
        conversationId: payload.conversationId || null,
        ...extractManagedSessionMetadata(config)
      });
      const managedResult = await callManagedAccessWithSession("managed_provider_analyze", config, {
        analysis_payload: requestBody
      });
      const relayResponse = managedResult.response;
      const rawResponse = relayResponse.raw_response || {};
      const rawText = extractProviderTextResponse(rawResponse);
      logEvent("info", "Received managed provider analysis response", {
        requestId: trace ? trace.requestId : null,
        relayProvider: "direct",
        model: requestBody.model,
        responseChars: rawText.length
      });
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (error) {
        throw new Error(`Managed provider returned non-JSON analysis payload: ${error instanceof Error ? error.message : "parse error"}`);
      }
      result = normalizeAnalysisResponse(parsed, analysisPayload);
    } else {
      result = await getProviderAdapter(provider).analyze(analysisPayload, config, trace);
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
  local: {
    id: "local",
    label: "Local analyzer",
    settingsSections: [],
    analyze: callLocalAnalysis,
    testConnection: testLocalConnection
  },
  direct: {
    id: "direct",
    label: "Safety Nudges direct providers",
    settingsSections: [],
    analyze: async () => {
      throw new Error("Direct provider analysis requires managed activation-code setup.");
    },
    testConnection: testManagedActivationConnection
  }
};

function getProviderAdapter(provider) {
  return PROVIDER_ADAPTERS[normalizeProviderName(provider)] || PROVIDER_ADAPTERS.direct;
}

function getProviderDefinitions() {
  return [
    {
      id: "complementary",
      label: "Complementary provider",
      settingsSections: []
    },
    {
      id: "direct",
      label: "Direct provider",
      settingsSections: []
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
