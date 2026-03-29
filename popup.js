const DEFAULT_CONFIG = {
  provider: "openai",
  enabled: true,
  setupMode: "advanced",
  onboardingComplete: false,
  managedEmail: "",
  managedAccessKey: "",
  managedSessionToken: "",
  managedRefreshToken: "",
  managedSessionExpiresAt: "",
  managedRefreshExpiresAt: "",
  managedAllocationId: "",
  managedProviderProjectId: "",
  openAiApiKey: "",
  openAiModel: "gpt-5-mini",
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-6"
};

const AUTO_SAVE_DELAY_MS = 250;

const onboardingScreenNode = document.getElementById("onboarding-screen");
const basicSetupScreenNode = document.getElementById("basic-setup-screen");
const mainScreenNode = document.getElementById("main-screen");
const advancedScreenNode = document.getElementById("advanced-screen");
const dataUseScreenNode = document.getElementById("data-use-screen");
const chooseBasicSetupButton = document.getElementById("choose-basic-setup");
const chooseAdvancedSetupButton = document.getElementById("choose-advanced-setup");
const backToOnboardingButton = document.getElementById("back-to-onboarding");
const completeBasicSetupButton = document.getElementById("complete-basic-setup");
const openDataUseOnboardingButton = document.getElementById("open-data-use-onboarding");
const openDataUseBasicButton = document.getElementById("open-data-use-basic");
const openDataUseMainButton = document.getElementById("open-data-use-main");
const openDataUseAdvancedButton = document.getElementById("open-data-use-advanced");
const closeDataUseButton = document.getElementById("close-data-use");
const managedEmailNode = document.getElementById("managed-email");
const managedEmailAdvancedNode = document.getElementById("managed-email-advanced");
const managedKeyNode = document.getElementById("managed-key");
const managedKeyAdvancedNode = document.getElementById("managed-key-advanced");
const basicSetupStatusNode = document.getElementById("basic-setup-status");
const providerRadioNodes = Array.from(document.querySelectorAll('input[name="provider-selection"]'));
const testConnectionButton = document.getElementById("test-connection");
const connectionStatusNode = document.getElementById("connection-status");
const toggleEnabledButton = document.getElementById("toggle-enabled");
const toggleDescriptionNode = document.getElementById("toggle-description");
const analysisDisclosureNode = document.getElementById("analysis-disclosure");
const openAdvancedSettingsButton = document.getElementById("open-advanced-settings");
const closeAdvancedSettingsButton = document.getElementById("close-advanced-settings");
const advancedTestConnectionButton = document.getElementById("advanced-test-connection");
const openAiKeyNode = document.getElementById("openai-key");
const openAiModelNode = document.getElementById("openai-model");
const anthropicKeyNode = document.getElementById("anthropic-key");
const anthropicModelNode = document.getElementById("anthropic-model");
const activityLogNode = document.getElementById("activity-log");
const advancedConnectionStatusNode = document.getElementById("advanced-connection-status");
const advancedAnalysisDisclosureNode = document.getElementById("advanced-analysis-disclosure");
const dataUseDescriptionNode = document.getElementById("data-use-description");

const state = {
  config: { ...DEFAULT_CONFIG },
  loaded: false,
  screen: "main",
  previousScreen: "main",
  saveTimer: null,
  isSaving: false,
  isTestingConnection: false,
  activityPollHandle: null,
  activityFastPollHandle: null,
  pendingActivityEntry: null,
  connectionStatus: {
    tone: "muted",
    message: "No connection test run yet."
  },
  advancedConnectionStatus: {
    tone: "muted",
    message: "No advanced connection test run yet."
  },
  basicSetupStatus: {
    tone: "muted",
    message: "No activation attempt run yet."
  }
};

function normalizeLoadedConfig(config) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config || {})
  };

  if (!merged.onboardingComplete) {
    const hasLegacySetup = Boolean(merged.openAiApiKey) || Boolean(merged.anthropicApiKey);
    if (hasLegacySetup) {
      merged.onboardingComplete = true;
      merged.setupMode = merged.setupMode || "advanced";
    }
  }

  return merged;
}

