const statusNode = document.getElementById("status");
const providerNode = document.getElementById("provider");
const openAiKeyNode = document.getElementById("openai-key");
const openAiModelNode = document.getElementById("openai-model");
const localEndpointNode = document.getElementById("endpoint");
const ollamaEndpointNode = document.getElementById("ollama-endpoint");
const ollamaModelNode = document.getElementById("ollama-model");
const enabledNode = document.getElementById("enabled");
const identifySpansNode = document.getElementById("identify-spans");
const saveButton = document.getElementById("save");
const testConnectionButton = document.getElementById("test-connection");
const activityLogNode = document.getElementById("activity-log");

let activityPollHandle = null;
let activityFastPollHandle = null;
let hasLoadedConfig = false;
let hasUserEditedForm = false;
let pendingActivityEntry = null;

const formNodes = [
  providerNode,
  openAiKeyNode,
  openAiModelNode,
  localEndpointNode,
  ollamaEndpointNode,
  ollamaModelNode,
  enabledNode,
  identifySpansNode
].filter(Boolean);

function setStatus(message) {
  if (statusNode) {
    statusNode.textContent = message;
  }
}

function setButtonBusy(buttonNode, isBusy, idleLabel, busyLabel) {
  if (!buttonNode) {
    return;
  }

  buttonNode.disabled = isBusy;
  buttonNode.textContent = isBusy ? busyLabel : idleLabel;
}

function setActionButtonsEnabled(enabled) {
  if (saveButton) {
    saveButton.disabled = !enabled;
  }

  if (testConnectionButton) {
    testConnectionButton.disabled = !enabled;
  }
}

function markFormDirty() {
  hasUserEditedForm = true;
}

function clearPendingActivity() {
  pendingActivityEntry = null;
}

function setPendingActivity(message, details = null) {
  pendingActivityEntry = {
    timestamp: new Date().toISOString(),
    level: "info",
    message,
    details
  };
}

function startFastActivityPolling() {
  if (activityFastPollHandle) {
    return;
  }

  activityFastPollHandle = window.setInterval(refreshRuntimeStatus, 250);
}

function stopFastActivityPolling() {
  if (!activityFastPollHandle) {
    return;
  }

  window.clearInterval(activityFastPollHandle);
  activityFastPollHandle = null;
}

function renderActivity(runtimeState) {
  if (!activityLogNode || !runtimeState) {
    return;
  }

  const entries = Array.isArray(runtimeState.activityLog) ? runtimeState.activityLog : [];
  const visibleEntries = pendingActivityEntry ? [pendingActivityEntry, ...entries] : entries;
  if (visibleEntries.length === 0) {
    activityLogNode.textContent = "No activity logged yet.";
    return;
  }

  renderActivityEntries(visibleEntries);
}

function renderActivityEntries(entries) {
  if (!activityLogNode) {
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
    if (!activityLogNode) {
      return;
    }

    if (!response || !response.ok || !response.runtimeState) {
      return;
    }

    const entries = Array.isArray(response.runtimeState.activityLog) ? response.runtimeState.activityLog : [];
    const visibleEntries = pendingActivityEntry ? [pendingActivityEntry, ...entries] : entries;

    if (visibleEntries.length === 0) {
      activityLogNode.textContent = "No activity logged yet.";
      return;
    }

    renderActivityEntries(visibleEntries);
  });
}

function collectConfigFromForm() {
  return {
    provider: providerNode ? providerNode.value : "openai",
    openAiApiKey: openAiKeyNode ? openAiKeyNode.value.trim() : "",
    openAiModel: openAiModelNode ? openAiModelNode.value.trim() : "",
    endpoint: localEndpointNode ? localEndpointNode.value.trim() : "",
    ollamaEndpoint: ollamaEndpointNode ? ollamaEndpointNode.value.trim() : "",
    ollamaModel: ollamaModelNode ? ollamaModelNode.value.trim() : "",
    enabled: enabledNode ? enabledNode.checked : false,
    identifySpans: identifySpansNode ? identifySpansNode.checked : true
  };
}

function applyConfigToForm(config) {
  if (!config || typeof config !== "object") {
    return;
  }

  if (providerNode) {
    providerNode.value = config.provider || "openai";
  }

  if (openAiKeyNode) {
    openAiKeyNode.value = config.openAiApiKey || "";
  }

  if (openAiModelNode) {
    openAiModelNode.value = config.openAiModel || "gpt-5-mini";
  }

  if (localEndpointNode) {
    localEndpointNode.value = config.endpoint || "";
  }

  if (ollamaEndpointNode) {
    ollamaEndpointNode.value = config.ollamaEndpoint || "http://127.0.0.1:11434/api/chat";
  }

  if (ollamaModelNode) {
    ollamaModelNode.value = config.ollamaModel || "llama3.1:8b";
  }

  if (enabledNode) {
    enabledNode.checked = Boolean(config.enabled);
  }

  if (identifySpansNode) {
    identifySpansNode.checked = config.identifySpans !== false;
  }
}