function setConnectionStatus(message, tone = "muted") {
  state.connectionStatus = { message, tone };
  render();
}

function setAdvancedConnectionStatus(message, tone = "muted") {
  state.advancedConnectionStatus = { message, tone };
  render();
}

function setBasicSetupStatus(message, tone = "muted") {
  state.basicSetupStatus = { message, tone };
  render();
}

function setPendingActivity(message, details = null) {
  state.pendingActivityEntry = {
    timestamp: new Date().toISOString(),
    level: "info",
    message,
    details
  };
}

function clearPendingActivity() {
  state.pendingActivityEntry = null;
}

function renderActivityEntries(entries) {
  if (!activityLogNode) {
    return;
  }

  if (!entries || entries.length === 0) {
    activityLogNode.textContent = "No activity logged yet.";
    return;
  }

  activityLogNode.textContent = entries
    .slice(0, 12)
    .map((entry) => {
      const detailText = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
      return `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}${detailText}`;
    })
    .join("\n");
}

function refreshRuntimeStatus() {
  chrome.runtime.sendMessage({ type: "SAFETY_NUDGES_GET_RUNTIME_STATUS" }, (response) => {
    if (!response || !response.ok || !response.runtimeState) {
      return;
    }

    const entries = Array.isArray(response.runtimeState.activityLog) ? response.runtimeState.activityLog : [];
    const visibleEntries = state.pendingActivityEntry ? [state.pendingActivityEntry, ...entries] : entries;
    renderActivityEntries(visibleEntries);
  });
}

function startFastActivityPolling() {
  if (state.activityFastPollHandle) {
    return;
  }

  state.activityFastPollHandle = window.setInterval(refreshRuntimeStatus, 250);
}

function stopFastActivityPolling() {
  if (!state.activityFastPollHandle) {
    return;
  }

  window.clearInterval(state.activityFastPollHandle);
  state.activityFastPollHandle = null;
}

function buildConfigPatch() {
  const selectedProviderNode = providerRadioNodes.find((node) => node.checked);
  return {
    provider: selectedProviderNode ? selectedProviderNode.value : state.config.provider,
    enabled: state.config.enabled,
    setupMode: state.config.setupMode,
    onboardingComplete: state.config.onboardingComplete,
    managedEmail: managedEmailNode ? managedEmailNode.value.trim().toLowerCase() : state.config.managedEmail,
    managedAccessKey: managedKeyNode ? managedKeyNode.value.trim() : state.config.managedAccessKey,
    openAiApiKey: openAiKeyNode ? openAiKeyNode.value.trim() : state.config.openAiApiKey,
    openAiModel: openAiModelNode ? openAiModelNode.value.trim() : state.config.openAiModel,
    anthropicApiKey: anthropicKeyNode ? anthropicKeyNode.value.trim() : state.config.anthropicApiKey,
    anthropicModel: anthropicModelNode ? anthropicModelNode.value.trim() : state.config.anthropicModel
  };
}

function syncFieldIntoState(node) {
  if (!node) {
    return;
  }

  if (node === managedKeyNode) {
    const nextValue = managedKeyNode.value.trim();
    state.config.managedAccessKey = nextValue;
    if (managedKeyAdvancedNode && managedKeyAdvancedNode.value !== nextValue) {
      managedKeyAdvancedNode.value = nextValue;
    }
    return;
  }

  if (node === managedEmailNode) {
    const nextValue = managedEmailNode.value.trim().toLowerCase();
    state.config.managedEmail = nextValue;
    if (managedEmailAdvancedNode && managedEmailAdvancedNode.value !== nextValue) {
      managedEmailAdvancedNode.value = nextValue;
    }
    return;
  }

  if (node === managedEmailAdvancedNode) {
    const nextValue = managedEmailAdvancedNode.value.trim().toLowerCase();
    state.config.managedEmail = nextValue;
    if (managedEmailNode && managedEmailNode.value !== nextValue) {
      managedEmailNode.value = nextValue;
    }
    return;
  }

  if (node === managedKeyAdvancedNode) {
    const nextValue = managedKeyAdvancedNode.value.trim();
    state.config.managedAccessKey = nextValue;
    if (managedKeyNode && managedKeyNode.value !== nextValue) {
      managedKeyNode.value = nextValue;
    }
    return;
  }

  if (node === openAiKeyNode) {
    state.config.openAiApiKey = openAiKeyNode.value.trim();
    return;
  }

  if (node === openAiModelNode) {
    state.config.openAiModel = openAiModelNode.value.trim();
    return;
  }

  if (node === anthropicKeyNode) {
    state.config.anthropicApiKey = anthropicKeyNode.value.trim();
    return;
  }

  if (node === anthropicModelNode) {
    state.config.anthropicModel = anthropicModelNode.value.trim();
    return;
  }

  if (providerRadioNodes.includes(node) && node.checked) {
    state.config.provider = node.value;
  }
}

function applyStateToInputs() {
  if (managedKeyNode) {
    managedKeyNode.value = state.config.managedAccessKey || "";
  }
  if (managedEmailNode) {
    managedEmailNode.value = state.config.managedEmail || "";
  }
  if (managedKeyAdvancedNode) {
    managedKeyAdvancedNode.value = state.config.managedAccessKey || "";
  }
  if (managedEmailAdvancedNode) {
    managedEmailAdvancedNode.value = state.config.managedEmail || "";
  }

  for (const node of providerRadioNodes) {
    node.checked = node.value === state.config.provider;
  }

  if (openAiKeyNode) {
    openAiKeyNode.value = state.config.openAiApiKey || "";
  }
  if (openAiModelNode) {
    openAiModelNode.value = state.config.openAiModel || DEFAULT_CONFIG.openAiModel;
  }
  if (anthropicKeyNode) {
    anthropicKeyNode.value = state.config.anthropicApiKey || "";
  }
  if (anthropicModelNode) {
    anthropicModelNode.value = state.config.anthropicModel || DEFAULT_CONFIG.anthropicModel;
  }
}

function render() {
  applyStateToInputs();

  const onboardingComplete = Boolean(state.config.onboardingComplete);
  const onboardingVisible = !onboardingComplete && state.screen === "onboarding";
  const basicSetupVisible = !onboardingComplete && state.screen === "basic-setup";
  const mainVisible = onboardingComplete && state.screen === "main";
  const advancedVisible = onboardingComplete && state.screen === "advanced";
  const dataUseVisible = state.screen === "data-use";

  if (onboardingScreenNode) {
    onboardingScreenNode.hidden = !onboardingVisible;
  }
  if (basicSetupScreenNode) {
    basicSetupScreenNode.hidden = !basicSetupVisible;
  }
  if (mainScreenNode) {
    mainScreenNode.hidden = !mainVisible;
  }
  if (advancedScreenNode) {
    advancedScreenNode.hidden = !advancedVisible;
  }
  if (dataUseScreenNode) {
    dataUseScreenNode.hidden = !dataUseVisible;
  }

  if (connectionStatusNode) {
    connectionStatusNode.textContent = state.connectionStatus.message;
    connectionStatusNode.dataset.tone = state.connectionStatus.tone;
  }
  if (advancedConnectionStatusNode) {
    advancedConnectionStatusNode.textContent = state.advancedConnectionStatus.message;
    advancedConnectionStatusNode.dataset.tone = state.advancedConnectionStatus.tone;
  }
  if (basicSetupStatusNode) {
    basicSetupStatusNode.textContent = state.basicSetupStatus.message;
    basicSetupStatusNode.dataset.tone = state.basicSetupStatus.tone;
  }

  if (toggleEnabledButton) {
    toggleEnabledButton.dataset.enabled = state.config.enabled ? "true" : "false";
    toggleEnabledButton.textContent = state.config.enabled ? "Pause Safety Nudges" : "Resume Safety Nudges";
    toggleEnabledButton.disabled = !onboardingComplete;
  }

  if (toggleDescriptionNode) {
    toggleDescriptionNode.textContent = state.config.enabled
      ? "Safety Nudges is currently watching supported chat pages."
      : "Safety Nudges is paused and will not analyze chat responses.";
  }

  const analysisDisclosure = buildAnalysisDisclosure(state.config);
  if (analysisDisclosureNode) {
    analysisDisclosureNode.textContent = analysisDisclosure;
  }
  if (advancedAnalysisDisclosureNode) {
    advancedAnalysisDisclosureNode.textContent = analysisDisclosure;
  }
  if (dataUseDescriptionNode) {
    dataUseDescriptionNode.textContent = buildDataUseDescription(state.config);
  }

  if (testConnectionButton) {
    testConnectionButton.disabled = !onboardingComplete || state.isTestingConnection;
    testConnectionButton.textContent = state.isTestingConnection ? "Testing..." : "Test connection";
  }
  if (advancedTestConnectionButton) {
    advancedTestConnectionButton.disabled = !onboardingComplete || state.isTestingConnection;
    advancedTestConnectionButton.textContent = state.isTestingConnection ? "Testing..." : "Test connection";
  }
}