function saveConfig(config) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "SAFETY_NUDGES_SET_API_CONFIG",
        config
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (response && response.ok) {
          hasUserEditedForm = false;
          resolve();
          return;
        }

        reject(new Error("Could not save analysis settings."));
      }
    );
  });
}

formNodes.forEach((node) => {
  const eventName = node === enabledNode || node === providerNode ? "change" : "input";
  node.addEventListener(eventName, markFormDirty);
});

setActionButtonsEnabled(false);
setStatus("Loading saved settings...");

chrome.runtime.sendMessage({ type: "SAFETY_NUDGES_PING" }, (response) => {
  if (response && response.ok) {
    if (!hasLoadedConfig) {
      return;
    }

    setStatus("Shell ready. Configure analysis below. Activity logs update live while this popup is open.");
    return;
  }

  setStatus("Background service worker did not respond.");
});

chrome.runtime.sendMessage({ type: "SAFETY_NUDGES_GET_API_CONFIG" }, (response) => {
  if (!response || !response.ok || !response.config) {
    hasLoadedConfig = true;
    setActionButtonsEnabled(true);
    setStatus("Could not load saved settings. Using the current form values.");
    return;
  }

  if (!hasUserEditedForm) {
    applyConfigToForm(response.config);
    hasUserEditedForm = false;
  }

  hasLoadedConfig = true;
  setActionButtonsEnabled(true);
  setStatus("Shell ready. Configure analysis below. Activity logs update live while this popup is open.");
});

if (saveButton) {
  saveButton.addEventListener("click", () => {
    if (!hasLoadedConfig) {
      setStatus("Settings are still loading. Try again in a moment.");
      return;
    }

    setButtonBusy(saveButton, true, "Save settings", "Saving...");
    if (testConnectionButton) {
      testConnectionButton.disabled = true;
    }

    void saveConfig(collectConfigFromForm())
      .then(() => {
        setButtonBusy(saveButton, false, "Save settings", "Saving...");
        if (testConnectionButton) {
          testConnectionButton.disabled = false;
        }
        setStatus("Analysis settings saved.");
        refreshRuntimeStatus();
      })
      .catch((error) => {
        setButtonBusy(saveButton, false, "Save settings", "Saving...");
        if (testConnectionButton) {
          testConnectionButton.disabled = false;
        }
        setStatus(`Could not save analysis settings: ${error instanceof Error ? error.message : "Unknown error"}`);
      });
  });
}

if (testConnectionButton) {
  testConnectionButton.addEventListener("click", async () => {
    if (!hasLoadedConfig) {
      setStatus("Settings are still loading. Try again in a moment.");
      return;
    }

    const currentConfig = collectConfigFromForm();
    const provider = currentConfig.provider || "openai";
    const shouldSaveFirst = hasUserEditedForm;
    setPendingActivity("Connection test started", {
      provider,
      savedSettings: shouldSaveFirst
    });
    setStatus(shouldSaveFirst ? "Saving settings and testing connection..." : "Testing connection...");
    renderActivity({
      activityLog: []
    });
    setButtonBusy(testConnectionButton, true, "Test connection", "Testing...");
    if (saveButton) {
      saveButton.disabled = true;
    }
    startFastActivityPolling();
    refreshRuntimeStatus();

    try {
      await saveConfig(currentConfig);
    } catch (error) {
      clearPendingActivity();
      stopFastActivityPolling();
      setButtonBusy(testConnectionButton, false, "Test connection", "Testing...");
      if (saveButton) {
        saveButton.disabled = false;
      }
      setStatus(`Could not save analysis settings: ${error instanceof Error ? error.message : "Unknown error"}`);
      refreshRuntimeStatus();
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "SAFETY_NUDGES_TEST_CONNECTION",
        config: currentConfig
      },
      (response) => {
        clearPendingActivity();
        stopFastActivityPolling();
        setButtonBusy(testConnectionButton, false, "Test connection", "Testing...");
        if (saveButton) {
          saveButton.disabled = false;
        }

        if (chrome.runtime.lastError) {
          setStatus(`Connection test failed: ${chrome.runtime.lastError.message}`);
          refreshRuntimeStatus();
          return;
        }

        refreshRuntimeStatus();

        if (response && response.ok && response.result) {
          setStatus(response.result.message || "Connection test succeeded.");
          return;
        }

        setStatus(`Connection test failed: ${response && response.error ? response.error : "Unknown error"}`);
      }
    );
  });
}

refreshRuntimeStatus();
activityPollHandle = window.setInterval(refreshRuntimeStatus, 1500);

window.addEventListener("unload", () => {
  if (activityPollHandle) {
    window.clearInterval(activityPollHandle);
  }

  stopFastActivityPolling();
});