function buildAnalysisDisclosure(config) {
  const setupMode = config && config.setupMode === "basic" ? "basic" : "advanced";
  if (setupMode === "basic") {
    return "When Safety Nudges is on, it sends the latest prompt and response through Safety Nudges managed infrastructure so OpenAI can analyze it.";
  }

  if (config && config.provider === "anthropic") {
    return "When Safety Nudges is on, it sends the latest prompt and response to Anthropic for analysis.";
  }

  if (config && config.provider === "complementary") {
    return "When Safety Nudges is on, it sends the latest prompt and response to Anthropic on chatgpt.com and to OpenAI on claude.ai.";
  }

  return "When Safety Nudges is on, it sends the latest prompt and response to OpenAI for analysis.";
}

function buildDataUseDescription(config) {
  const analysisDisclosure = buildAnalysisDisclosure(config);
  const managedClause =
    config && config.setupMode === "basic"
      ? " Safety Nudges managed access uses a scoped session token after onboarding, so ordinary analysis requests do not resend your activation code."
      : "";

  return `${analysisDisclosure}${managedClause} Feedback is optional, and chat history only reaches the Safety Nudges database if you explicitly submit feedback and opt in to share it.`;
}

function saveConfig(configPatch, options = {}) {
  const nextConfig = {
    ...state.config,
    ...configPatch
  };

  state.config = nextConfig;
  render();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "SAFETY_NUDGES_SET_API_CONFIG",
        config: nextConfig
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response || !response.ok) {
          reject(new Error("Could not save settings."));
          return;
        }
        resolve(nextConfig);
      }
    );
  });
}

function scheduleAutoSave() {
  if (!state.loaded) {
    return;
  }

  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
  }

  state.saveTimer = window.setTimeout(() => {
    state.saveTimer = null;
    state.isSaving = true;
    void saveConfig(buildConfigPatch())
      .catch((_error) => {})
      .finally(() => {
        state.isSaving = false;
      });
  }, AUTO_SAVE_DELAY_MS);
}

async function flushPendingSave() {
  if (state.saveTimer) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }

  return saveConfig(buildConfigPatch());
}

function openAdvancedScreen() {
  state.previousScreen = state.screen;
  state.screen = "advanced";
  render();
}

function openMainScreen() {
  state.screen = "main";
  render();
}

function openOnboardingScreen() {
  state.screen = "onboarding";
  render();
}

function openBasicSetupScreen() {
  state.config = {
    ...state.config,
    setupMode: "basic"
  };
  state.previousScreen = state.screen;
  state.screen = "basic-setup";
  render();
}

function openDataUseScreen() {
  state.previousScreen = state.screen;
  state.screen = "data-use";
  render();
}

function closeDataUseScreen() {
  state.screen = state.previousScreen || (state.config.onboardingComplete ? "main" : "onboarding");
  render();
}

async function reloadConfigAndRoute() {
  const refreshedConfig = await loadConfigFromBackground();
  state.config = normalizeLoadedConfig(refreshedConfig);
  state.screen = state.config.onboardingComplete ? "main" : "onboarding";
  render();
}

async function handleManagedSessionInvalidation() {
  await reloadConfigAndRoute();
  setBasicSetupStatus("Enter your activation email and code to reconnect managed access.", "muted");
}

function handleConnectionTestResult(response) {
  const result = response && response.result ? response.result : null;
  if (response && response.ok && result) {
    setConnectionStatus(`✅ ${result.message || "Connection test succeeded."}`, "success");
    return;
  }

  if (result && result.message) {
    setConnectionStatus(`❌ ${result.message}`, "error");
    return;
  }

  setConnectionStatus("❌ Connection test failed. The provider did not accept this request.", "error");
}

function sendConnectionTestRequest(config) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "SAFETY_NUDGES_TEST_CONNECTION",
        config
      },
      (response) => {
        resolve({
          response,
          runtimeError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null
        });
      }
    );
  });
}

function loadConfigFromBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SAFETY_NUDGES_GET_API_CONFIG" }, (response) => {
      resolve(response && response.ok && response.config ? response.config : DEFAULT_CONFIG);
    });
  });
}

async function runMainConnectionTest() {
  state.isTestingConnection = true;
  render();
  setPendingActivity("Connection test started", {
    provider: state.config.provider,
    setupMode: state.config.setupMode
  });
  setConnectionStatus("Testing connection...", "muted");
  startFastActivityPolling();

  try {
    await flushPendingSave();
  } catch (error) {
    clearPendingActivity();
    stopFastActivityPolling();
    state.isTestingConnection = false;
    render();
    setConnectionStatus(
      `❌ Could not save settings before testing: ${error instanceof Error ? error.message : "Unknown error"}`,
      "error"
    );
    refreshRuntimeStatus();
    return;
  }

  const { response, runtimeError } = await sendConnectionTestRequest(state.config);
  clearPendingActivity();
  stopFastActivityPolling();
  state.isTestingConnection = false;
  render();

  if (runtimeError) {
    setConnectionStatus(`❌ Connection test failed. ${runtimeError}`, "error");
    refreshRuntimeStatus();
    return;
  }

  if (response && response.result && response.result.reasonCode === "managed_session_invalid") {
    await handleManagedSessionInvalidation();
  }

  handleConnectionTestResult(response);
  refreshRuntimeStatus();
}

async function runAdvancedConnectionTest() {
  state.isTestingConnection = true;
  render();
  setPendingActivity("Advanced connection test started", {
    setupMode: state.config.setupMode
  });
  setAdvancedConnectionStatus("Testing configured credentials...", "muted");
  startFastActivityPolling();

  try {
    await flushPendingSave();
  } catch (error) {
    clearPendingActivity();
    stopFastActivityPolling();
    state.isTestingConnection = false;
    render();
    setAdvancedConnectionStatus(
      `❌ Could not save settings before testing: ${error instanceof Error ? error.message : "Unknown error"}`,
      "error"
    );
    refreshRuntimeStatus();
    return;
  }

  const checks = [];
  if ((state.config.managedAccessKey || "").trim() && (state.config.managedEmail || "").trim()) {
    checks.push({
      label: "Safety Nudges managed access",
      config: {
        ...state.config,
        setupMode: "basic",
        onboardingComplete: true
      }
    });
  } else if ((state.config.managedSessionToken || "").trim() && (state.config.managedRefreshToken || "").trim()) {
    checks.push({
      label: "Safety Nudges managed session",
      config: {
        ...state.config,
        setupMode: "basic",
        onboardingComplete: true
      }
    });
  }
  if ((state.config.openAiApiKey || "").trim()) {
    checks.push({
      label: "OpenAI",
      config: {
        ...state.config,
        setupMode: "advanced",
        provider: "openai",
        onboardingComplete: true
      }
    });
  }
  if ((state.config.anthropicApiKey || "").trim()) {
    checks.push({
      label: "Anthropic",
      config: {
        ...state.config,
        setupMode: "advanced",
        provider: "anthropic",
        onboardingComplete: true
      }
    });
  }

  if (checks.length === 0) {
    clearPendingActivity();
    stopFastActivityPolling();
    state.isTestingConnection = false;
    render();
    setAdvancedConnectionStatus("❌ No managed session, activation email + code, or API keys are available to test.", "error");
    return;
  }

  const successes = [];
  for (const check of checks) {
    const { response, runtimeError } = await sendConnectionTestRequest(check.config);
    if (runtimeError) {
      clearPendingActivity();
      stopFastActivityPolling();
      state.isTestingConnection = false;
      render();
      setAdvancedConnectionStatus(`❌ ${check.label}: ${runtimeError}`, "error");
      refreshRuntimeStatus();
      return;
    }

    if (!response || !response.ok) {
      const message =
        response && response.result && response.result.message
          ? response.result.message
          : response && response.error
            ? response.error
            : "Connection test failed.";
      if (response && response.result && response.result.reasonCode === "managed_session_invalid") {
        await handleManagedSessionInvalidation();
      }
      clearPendingActivity();
      stopFastActivityPolling();
      state.isTestingConnection = false;
      render();
      setAdvancedConnectionStatus(`❌ ${check.label}: ${message}`, "error");
      refreshRuntimeStatus();
      return;
    }

    successes.push(check.label);
  }

  clearPendingActivity();
  stopFastActivityPolling();
  state.isTestingConnection = false;
  render();
  setAdvancedConnectionStatus(`✅ ${successes.join(", ")} passed connection tests.`, "success");
  refreshRuntimeStatus();
}

function chooseAdvancedSetup() {
  state.config = {
    ...state.config,
    setupMode: "advanced",
    onboardingComplete: true
  };
  state.screen = "advanced";
  render();
  void saveConfig(state.config).catch((_error) => {});
}

function chooseBasicSetup() {
  openBasicSetupScreen();
}

async function completeBasicSetup() {
  const accessKey = managedKeyNode ? managedKeyNode.value.trim() : "";
  const managedEmail = managedEmailNode ? managedEmailNode.value.trim().toLowerCase() : "";
  if (!managedEmail || !accessKey) {
    setBasicSetupStatus("❌ Enter both the activation email and activation code.", "error");
    return;
  }

  state.isTestingConnection = true;
  render();
  setPendingActivity("Managed activation exchange started", {
    setupMode: "basic"
  });
  setBasicSetupStatus("Activating managed access...", "muted");
  startFastActivityPolling();

  const onboardingConfig = {
    ...state.config,
    setupMode: "basic",
    onboardingComplete: true,
    managedEmail,
    managedAccessKey: accessKey
  };
  const { response, runtimeError } = await sendConnectionTestRequest(onboardingConfig);

  clearPendingActivity();
  stopFastActivityPolling();
  state.isTestingConnection = false;

  if (runtimeError) {
    render();
    setBasicSetupStatus(`❌ Activation failed. ${runtimeError}`, "error");
    refreshRuntimeStatus();
    return;
  }

  if (!response || !response.ok) {
    const message =
      response && response.result && response.result.message
        ? response.result.message
        : response && response.error
          ? response.error
          : "Activation failed.";
    render();
    setBasicSetupStatus(`❌ ${message}`, "error");
    refreshRuntimeStatus();
    return;
  }

  const refreshedConfig = await loadConfigFromBackground();
  state.config = normalizeLoadedConfig(refreshedConfig);
  state.screen = "main";
  render();
  setConnectionStatus(`✅ ${response.result && response.result.message ? response.result.message : "Managed access is ready."}`, "success");
  setBasicSetupStatus("✅ Managed access is ready.", "success");
  refreshRuntimeStatus();
}

function attachFieldAutoSave(node, eventName = "input") {
  if (!node) {
    return;
  }

  node.addEventListener(eventName, () => {
    syncFieldIntoState(node);
    scheduleAutoSave();
  });
}

void loadConfigFromBackground()
  .then((loadedConfig) => {
    state.config = normalizeLoadedConfig(loadedConfig);
    state.loaded = true;
    state.screen = state.config.onboardingComplete ? "main" : "onboarding";
    render();
    refreshRuntimeStatus();
  })
  .catch(() => {
    state.config = { ...DEFAULT_CONFIG };
    state.loaded = true;
    state.screen = "onboarding";
    render();
    refreshRuntimeStatus();
  });

providerRadioNodes.forEach((node) => {
  attachFieldAutoSave(node, "change");
});

attachFieldAutoSave(openAiKeyNode);
attachFieldAutoSave(openAiModelNode);
attachFieldAutoSave(anthropicKeyNode);
attachFieldAutoSave(anthropicModelNode);
attachFieldAutoSave(managedEmailNode);
attachFieldAutoSave(managedEmailAdvancedNode);
attachFieldAutoSave(managedKeyNode);
attachFieldAutoSave(managedKeyAdvancedNode);

if (chooseBasicSetupButton) {
  chooseBasicSetupButton.addEventListener("click", chooseBasicSetup);
}

if (chooseAdvancedSetupButton) {
  chooseAdvancedSetupButton.addEventListener("click", chooseAdvancedSetup);
}

if (backToOnboardingButton) {
  backToOnboardingButton.addEventListener("click", openOnboardingScreen);
}

if (completeBasicSetupButton) {
  completeBasicSetupButton.addEventListener("click", completeBasicSetup);
}

if (openAdvancedSettingsButton) {
  openAdvancedSettingsButton.addEventListener("click", openAdvancedScreen);
}

if (openDataUseOnboardingButton) {
  openDataUseOnboardingButton.addEventListener("click", openDataUseScreen);
}

if (openDataUseBasicButton) {
  openDataUseBasicButton.addEventListener("click", openDataUseScreen);
}

if (openDataUseMainButton) {
  openDataUseMainButton.addEventListener("click", openDataUseScreen);
}

if (openDataUseAdvancedButton) {
  openDataUseAdvancedButton.addEventListener("click", openDataUseScreen);
}

if (closeDataUseButton) {
  closeDataUseButton.addEventListener("click", closeDataUseScreen);
}

if (closeAdvancedSettingsButton) {
  closeAdvancedSettingsButton.addEventListener("click", openMainScreen);
}

if (toggleEnabledButton) {
  toggleEnabledButton.addEventListener("click", () => {
    state.config = {
      ...state.config,
      enabled: !state.config.enabled
    };
    render();
    void saveConfig(state.config).catch((_error) => {});
  });
}

if (testConnectionButton) {
  testConnectionButton.addEventListener("click", () => {
    if (!state.loaded) {
      return;
    }

    void runMainConnectionTest();
  });
}

if (advancedTestConnectionButton) {
  advancedTestConnectionButton.addEventListener("click", () => {
    if (!state.loaded) {
      return;
    }

    void runAdvancedConnectionTest();
  });
}

refreshRuntimeStatus();
state.activityPollHandle = window.setInterval(refreshRuntimeStatus, 1500);

window.addEventListener("unload", () => {
  if (state.activityPollHandle) {
    window.clearInterval(state.activityPollHandle);
  }
  stopFastActivityPolling();
});
