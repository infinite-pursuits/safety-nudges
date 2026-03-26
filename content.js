const ROOT_ID = "safety-nudges-root";
const QUIET_PERIOD_MS = 1500;
const COMPLETION_POLL_MS = 1000;
const ANALYSIS_RESPONSE_TIMEOUT_MS = 30000;
const ANALYSIS_ATTEMPT_TIMEOUT_MS = 4000;
const MAX_ANALYSIS_ATTEMPTS = 8;
const STALE_ANALYSIS_RETRY_MS = 5000;
const FEEDBACK_COMMENT_MAX_CHARS = 280;
const FEEDBACK_SCHEMA_VERSION = "1.0.0";
const FEEDBACK_DISCLOSURE_VERSION = "2026-03-10";
const FEEDBACK_SUBMIT_EVENT = "judgment_feedback_submitted";
const FEEDBACK_FAILURE_EVENT = "judgment_feedback_failed";
const ANONYMOUS_CONVERSATION_STORAGE_KEY = "safety_nudges_anonymous_conversation_id";
const CLAUDE_CONVERSATION_STORAGE_KEY = "safety_nudges_claude_conversation_id";
const TURN_NODE_SELECTOR = "[data-message-author-role]";
const FIXTURE_SURFACE_META_SELECTOR = 'meta[name="safety-nudges-surface"]';

const state = {
  observer: null,
  analyzeTimer: null,
  completionPollTimer: null,
  lastMutationAt: 0,
  nextTooltipId: 0,
  floatingTooltipNode: null,
  analysesByFingerprint: new Map(),
  feedbackByFingerprint: new Map(),
  payloadByFingerprint: new Map(),
  outsideClickInstalled: false,
  viewportListenersInstalled: false,
  extensionRecoveryAttempted: false,
  analysisEnabled: true
};

function isLocalFixtureHost() {
  return window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
}

function getFixtureSurfaceType() {
  const root = document.documentElement;
  const dataValue =
    root && root.dataset && typeof root.dataset.safetyNudgesSurface === "string" ? root.dataset.safetyNudgesSurface : "";
  const meta = document.querySelector(FIXTURE_SURFACE_META_SELECTOR);
  const metaValue = meta && typeof meta.content === "string" ? meta.content : "";
  const surface = (dataValue || metaValue || "chatgpt").trim().toLowerCase();
  return surface === "claude" ? "claude" : "chatgpt";
}

function getFixtureConversationId() {
  const fixtureRoot = document.documentElement;
  const fixtureConversationId =
    (fixtureRoot &&
      fixtureRoot.dataset &&
      typeof fixtureRoot.dataset.safetyNudgesConversationId === "string" &&
      fixtureRoot.dataset.safetyNudgesConversationId.trim()) ||
    (document.querySelector('meta[name="safety-nudges-conversation-id"]') || {}).content ||
    "";
  if (fixtureConversationId) {
    return fixtureConversationId;
  }

  const pathParts = window.location.pathname.split("/").filter(Boolean);
  return pathParts.length > 0 ? pathParts.at(-1) || null : null;
}

function createChatGptSurfaceAdapter() {
  return {
    id: "chatgpt",
    matches() {
      return window.location.hostname === "chatgpt.com" || window.location.hostname === "chat.openai.com";
    },
    getConversationContainer() {
      return document.querySelector("main");
    },
    getResponseMountNode(responseNode) {
      return responseNode;
    },
    getTurnNodes(role) {
      return Array.from(document.querySelectorAll(`${TURN_NODE_SELECTOR}[data-message-author-role="${role}"]`));
    },
    getTranscriptEntries() {
      return Array.from(document.querySelectorAll(TURN_NODE_SELECTOR))
        .map((node) => ({
          role: node.getAttribute("data-message-author-role"),
          node
        }))
        .filter((entry) => entry.role === "user" || entry.role === "assistant");
    },
    getTurnText(node) {
      return getGenericNodeText(node);
    },
    getConversationId() {
      const pathParts = window.location.pathname.split("/").filter(Boolean);
      if (pathParts.length > 0) {
        return pathParts.at(-1) || null;
      }

      try {
        const existingId = window.sessionStorage.getItem(ANONYMOUS_CONVERSATION_STORAGE_KEY);
        if (existingId && existingId.trim()) {
          return existingId.trim();
        }

        const generatedId = `chatgpt-anon-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        window.sessionStorage.setItem(ANONYMOUS_CONVERSATION_STORAGE_KEY, generatedId);
        return generatedId;
      } catch (_error) {
        return `chatgpt-anon-${Date.now()}`;
      }
    },
    isGenerationInProgress() {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.some((button) => {
        const label = (button.getAttribute("aria-label") || button.innerText || "").trim().toLowerCase();
        return label.includes("stop generating") || label === "stop";
      });
    }
  };
}

function createFixtureSurfaceAdapter() {
  return {
    id: "fixture",
    matches() {
      if (!isLocalFixtureHost()) {
        return false;
      }

      if (!window.location.pathname.startsWith("/fixtures/")) {
        return false;
      }

      const root = document.documentElement;
      return Boolean(
        (root && root.dataset && root.dataset.safetyNudgesFixture === "true") ||
          document.querySelector('meta[name="safety-nudges-fixture"][content="true"]')
      );
    },
    getConversationContainer() {
      if (getFixtureSurfaceType() === "claude") {
        const inputContainer = document.querySelector('[data-chat-input-container="true"]');
        return (inputContainer && inputContainer.parentElement) || document.querySelector("main");
      }

      return document.querySelector("main");
    },
    getResponseMountNode(responseNode) {
      if (getFixtureSurfaceType() === "claude") {
        return responseNode ? responseNode.querySelector(".font-claude-response") || responseNode : responseNode;
      }

      return responseNode;
    },
    getTurnNodes(role) {
      if (getFixtureSurfaceType() === "claude") {
        if (role === "user") {
          return Array.from(document.querySelectorAll('[data-testid="user-message"]'));
        }
        if (role === "assistant") {
          return Array.from(document.querySelectorAll("div[data-is-streaming]"));
        }
        return [];
      }

      return Array.from(document.querySelectorAll(`${TURN_NODE_SELECTOR}[data-message-author-role="${role}"]`));
    },
    getTranscriptEntries() {
      if (getFixtureSurfaceType() === "claude") {
        return Array.from(document.querySelectorAll('[data-testid="user-message"], div[data-is-streaming]'))
          .map((node) => ({
            role: node.matches('[data-testid="user-message"]') ? "user" : "assistant",
            node
          }))
          .filter((entry) => entry.role === "user" || entry.role === "assistant");
      }

      return Array.from(document.querySelectorAll(TURN_NODE_SELECTOR))
        .map((node) => ({
          role: node.getAttribute("data-message-author-role"),
          node
        }))
        .filter((entry) => entry.role === "user" || entry.role === "assistant");
    },
    getTurnText(node, role) {
      if (getFixtureSurfaceType() === "claude" && role === "assistant") {
        return getClaudeAssistantText(node);
      }

      return getGenericNodeText(node);
    },
    getConversationId() {
      return getFixtureConversationId();
    },
    isGenerationInProgress() {
      return getFixtureSurfaceType() === "claude"
        ? Boolean(document.querySelector('div[data-is-streaming="true"]'))
        : false;
    }
  };
}

function createClaudeSurfaceAdapter() {
  return {
    id: "claude",
    matches() {
      return window.location.hostname === "claude.ai";
    },
    getConversationContainer() {
      const inputContainer = document.querySelector('[data-chat-input-container="true"]');
      if (inputContainer && inputContainer.previousElementSibling instanceof Element) {
        return inputContainer.previousElementSibling;
      }

      return (inputContainer && inputContainer.parentElement) || document.querySelector("main");
    },
    getResponseMountNode(responseNode) {
      return responseNode ? responseNode.querySelector(".font-claude-response") || responseNode : responseNode;
    },
    getTurnNodes(role) {
      if (role === "user") {
        return Array.from(document.querySelectorAll('[data-testid="user-message"]'));
      }
      if (role === "assistant") {
        return Array.from(document.querySelectorAll("div[data-is-streaming]"));
      }
      return [];
    },
    getTranscriptEntries() {
      return Array.from(document.querySelectorAll('[data-testid="user-message"], div[data-is-streaming]'))
        .map((node) => ({
          role: node.matches('[data-testid="user-message"]') ? "user" : "assistant",
          node
        }))
        .filter((entry) => entry.role === "user" || entry.role === "assistant");
    },
    getTurnText(node, role) {
      if (role === "assistant") {
        return getClaudeAssistantText(node);
      }

      return getGenericNodeText(node);
    },
    getConversationId() {
      const pathParts = window.location.pathname.split("/").filter(Boolean);
      const lastPathPart = pathParts.length > 0 ? pathParts.at(-1) || null : null;
      if (lastPathPart && lastPathPart !== "new") {
        return lastPathPart;
      }

      try {
        const existingId = window.sessionStorage.getItem(CLAUDE_CONVERSATION_STORAGE_KEY);
        if (existingId && existingId.trim()) {
          return existingId.trim();
        }

        const generatedId = `claude-session-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        window.sessionStorage.setItem(CLAUDE_CONVERSATION_STORAGE_KEY, generatedId);
        return generatedId;
      } catch (_error) {
        return `claude-session-${Date.now()}`;
      }
    },
    isIgnoredMutationNode(node) {
      if (!(node instanceof Element)) {
        return false;
      }

      return Boolean(
        node.closest('[data-chat-input-container="true"]') ||
          node.closest('[role="group"][aria-label="Message actions"]')
      );
    },
    isGenerationInProgress() {
      return Boolean(document.querySelector('div[data-is-streaming="true"]'));
    },
    shouldUseCompletionPoller() {
      return true;
    }
  };
}

const SURFACE_ADAPTERS = [createFixtureSurfaceAdapter(), createClaudeSurfaceAdapter(), createChatGptSurfaceAdapter()];
let activeSurfaceAdapter = null;

function getActiveSurfaceAdapter() {
  if (activeSurfaceAdapter && activeSurfaceAdapter.matches()) {
    return activeSurfaceAdapter;
  }

  activeSurfaceAdapter = SURFACE_ADAPTERS.find((adapter) => adapter.matches()) || null;
  return activeSurfaceAdapter;
}

function isSupportedSurface() {
  return Boolean(getActiveSurfaceAdapter());
}

function formatLabel(value) {
  if (!value || typeof value !== "string") {
    return "Issue";
  }

  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getIssueCount(result) {
  return Array.isArray(result && result.issues) ? result.issues.length : 0;
}

function getEvidenceSpanCount(result) {
  const issues = Array.isArray(result && result.issues) ? result.issues : [];
  return issues.reduce(
    (total, issue) => total + (Array.isArray(issue && issue.evidenceSpans) ? issue.evidenceSpans.length : 0),
    0
  );
}

function inferSeverityFromResult(result) {
  const issues = Array.isArray(result && result.issues) ? result.issues : [];
  if (issues.length === 0) {
    return "none";
  }

  return issues.some((issue) => issue && issue.severity === "high") ? "high" : "low";
}

function buildCompletionMessage(result) {
  const issueCount = getIssueCount(result);
  if (issueCount === 0) {
    return "No issues detected.";
  }

  return `${issueCount} issue${issueCount === 1 ? "" : "s"} detected.`;
}

function getConversationContainer() {
  const adapter = getActiveSurfaceAdapter();
  return adapter ? adapter.getConversationContainer() : null;
}

function getTurnNodes(role) {
  const adapter = getActiveSurfaceAdapter();
  return adapter ? adapter.getTurnNodes(role) : [];
}

function getLastTurnNode(role) {
  const nodes = getTurnNodes(role);
  return nodes.at(-1) || null;
}

function unwrapCloneNode(node) {
  const parent = node.parentNode;
  if (!parent) {
    return;
  }

  while (node.firstChild) {
    parent.insertBefore(node.firstChild, node);
  }
  parent.removeChild(node);
}

function getGenericNodeText(node) {
  if (!node) {
    return "";
  }

  const clone = node.cloneNode(true);
  const injectedUi = Array.from(clone.querySelectorAll(".safety-nudges-response-anchor"));
  for (const injectedNode of injectedUi) {
    injectedNode.remove();
  }

  const inlineHighlights = Array.from(clone.querySelectorAll(".safety-nudges-inline-highlight"));
  for (const highlight of inlineHighlights) {
    unwrapCloneNode(highlight);
  }

  return clone.innerText.replace(/\s+/g, " ").trim();
}

function getClaudeAssistantText(node) {
  if (!node) {
    return "";
  }

  const blocks = Array.from(node.querySelectorAll(".font-claude-response-body"));
  if (blocks.length > 0) {
    return blocks
      .map((block) => {
        if (!(block instanceof HTMLElement)) {
          return "";
        }
        return block.innerText.replace(/\s+/g, " ").trim();
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  return getGenericNodeText(node);
}

function getNodeText(node, role = null) {
  const adapter = getActiveSurfaceAdapter();
  if (adapter && typeof adapter.getTurnText === "function") {
    return adapter.getTurnText(node, role);
  }

  return getGenericNodeText(node);
}

function getLastTurnText(role) {
  return getNodeText(getLastTurnNode(role), role);
}

function getTranscriptEntries() {
  const adapter = getActiveSurfaceAdapter();
  return adapter && typeof adapter.getTranscriptEntries === "function" ? adapter.getTranscriptEntries() : [];
}

function getLatestPromptResponsePair() {
  const transcriptEntries = getTranscriptEntries();
  if (transcriptEntries.length < 2) {
    return null;
  }

  const responseEntry = transcriptEntries.at(-1) || null;
  const promptEntry = transcriptEntries.at(-2) || null;
  if (!responseEntry || !promptEntry) {
    return null;
  }

  if (promptEntry.role !== "user" || responseEntry.role !== "assistant") {
    return null;
  }

  return {
    promptNode: promptEntry.node || null,
    prompt: getNodeText(promptEntry.node || null, "user"),
    responseNode: responseEntry.node || null,
    response: getNodeText(responseEntry.node || null, "assistant")
  };
}

function getConversationId() {
  const adapter = getActiveSurfaceAdapter();
  return adapter ? adapter.getConversationId() : null;
}

function applyStoredAnalysisConfig(config) {
  if (!config || typeof config !== "object") {
    return;
  }

  state.analysisEnabled = Boolean(config.enabled);
}

function loadStoredAnalysisConfig() {
  try {
    chrome.storage.local.get(["analysisApi"], (stored) => {
      if (chrome.runtime.lastError) {
        return;
      }

      applyStoredAnalysisConfig(stored.analysisApi || null);
    });
  } catch (_error) {
    // Ignore storage failures and keep the default enabled state.
  }
}

function nowMs() {
  return Date.now();
}

function isGenerationInProgress() {
  const adapter = getActiveSurfaceAdapter();
  return adapter ? adapter.isGenerationInProgress() : false;
}

function buildFingerprint(payload) {
  return [payload.conversationId || "", payload.prompt, payload.response].join("::");
}

function readLatestConversationTurn() {
  const latestPair = getLatestPromptResponsePair();
  if (!latestPair) {
    return null;
  }

  const { promptNode, prompt, responseNode, response } = latestPair;
  const adapter = getActiveSurfaceAdapter();
  const responseMountNode =
    adapter && typeof adapter.getResponseMountNode === "function"
      ? adapter.getResponseMountNode(responseNode)
      : responseNode;

  if (!prompt || !response || !responseNode || !promptNode) {
    return null;
  }

  return {
    pageUrl: window.location.href,
    prompt,
    promptNode,
    response,
    responseMountNode: responseMountNode || responseNode,
    capturedAt: new Date().toISOString(),
    conversationId: getConversationId(),
    responseNode
  };
}

function buildSerializablePayload(payload) {
  return {
    pageUrl: payload.pageUrl,
    prompt: payload.prompt,
    response: payload.response,
    capturedAt: payload.capturedAt,
    conversationId: payload.conversationId
  };
}

function readConversationTranscript() {
  const transcriptEntries = getTranscriptEntries();
  const transcript = [];

  for (const entry of transcriptEntries) {
    const role = entry && typeof entry.role === "string" ? entry.role : "";
    const node = entry ? entry.node : null;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = getNodeText(node, role);
    if (!content) {
      continue;
    }

    transcript.push({
      role,
      content
    });
  }

  return transcript;
}

function getInitialFeedbackState() {
  return {
    stage: "idle",
    selected: "",
    comment: "",
    status: "idle",
    message: "",
    submittedAt: "",
    receiptId: "",
    lastEvent: ""
  };
}

function getFeedbackState(fingerprint) {
  if (!state.feedbackByFingerprint.has(fingerprint)) {
    state.feedbackByFingerprint.set(fingerprint, getInitialFeedbackState());
  }

  return state.feedbackByFingerprint.get(fingerprint);
}

function buildFeedbackSummary(feedbackState) {
  if (!feedbackState || feedbackState.stage !== "submitted") {
    return "";
  }

  return feedbackState.selected === "helpful" ? "Marked helpful." : "Marked unhelpful.";
}

function isRecoverableExtensionError(message) {
  if (!message || typeof message !== "string") {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("extension context invalidated") ||
    normalized.includes("receiving end does not exist") ||
    normalized.includes("message port closed before a response was received")
  );
}

function attemptExtensionContextRecovery(reason) {
  if (state.extensionRecoveryAttempted) {
    return false;
  }

  state.extensionRecoveryAttempted = true;
  window.setTimeout(() => {
    window.location.reload();
  }, 150);
  return true;
}

function emitClientLog(message, details = null, level = "info") {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: "SAFETY_NUDGES_LOG_CLIENT_EVENT",
          level,
          message,
          details
        },
        (response) => {
          if (chrome.runtime.lastError) {
            if (isRecoverableExtensionError(chrome.runtime.lastError.message)) {
              attemptExtensionContextRecovery("client-log");
            }
            resolve(false);
            return;
          }

          resolve(Boolean(response && response.ok));
        }
      );
    } catch (_error) {
      resolve(false);
    }
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response || null);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Unknown extension messaging error"));
    }
  });
}

function buildFeedbackPayload(payload, fingerprint, analysisState, feedbackState) {
  const result = analysisState && analysisState.result ? analysisState.result : { issueDetected: false, issues: [] };
  const issues = Array.isArray(result.issues) ? result.issues : [];

  return {
    schema_version: FEEDBACK_SCHEMA_VERSION,
    event_name: FEEDBACK_SUBMIT_EVENT,
    source: "chrome_extension",
    submitted_at: new Date().toISOString(),
    page_url: payload.pageUrl,
    conversation_id: payload.conversationId,
    turn_id: fingerprint,
    model_id: result.source || null,
    rating: feedbackState.selected,
    comment: feedbackState.comment.trim(),
    consent: {
      disclosure_version: FEEDBACK_DISCLOSURE_VERSION,
      share_chat_history: true,
      purposes: ["research", "training", "product_improvement"]
    },
    judgment: {
      issue_detected: Boolean(result.issueDetected),
      summary: result.summary || "",
      severity: inferSeverityFromResult(result),
      issue_count: issues.length,
      issues: issues.map((issue) => ({
        id: issue && issue.id ? issue.id : null,
        label: issue && issue.label ? issue.label : "other",
        severity: issue && issue.severity ? issue.severity : "low",
        actor: issue && issue.actor ? issue.actor : "assistant"
      }))
    },
    latest_turn: {
      prompt: payload.prompt,
      response: payload.response
    },
    chat_history: readConversationTranscript(),
    flags: {
      mock_submission: false,
      transport: "supabase_rest_v1",
      anti_spam_rule: "one_submission_per_judgment",
      comment_max_chars: FEEDBACK_COMMENT_MAX_CHARS
    }
  };
}

async function submitJudgmentFeedback(payload, fingerprint, analysisState, feedbackState) {
  if (navigator.onLine === false) {
    return {
      ok: false,
      eventName: FEEDBACK_FAILURE_EVENT,
      error: "You appear to be offline. Reconnect before submitting feedback."
    };
  }

  const feedbackPayload = buildFeedbackPayload(payload, fingerprint, analysisState, feedbackState);
  try {
    const response = await sendRuntimeMessage({
      type: "SAFETY_NUDGES_SUBMIT_JUDGMENT_FEEDBACK",
      payload: feedbackPayload
    });

    if (!response || !response.ok) {
      return {
        ok: false,
        eventName: FEEDBACK_FAILURE_EVENT,
        error: (response && response.error) || "Feedback could not be submitted."
      };
    }

    return {
      ok: true,
      eventName: response.eventName || FEEDBACK_SUBMIT_EVENT,
      receiptId: response.receiptId || ""
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown feedback submission error";
    return {
      ok: false,
      eventName: FEEDBACK_FAILURE_EVENT,
      error: errorMessage
    };
  }
}

function sendAnalysisMessageOnce(payload, timeoutMs) {
  return new Promise((resolve) => {
    const serializedPayload = buildSerializablePayload(payload);
    emitClientLog("Content script dispatching analysis message", {
      conversationId: serializedPayload.conversationId || null,
      promptChars: serializedPayload.prompt.length,
      responseChars: serializedPayload.response.length,
      timeoutMs
    });

    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      emitClientLog(
        "Content script did not receive a background acknowledgement before attempt timeout",
        {
          conversationId: serializedPayload.conversationId || null,
          timeoutMs
        },
        "warn"
      );
      resolve(null);
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(
        {
          type: "SAFETY_NUDGES_ANALYZE_LATEST_TURN",
          payload: serializedPayload
        },
        (response) => {
          if (settled) {
            return;
          }

          settled = true;
          window.clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            const errorMessage = chrome.runtime.lastError.message;
            const shouldReload = isRecoverableExtensionError(errorMessage);
            if (shouldReload) {
              attemptExtensionContextRecovery("analysis-message");
            }
            emitClientLog(
              "Content script analysis message failed before background acknowledgement",
              {
                conversationId: serializedPayload.conversationId || null,
                error: errorMessage
              },
              "error"
            );
            resolve({
              ok: false,
              error: `Extension messaging failed: ${errorMessage}`,
              shouldRetry: !shouldReload
            });
            return;
          }

          if (!response) {
            emitClientLog(
              "Content script received no response payload from background worker",
              {
                conversationId: serializedPayload.conversationId || null
              },
              "warn"
            );
            resolve(null);
            return;
          }

          emitClientLog("Content script received background analysis response", {
            conversationId: serializedPayload.conversationId || null,
            ok: Boolean(response.ok)
          });
          resolve(response);
        }
      );
    } catch (error) {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      const errorMessage = error instanceof Error ? error.message : "Unknown extension messaging error";
      const shouldReload = isRecoverableExtensionError(errorMessage);
      if (shouldReload) {
        attemptExtensionContextRecovery("analysis-message-throw");
      }
      resolve({
        ok: false,
        error: `Extension messaging failed: ${errorMessage}`,
        shouldRetry: !shouldReload
      });
    }
  });
}

async function requestIssueAnalysis(payload) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = "";

  while (attempt < MAX_ANALYSIS_ATTEMPTS && Date.now() - startedAt < ANALYSIS_RESPONSE_TIMEOUT_MS) {
    attempt += 1;
    emitClientLog("Analysis dispatch attempt started", {
      conversationId: payload.conversationId || null,
      attempt
    });

    const response = await sendAnalysisMessageOnce(payload, ANALYSIS_ATTEMPT_TIMEOUT_MS);
    if (response) {
      if (response.shouldRetry) {
        lastError = response.error || "Extension messaging failed before the worker acknowledged the request.";
        emitClientLog(
          "Analysis dispatch attempt will retry after background messaging failure",
          {
            conversationId: payload.conversationId || null,
            attempt,
            error: lastError
          },
          "warn"
        );
        continue;
      }
      return response;
    }

    lastError = "The extension worker did not acknowledge the request in time.";
    emitClientLog(
      "Analysis dispatch attempt timed out waiting for background acknowledgement",
      {
        conversationId: payload.conversationId || null,
        attempt
      },
      "warn"
    );
  }

  emitClientLog(
    "Analysis dispatch failed after exhausting retries",
    {
      conversationId: payload.conversationId || null,
      attempts: attempt,
      error: lastError
    },
    "error"
  );
  return {
    ok: false,
    error:
      lastError ||
      "Safety Nudges timed out waiting for the extension worker. The analysis request may not have reached the local endpoint."
  };
}

function getResponseAnchorByFingerprint(fingerprint) {
  return Array.from(document.querySelectorAll(".safety-nudges-response-anchor")).find(
    (node) => node.dataset.fingerprint === fingerprint
  );
}

function closeAllResponsePanels(exceptFingerprint = null) {
  const anchors = Array.from(document.querySelectorAll(".safety-nudges-response-anchor"));
  for (const anchor of anchors) {
    const shouldStayOpen = exceptFingerprint && anchor.dataset.fingerprint === exceptFingerprint;
    const panel = anchor.querySelector(".safety-nudges-response-panel");
    const button = anchor.querySelector(".safety-nudges-response-chip");
    if (panel) {
      panel.hidden = !shouldStayOpen;
      if (!shouldStayOpen) {
        panel.style.maxHeight = "";
        panel.style.top = "";
        panel.style.bottom = "";
      }
    }
    if (button) {
      button.setAttribute("aria-expanded", shouldStayOpen ? "true" : "false");
    }
  }
}

function shouldIgnoreViewportBlocker(element) {
  if (!(element instanceof Element)) {
    return true;
  }

  if (element.id === ROOT_ID || element.closest(`#${ROOT_ID}`) || element.closest(".safety-nudges-response-anchor")) {
    return true;
  }

  const tagName = element.tagName.toLowerCase();
  return tagName === "html" || tagName === "body";
}

function getViewportBottomLimit(anchorRect) {
  const fallbackBottom = window.innerHeight;
  const sampleXs = Array.from(
    new Set([
      Math.max(16, Math.min(window.innerWidth - 16, anchorRect.right - 16)),
      Math.max(16, Math.min(window.innerWidth - 16, window.innerWidth - 32)),
      Math.max(16, Math.min(window.innerWidth - 16, window.innerWidth - 180))
    ])
  );

  let obstructionTop = fallbackBottom;
  for (const x of sampleXs) {
    const stack = document.elementsFromPoint(x, Math.max(1, window.innerHeight - 8));
    for (const element of stack) {
      if (shouldIgnoreViewportBlocker(element)) {
        continue;
      }

      const style = window.getComputedStyle(element);
      if (style.position !== "fixed" && style.position !== "sticky") {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (rect.bottom < window.innerHeight - 4 || rect.height < 40) {
        continue;
      }

      obstructionTop = Math.min(obstructionTop, rect.top);
    }
  }

  return obstructionTop;
}

function getViewportTopLimit(anchorRect) {
  const fallbackTop = 0;
  const topCandidates = Array.from(document.querySelectorAll("body *")).filter((element) => {
    if (shouldIgnoreViewportBlocker(element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.position !== "fixed" && style.position !== "sticky") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.height < 40 || rect.bottom <= 0 || rect.top > 96) {
      return false;
    }

    if (rect.right < 0 || rect.left > window.innerWidth) {
      return false;
    }

    return true;
  });
  const directTopLimit = topCandidates.reduce((maxBottom, element) => {
    const rect = element.getBoundingClientRect();
    return Math.max(maxBottom, rect.bottom);
  }, fallbackTop);

  const sampleXs = Array.from(
    new Set([
      Math.max(16, Math.min(window.innerWidth - 16, anchorRect.right - 16)),
      Math.max(16, Math.min(window.innerWidth - 16, window.innerWidth / 2)),
      Math.max(16, Math.min(window.innerWidth - 16, window.innerWidth - 32)),
      Math.max(16, Math.min(window.innerWidth - 16, 32))
    ])
  );
  const sampleYs = [8, 24, 40];

  let obstructionBottom = fallbackTop;
  for (const y of sampleYs) {
    for (const x of sampleXs) {
      const stack = document.elementsFromPoint(x, y);
      for (const element of stack) {
        if (shouldIgnoreViewportBlocker(element)) {
          continue;
        }

        const style = window.getComputedStyle(element);
        if (style.position !== "fixed" && style.position !== "sticky") {
          continue;
        }

        const rect = element.getBoundingClientRect();
        if (rect.top > 48 || rect.bottom < y || rect.height < 40) {
          continue;
        }

        obstructionBottom = Math.max(obstructionBottom, rect.bottom);
      }
    }
  }

  return Math.max(directTopLimit, obstructionBottom);
}

function updateResponsePanelPlacement(anchor) {
  if (!anchor) {
    return;
  }

  const panel = anchor.querySelector(".safety-nudges-response-panel");
  if (!panel || panel.hidden) {
    return;
  }

  const margin = 20;
  const gap = 12;
  const anchorRect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const viewportTopLimit = getViewportTopLimit(anchorRect);
  const viewportBottomLimit = getViewportBottomLimit(anchorRect);
  const safeTop = viewportTopLimit + margin;
  const safeBottom = Math.max(margin, viewportBottomLimit - margin);
  const visibleAnchorTop = Math.min(anchorRect.top, safeBottom);
  const availableAbove = Math.max(0, visibleAnchorTop - safeTop - gap);
  const availableBelow = Math.max(0, safeBottom - anchorRect.bottom - gap);

  let placement = "above";
  let maxHeight = availableAbove;

  if (panelRect.height > availableAbove && availableBelow > availableAbove) {
    placement = "below";
    maxHeight = availableBelow;
  }

  if (panelRect.height > availableAbove && panelRect.height > availableBelow) {
    placement = availableBelow >= availableAbove ? "below" : "above";
    maxHeight = Math.max(availableAbove, availableBelow);
  }

  anchor.dataset.placement = placement;
  panel.style.maxHeight = `${Math.max(0, Math.floor(maxHeight))}px`;
  if (placement === "below") {
    panel.style.top = `${anchor.offsetHeight + gap}px`;
    panel.style.bottom = "auto";
    return;
  }

  const cappedPanelHeight = Math.min(panelRect.height, maxHeight);
  const minTopOffset = safeTop - anchorRect.top;
  const preferredTopOffset = -(cappedPanelHeight + gap);
  panel.style.top = `${Math.round(Math.max(minTopOffset, preferredTopOffset))}px`;
  panel.style.bottom = "auto";
}

function ensureExpandedFeedbackVisible(anchor) {
  if (!anchor) {
    return;
  }

  const panel = anchor.querySelector(".safety-nudges-response-panel");
  const feedbackSection = anchor.querySelector(".safety-nudges-feedback-section");
  const feedbackRow = anchor.querySelector(".safety-nudges-feedback-row");
  const commentWrap = anchor.querySelector(".safety-nudges-feedback-comment");
  if (!panel || panel.hidden || !feedbackSection || !commentWrap || commentWrap.hidden) {
    return;
  }

  updateResponsePanelPlacement(anchor);

  window.requestAnimationFrame(() => {
    const topTarget = feedbackRow || feedbackSection;
    const panelPadding = 8;

    if (panel.scrollHeight > panel.clientHeight) {
      const sectionTop = Math.max(0, feedbackSection.offsetTop - panelPadding);
      panel.scrollTo({
        top: sectionTop,
        behavior: "smooth"
      });
    }

    const targetRect = topTarget.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const viewportTopLimit = getViewportTopLimit(anchorRect);
    const safeTop = viewportTopLimit + 16;

    if (targetRect.top < safeTop) {
      window.scrollBy({
        top: Math.floor(targetRect.top - safeTop),
        behavior: "smooth"
      });
    }
  });
}

function updateInlineTooltipPlacement(highlightNode) {
  if (!(highlightNode instanceof Element)) {
    return;
  }

  const tooltipId = highlightNode.dataset.tooltipId;
  const comment = highlightNode.dataset.comment;
  if (!tooltipId || !comment) {
    return;
  }

  const matchingHighlights = Array.from(document.querySelectorAll(`.safety-nudges-inline-highlight[data-tooltip-id="${tooltipId}"]`));
  if (matchingHighlights.length === 0) {
    return;
  }

  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of matchingHighlights) {
    const rect = node.getBoundingClientRect();
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }

  const tooltip = ensureFloatingTooltip();
  tooltip.textContent = comment;
  tooltip.dataset.visible = "true";
  tooltip.dataset.placement = "above";
  tooltip.style.left = `${Math.round((left + right) / 2)}px`;
  tooltip.style.top = `${Math.round(top)}px`;

  const tooltipRect = tooltip.getBoundingClientRect();
  const unionRect = { left, right, top, bottom };
  const viewportTopLimit = getViewportTopLimit(unionRect);
  const viewportBottomLimit = getViewportBottomLimit(unionRect);
  const gap = 8;
  const margin = 12;
  const availableAbove = top - (viewportTopLimit + margin) - gap;
  const availableBelow = viewportBottomLimit - bottom - gap - margin;
  const placeBelow = tooltipRect.height > availableAbove && availableBelow > availableAbove;
  tooltip.dataset.placement = placeBelow ? "below" : "above";
  tooltip.style.top = `${Math.round(placeBelow ? bottom : top)}px`;
}

function ensureFloatingTooltip() {
  if (state.floatingTooltipNode && state.floatingTooltipNode.isConnected) {
    return state.floatingTooltipNode;
  }

  const tooltip = document.createElement("div");
  tooltip.className = "safety-nudges-floating-tooltip";
  tooltip.dataset.visible = "false";
  tooltip.dataset.placement = "above";
  document.body.appendChild(tooltip);
  state.floatingTooltipNode = tooltip;
  return tooltip;
}

function hideFloatingTooltip() {
  const tooltip = state.floatingTooltipNode;
  if (!tooltip) {
    return;
  }

  tooltip.dataset.visible = "false";
}

function refreshOpenResponsePanels() {
  const anchors = Array.from(document.querySelectorAll(".safety-nudges-response-anchor"));
  for (const anchor of anchors) {
    const panel = anchor.querySelector(".safety-nudges-response-panel");
    if (panel && !panel.hidden) {
      updateResponsePanelPlacement(anchor);
    }
  }
}

function toggleResponsePanel(fingerprint) {
  const anchor = getResponseAnchorByFingerprint(fingerprint);
  if (!anchor) {
    return;
  }

  const panel = anchor.querySelector(".safety-nudges-response-panel");
  const button = anchor.querySelector(".safety-nudges-response-chip");
  if (!panel || !button) {
    return;
  }

  const nextOpen = panel.hidden;
  closeAllResponsePanels(nextOpen ? fingerprint : null);
  if (nextOpen) {
    updateResponsePanelPlacement(anchor);
  }
}

function ensureResponseAnchor(responseNode, fingerprint) {
  if (!responseNode) {
    return null;
  }

  let anchor = Array.from(responseNode.children).find(
    (child) => child.classList && child.classList.contains("safety-nudges-response-anchor")
  );

  if (anchor && anchor.dataset.fingerprint !== fingerprint) {
    anchor.remove();
    anchor = null;
  }

  if (!anchor) {
    anchor = document.createElement("div");
    anchor.className = "safety-nudges-response-anchor";
    anchor.dataset.fingerprint = fingerprint;
    anchor.dataset.state = "idle";
    anchor.dataset.severity = "none";
    anchor.dataset.placement = "above";
    anchor.innerHTML = [
      '<button type="button" class="safety-nudges-response-chip" aria-expanded="false">',
      '<span class="safety-nudges-spinner" aria-hidden="true"></span>',
      '<span class="safety-nudges-chip-text">Safety Nudges</span>',
      "</button>",
      '<div class="safety-nudges-response-panel" hidden>',
      '<div class="safety-nudges-panel-header">',
      '<p class="safety-nudges-panel-title">Safety Nudges</p>',
      '<button type="button" class="safety-nudges-panel-close" aria-label="Close response issue details">&times;</button>',
      "</div>",
      '<p class="safety-nudges-panel-summary">Waiting for analysis...</p>',
      '<ul class="safety-nudges-issue-list"></ul>',
      '<div class="safety-nudges-feedback-section">',
      '<div class="safety-nudges-feedback-row">',
      '<p class="safety-nudges-feedback-label">Was this nudge helpful?</p>',
      '<div class="safety-nudges-feedback-options" role="group" aria-label="Nudge feedback">',
      '<button type="button" class="safety-nudges-feedback-option" data-feedback-value="helpful" aria-pressed="false" aria-label="Helpful">👍</button>',
      '<button type="button" class="safety-nudges-feedback-option" data-feedback-value="unhelpful" aria-pressed="false" aria-label="Unhelpful">👎</button>',
      "</div>",
      "</div>",
      `<label class="safety-nudges-feedback-comment" hidden><span>Optional comment</span><textarea class="safety-nudges-feedback-textarea" rows="3" maxlength="${FEEDBACK_COMMENT_MAX_CHARS}" placeholder="Tell us what was right or wrong about this nudge."></textarea></label>`,
      '<p class="safety-nudges-feedback-consent" hidden>Submitting feedback shares the current chat history with the Safety Nudges research team for evaluation, product improvement, and model training.</p>',
      '<p class="safety-nudges-feedback-status" aria-live="polite"></p>',
      '<div class="safety-nudges-feedback-actions" hidden>',
      '<button type="button" class="safety-nudges-feedback-submit">Submit feedback</button>',
      '<button type="button" class="safety-nudges-feedback-cancel">Cancel</button>',
      "</div>",
      "</div>",
      "</div>"
    ].join("");

    const chip = anchor.querySelector(".safety-nudges-response-chip");
    if (chip) {
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleResponsePanel(fingerprint);
      });
    }

    const closeButton = anchor.querySelector(".safety-nudges-panel-close");
    if (closeButton) {
      closeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeAllResponsePanels();
      });
    }

    const feedbackOptions = Array.from(anchor.querySelectorAll(".safety-nudges-feedback-option"));
    for (const option of feedbackOptions) {
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextValue = option.dataset.feedbackValue;
        const feedbackState = getFeedbackState(fingerprint);
        if (feedbackState.stage === "submitted" || !nextValue) {
          return;
        }

        feedbackState.selected = nextValue;
        feedbackState.stage = feedbackState.comment.trim() ? "comment_edit" : "selected";
        feedbackState.status = "idle";
        feedbackState.message = "";
        renderFeedbackSection(anchor, feedbackState);
        ensureExpandedFeedbackVisible(anchor);
      });
    }

    const textarea = anchor.querySelector(".safety-nudges-feedback-textarea");
    if (textarea) {
      textarea.addEventListener("input", () => {
        const feedbackState = getFeedbackState(fingerprint);
        if (feedbackState.stage === "submitted") {
          return;
        }

        feedbackState.comment = textarea.value.slice(0, FEEDBACK_COMMENT_MAX_CHARS);
        feedbackState.stage = feedbackState.comment.trim() ? "comment_edit" : feedbackState.selected ? "selected" : "idle";
        feedbackState.status = "idle";
        feedbackState.message = "";
        renderFeedbackSection(anchor, feedbackState);
      });
    }

    const cancelButton = anchor.querySelector(".safety-nudges-feedback-cancel");
    if (cancelButton) {
      cancelButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.feedbackByFingerprint.set(fingerprint, getInitialFeedbackState());
        renderFeedbackSection(anchor, getFeedbackState(fingerprint));
      });
    }

    const submitButton = anchor.querySelector(".safety-nudges-feedback-submit");
    if (submitButton) {
      submitButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const payloadForSubmit = state.payloadByFingerprint.get(fingerprint);
        const analysisForSubmit = state.analysesByFingerprint.get(fingerprint);
        const feedbackState = getFeedbackState(fingerprint);
        if (!payloadForSubmit || !analysisForSubmit || !feedbackState.selected || feedbackState.stage === "submitted") {
          return;
        }

        feedbackState.status = "submitting";
        feedbackState.message = "Submitting feedback...";
        renderFeedbackSection(anchor, feedbackState);

        const submission = await submitJudgmentFeedback(payloadForSubmit, fingerprint, analysisForSubmit, feedbackState);
        if (!submission.ok) {
          feedbackState.status = "error";
          feedbackState.message = submission.error || "Feedback could not be submitted.";
          feedbackState.lastEvent = submission.eventName || FEEDBACK_FAILURE_EVENT;
          renderFeedbackSection(anchor, feedbackState);
          return;
        }

        feedbackState.stage = "submitted";
        feedbackState.status = "idle";
        feedbackState.message = "Your feedback was recorded.";
        feedbackState.submittedAt = new Date().toISOString();
        feedbackState.receiptId = submission.receiptId || "";
        feedbackState.lastEvent = submission.eventName || FEEDBACK_SUBMIT_EVENT;
        renderFeedbackSection(anchor, feedbackState);
      });
    }

    responseNode.appendChild(anchor);
  }

  return anchor;
}

function unwrapNode(node) {
  const parent = node.parentNode;
  if (!parent) {
    return;
  }

  while (node.firstChild) {
    parent.insertBefore(node.firstChild, node);
  }
  parent.removeChild(node);
}

function clearInlineHighlights(node) {
  if (!node) {
    return;
  }

  const highlights = Array.from(node.querySelectorAll(".safety-nudges-inline-highlight"));
  const parentsToNormalize = new Set();
  for (const highlight of highlights) {
    if (highlight.parentNode) {
      parentsToNormalize.add(highlight.parentNode);
    }
    unwrapNode(highlight);
  }

  for (const parent of parentsToNormalize) {
    if (parent && typeof parent.normalize === "function") {
      parent.normalize();
    }
  }
}

function buildHighlightSignature(result) {
  const issues = Array.isArray(result && result.issues) ? result.issues : [];
  const signaturePayload = issues.map((issue) => ({
    id: issue && issue.id ? issue.id : null,
    spans: Array.isArray(issue && issue.evidenceSpans)
      ? issue.evidenceSpans.map((span) => ({
          turnIndex: span && typeof span.turnIndex === "number" ? span.turnIndex : null,
          text: span && typeof span.text === "string" ? span.text : "",
          rationale: span && typeof span.rationale === "string" ? span.rationale : ""
        }))
      : []
  }));

  try {
    return JSON.stringify(signaturePayload);
  } catch (_error) {
    return "";
  }
}

function buildNormalizedTextMap(rootNode) {
  if (!rootNode) {
    return { text: "", chars: [] };
  }

  const walker = document.createTreeWalker(
    rootNode,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node || !node.textContent) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest(".safety-nudges-response-anchor") || parent.closest(".safety-nudges-inline-highlight")) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const rawChars = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    const text = currentNode.textContent || "";
    for (let index = 0; index < text.length; index += 1) {
      rawChars.push({
        char: text[index],
        node: currentNode,
        startOffset: index,
        endOffset: index + 1
      });
    }
    currentNode = walker.nextNode();
  }

  const normalizedChars = [];
  let pendingWhitespace = null;
  for (const rawChar of rawChars) {
    if (/\s/.test(rawChar.char)) {
      if (!pendingWhitespace) {
        pendingWhitespace = {
          startNode: rawChar.node,
          startOffset: rawChar.startOffset,
          endNode: rawChar.node,
          endOffset: rawChar.endOffset
        };
      } else {
        pendingWhitespace.endNode = rawChar.node;
        pendingWhitespace.endOffset = rawChar.endOffset;
      }
      continue;
    }

    if (pendingWhitespace && normalizedChars.length > 0) {
      normalizedChars.push({
        char: " ",
        startNode: pendingWhitespace.startNode,
        startOffset: pendingWhitespace.startOffset,
        endNode: pendingWhitespace.endNode,
        endOffset: pendingWhitespace.endOffset
      });
    }

    pendingWhitespace = null;
    normalizedChars.push({
      char: rawChar.char,
      startNode: rawChar.node,
      startOffset: rawChar.startOffset,
      endNode: rawChar.node,
      endOffset: rawChar.endOffset
    });
  }

  return {
    text: normalizedChars.map((entry) => entry.char).join(""),
    chars: normalizedChars
  };
}

function chooseHighlightSpecs(result, turnIndex) {
  const issues = Array.isArray(result && result.issues) ? result.issues : [];
  const candidates = [];

  for (const issue of issues) {
    const spans = Array.isArray(issue && issue.evidenceSpans) ? issue.evidenceSpans : [];
    for (const span of spans) {
      if (!span || span.turnIndex !== turnIndex) {
        continue;
      }

      candidates.push({
        startChar: span.startChar,
        endChar: span.endChar,
        text: span.text,
        comment: span.rationale || (issue && issue.rationale) || "",
        severity: issue && issue.severity === "high" ? "major" : "minor"
      });
    }
  }

  candidates.sort((left, right) => {
    const leftPriority = left.severity === "major" ? 0 : 1;
    const rightPriority = right.severity === "major" ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    if (left.startChar !== right.startChar) {
      return left.startChar - right.startChar;
    }
    return right.endChar - left.endChar;
  });

  const selected = [];
  for (const candidate of candidates) {
    if (!candidate.comment) {
      continue;
    }
    const overlaps = selected.some(
      (existing) => candidate.startChar < existing.endChar && candidate.endChar > existing.startChar
    );
    if (overlaps) {
      continue;
    }
    selected.push(candidate);
  }

  return selected.sort((left, right) => {
    if (left.startChar !== right.startChar) {
      return right.startChar - left.startChar;
    }
    return right.endChar - left.endChar;
  });
}

function wrapHighlightRange(rootNode, spec) {
  const normalizedMap = buildNormalizedTextMap(rootNode);
  const chars = normalizedMap.chars;
  if (
    !spec ||
    typeof spec.startChar !== "number" ||
    typeof spec.endChar !== "number" ||
    spec.startChar < 0 ||
    spec.endChar <= spec.startChar ||
    spec.endChar > chars.length
  ) {
    return {
      ok: false,
      reason: "span-offsets-out-of-range"
    };
  }

  const expectedText = chars
    .slice(spec.startChar, spec.endChar)
    .map((entry) => entry.char)
    .join("");
  if (expectedText !== spec.text) {
    return {
      ok: false,
      reason: "span-text-mismatch"
    };
  }

  const startEntry = chars[spec.startChar];
  const endEntry = chars[spec.endChar - 1];
  if (!startEntry || !endEntry) {
    return {
      ok: false,
      reason: "span-boundary-missing"
    };
  }

  try {
    const coveredChars = chars.slice(spec.startChar, spec.endChar);
    const segments = [];

    for (const entry of coveredChars) {
      const textNode = entry.startNode;
      if (!(textNode instanceof Text)) {
        continue;
      }

      const previousSegment = segments.at(-1);
      if (previousSegment && previousSegment.textNode === textNode && previousSegment.endOffset === entry.startOffset) {
        previousSegment.endOffset = entry.endOffset;
      } else {
        segments.push({
          textNode,
          startOffset: entry.startOffset,
          endOffset: entry.endOffset
        });
      }
    }

    if (segments.length === 0) {
      return {
        ok: false,
        reason: "span-boundary-missing"
      };
    }

    state.nextTooltipId += 1;
    const tooltipId = `tooltip-${state.nextTooltipId}`;

    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      const textNode = segment.textNode;
      const nodeText = textNode.textContent || "";
      const beforeText = nodeText.slice(0, segment.startOffset);
      const selectedText = nodeText.slice(segment.startOffset, segment.endOffset);
      const afterText = nodeText.slice(segment.endOffset);
      const parent = textNode.parentNode;

      if (!parent || !selectedText) {
        continue;
      }

      const wrapper = document.createElement("span");
      wrapper.className = "safety-nudges-inline-highlight";
      wrapper.dataset.severity = spec.severity;
      wrapper.dataset.comment = spec.comment;
      wrapper.dataset.tooltipId = tooltipId;
      wrapper.setAttribute("role", "note");
      wrapper.setAttribute("tabindex", "0");
      if (spec.comment) {
        wrapper.setAttribute("aria-label", spec.comment);
      }
      wrapper.addEventListener("mouseenter", () => {
        updateInlineTooltipPlacement(wrapper);
      });
      wrapper.addEventListener("mouseleave", hideFloatingTooltip);
      wrapper.addEventListener("focus", () => {
        updateInlineTooltipPlacement(wrapper);
      });
      wrapper.addEventListener("blur", hideFloatingTooltip);

      const fragment = document.createDocumentFragment();
      if (beforeText) {
        fragment.appendChild(document.createTextNode(beforeText));
      }
      wrapper.appendChild(document.createTextNode(selectedText));
      fragment.appendChild(wrapper);
      if (afterText) {
        fragment.appendChild(document.createTextNode(afterText));
      }

      parent.insertBefore(fragment, textNode);
      parent.removeChild(textNode);
    }

    return {
      ok: true,
      reason: null
    };
  } catch (_error) {
    return {
      ok: false,
      reason: "dom-range-insert-failed"
    };
  }
}

function renderInlineHighlights(payload, analysisState) {
  const promptNode = payload && payload.promptNode ? payload.promptNode : null;
  const responseNode = payload && payload.responseNode ? payload.responseNode : null;

  if (!analysisState || analysisState.status !== "complete") {
    clearInlineHighlights(promptNode);
    clearInlineHighlights(responseNode);
    return {
      expectedSpanCount: 0,
      renderedSpanCount: 0,
      failureReasons: []
    };
  }

  const result = analysisState.result || { issueDetected: false, issues: [] };
  if (result.spansEnabled === false) {
    clearInlineHighlights(promptNode);
    clearInlineHighlights(responseNode);
    hideFloatingTooltip();
    return {
      expectedSpanCount: 0,
      renderedSpanCount: 0,
      failureReasons: []
    };
  }

  if (!result.issueDetected) {
    clearInlineHighlights(promptNode);
    clearInlineHighlights(responseNode);
    hideFloatingTooltip();
    return {
      expectedSpanCount: 0,
      renderedSpanCount: 0,
      failureReasons: []
    };
  }

  const highlightSignature = buildHighlightSignature(result);
  if (analysisState.lastRenderedHighlightSignature === highlightSignature) {
    return {
      expectedSpanCount: getEvidenceSpanCount(result),
      renderedSpanCount: getEvidenceSpanCount(result),
      failureReasons: []
    };
  }

  clearInlineHighlights(promptNode);
  clearInlineHighlights(responseNode);

  const nodesByTurn = [
    { turnIndex: 0, node: promptNode },
    { turnIndex: 1, node: responseNode }
  ];
  const diagnostics = {
    expectedSpanCount: 0,
    renderedSpanCount: 0,
    failureReasons: []
  };

  for (const target of nodesByTurn) {
    if (!target.node || !target.node.isConnected) {
      continue;
    }

    const specs = chooseHighlightSpecs(result, target.turnIndex);
    diagnostics.expectedSpanCount += specs.length;
    for (const spec of specs) {
      const renderResult = wrapHighlightRange(target.node, spec);
      if (renderResult.ok) {
        diagnostics.renderedSpanCount += 1;
      } else if (renderResult.reason) {
        diagnostics.failureReasons.push(renderResult.reason);
      }
    }
  }

  if (diagnostics.expectedSpanCount === diagnostics.renderedSpanCount && diagnostics.failureReasons.length === 0) {
    analysisState.lastRenderedHighlightSignature = highlightSignature;
  } else {
    analysisState.lastRenderedHighlightSignature = "";
  }

  return diagnostics;
}

function buildSpanDisplayMessage(result, highlightDiagnostics) {
  const issues = Array.isArray(result && result.issues) ? result.issues : [];
  const evidenceSpanCount = issues.reduce(
    (total, issue) => total + (Array.isArray(issue && issue.evidenceSpans) ? issue.evidenceSpans.length : 0),
    0
  );
  const issueDetected = Boolean(result && result.issueDetected);
  const spansEnabled = !(result && result.spansEnabled === false);

  if (!spansEnabled) {
    return "";
  }

  if (issueDetected && evidenceSpanCount === 0) {
    return "No inline evidence spans were returned for this analysis.";
  }

  if (!highlightDiagnostics || highlightDiagnostics.renderedSpanCount === evidenceSpanCount) {
    return "";
  }

  const failureReasons = Array.isArray(highlightDiagnostics.failureReasons)
    ? Array.from(new Set(highlightDiagnostics.failureReasons))
    : [];
  const reasonText = failureReasons.length > 0 ? ` (${failureReasons.join(", ")})` : "";
  return `Inline highlights were not fully displayed: rendered ${highlightDiagnostics.renderedSpanCount} of ${evidenceSpanCount} evidence spans${reasonText}.`;
}

function maybeLogSpanDisplayMessage(payload, result, highlightDiagnostics) {
  const spanDisplayMessage = buildSpanDisplayMessage(result, highlightDiagnostics);
  if (!spanDisplayMessage) {
    return;
  }

  const fingerprint = payload ? buildFingerprint(payload) : "";
  const existingAnalysis = fingerprint ? state.analysesByFingerprint.get(fingerprint) : null;
  if (existingAnalysis && existingAnalysis.lastSpanDiagnosticMessage === spanDisplayMessage) {
    return;
  }
  if (existingAnalysis) {
    existingAnalysis.lastSpanDiagnosticMessage = spanDisplayMessage;
  }

  void emitClientLog("Inline highlight diagnostics", {
    conversationId: payload && payload.conversationId ? payload.conversationId : null,
    fingerprint: fingerprint || null,
    message: spanDisplayMessage,
    expectedSpanCount: highlightDiagnostics ? highlightDiagnostics.expectedSpanCount : 0,
    renderedSpanCount: highlightDiagnostics ? highlightDiagnostics.renderedSpanCount : 0,
    failureReasons:
      highlightDiagnostics && Array.isArray(highlightDiagnostics.failureReasons)
        ? Array.from(new Set(highlightDiagnostics.failureReasons))
        : []
  }, "warn");
}

function renderIssueList(listNode, result) {
  listNode.replaceChildren();

  const issues = Array.isArray(result && result.issues) ? result.issues : [];
  if (issues.length === 0) {
    return;
  }

  for (const issue of issues) {
    const item = document.createElement("li");
    item.className = "safety-nudges-issue-item";

    const severity = document.createElement("span");
    severity.className = "safety-nudges-issue-severity";
    severity.dataset.severity = issue && issue.severity === "high" ? "high" : "low";
    severity.textContent = issue && issue.severity === "high" ? "High" : "Low";

    const details = document.createElement("div");
    details.className = "safety-nudges-issue-copy";

    const title = document.createElement("p");
    title.className = "safety-nudges-issue-title";
    title.textContent = formatLabel(issue && issue.label ? issue.label : "other");

    const rationale = document.createElement("p");
    rationale.className = "safety-nudges-issue-rationale";
    rationale.textContent =
      issue && issue.rationale ? issue.rationale : "Potential issue detected in this response.";

    details.append(title, rationale);

    item.append(severity, details);
    listNode.appendChild(item);
  }
}

function renderFeedbackSection(anchor, feedbackState, analysisState = null) {
  const feedbackSection = anchor.querySelector(".safety-nudges-feedback-section");
  const options = Array.from(anchor.querySelectorAll(".safety-nudges-feedback-option"));
  const commentWrap = anchor.querySelector(".safety-nudges-feedback-comment");
  const textarea = anchor.querySelector(".safety-nudges-feedback-textarea");
  const consent = anchor.querySelector(".safety-nudges-feedback-consent");
  const status = anchor.querySelector(".safety-nudges-feedback-status");
  const actions = anchor.querySelector(".safety-nudges-feedback-actions");
  const submitButton = anchor.querySelector(".safety-nudges-feedback-submit");
  const cancelButton = anchor.querySelector(".safety-nudges-feedback-cancel");
  const selectedValue = feedbackState && feedbackState.selected ? feedbackState.selected : "";
  const isSubmitted = feedbackState && feedbackState.stage === "submitted";
  const isSubmitting = feedbackState && feedbackState.status === "submitting";
  const canShowForm = Boolean(selectedValue) && !isSubmitted;
  const analysisComplete = !analysisState || analysisState.status === "complete";
  const analysisFailed = Boolean(analysisState && analysisState.status === "error");

  if (feedbackSection) {
    feedbackSection.hidden = analysisFailed;
  }

  if (analysisFailed) {
    return;
  }

  for (const option of options) {
    const isActive = option.dataset.feedbackValue === selectedValue;
    option.dataset.selected = isActive ? "true" : "false";
    option.setAttribute("aria-pressed", isActive ? "true" : "false");
    option.disabled = isSubmitted || isSubmitting || !analysisComplete;
  }

  if (commentWrap) {
    commentWrap.hidden = !canShowForm;
  }
  if (textarea) {
    if (textarea.value !== (feedbackState.comment || "")) {
      textarea.value = feedbackState.comment || "";
    }
    textarea.disabled = isSubmitted || isSubmitting || !analysisComplete;
  }
  if (consent) {
    consent.hidden = !canShowForm;
  }
  if (actions) {
    actions.hidden = !canShowForm;
  }
  if (submitButton) {
    submitButton.disabled = !selectedValue || isSubmitted || isSubmitting || !analysisComplete;
    submitButton.textContent = isSubmitting ? "Submitting..." : "Submit feedback";
  }
  if (cancelButton) {
    cancelButton.disabled = isSubmitting;
  }

  if (!status) {
    return;
  }

  status.dataset.state = feedbackState.status || "idle";
  if (!analysisComplete) {
    status.textContent = "Feedback becomes available after the judgment finishes loading.";
    return;
  }
  if (feedbackState.message) {
    status.textContent = feedbackState.message;
    return;
  }
  if (isSubmitted) {
    status.textContent = buildFeedbackSummary(feedbackState);
    return;
  }
  status.textContent = "";
}

function renderResponseIndicator(payload, fingerprint, analysisState) {
  const responseNode = payload && payload.responseMountNode ? payload.responseMountNode : payload.responseNode;
  if (!responseNode || !responseNode.isConnected) {
    return;
  }
  state.payloadByFingerprint.set(fingerprint, buildSerializablePayload(payload));

  const anchor = ensureResponseAnchor(responseNode, fingerprint);
  const chip = anchor.querySelector(".safety-nudges-response-chip");
  const chipText = anchor.querySelector(".safety-nudges-chip-text");
  const spinner = anchor.querySelector(".safety-nudges-spinner");
  const panel = anchor.querySelector(".safety-nudges-response-panel");
  const summary = anchor.querySelector(".safety-nudges-panel-summary");
  const issueList = anchor.querySelector(".safety-nudges-issue-list");

  if (!chip || !chipText || !spinner || !panel || !summary || !issueList) {
    return;
  }

  const result = analysisState.result || { issueDetected: false, issues: [] };
  const severity = analysisState.status === "error" ? "high" : inferSeverityFromResult(result);

  const highlightDiagnostics = renderInlineHighlights(payload, analysisState);

  anchor.dataset.state = analysisState.status;
  anchor.dataset.severity = severity;
  chip.dataset.severity = severity;
  chip.dataset.state = analysisState.status;

  if (analysisState.status === "analyzing") {
    chipText.textContent = "Checking response...";
    summary.textContent = "Safety Nudges is reviewing this response now.";
    issueList.replaceChildren();
    spinner.hidden = false;
    renderFeedbackSection(anchor, getFeedbackState(fingerprint), analysisState);
    return;
  }

  spinner.hidden = true;

  if (analysisState.status === "error") {
    chipText.textContent = "Analysis failed";
    summary.textContent = analysisState.message || "Safety Nudges could not analyze this response.";
    issueList.replaceChildren();
    renderFeedbackSection(anchor, getFeedbackState(fingerprint), analysisState);
    return;
  }

  chipText.textContent = buildCompletionMessage(result);
  summary.textContent = result.summary || buildCompletionMessage(result);
  renderIssueList(issueList, result);
  renderFeedbackSection(anchor, getFeedbackState(fingerprint), analysisState);
  maybeLogSpanDisplayMessage(payload, result, highlightDiagnostics);
}

async function maybeAnalyzeLatestTurn() {
  if (!state.analysisEnabled) {
    return;
  }

  if (isGenerationInProgress()) {
    return;
  }

  const payload = readLatestConversationTurn();
  if (!payload) {
    return;
  }

  const fingerprint = buildFingerprint(payload);
  const existingAnalysis = state.analysesByFingerprint.get(fingerprint);
  if (existingAnalysis) {
    if (existingAnalysis.status === "analyzing") {
      if (Date.now() - (existingAnalysis.startedAt || 0) > ANALYSIS_RESPONSE_TIMEOUT_MS) {
        existingAnalysis.status = "error";
        existingAnalysis.message = state.extensionRecoveryAttempted
          ? "Safety Nudges reloaded. Refreshing the page should restore analysis."
          : "Analysis timed out before the extension worker returned a result.";
      }
      renderResponseIndicator(payload, fingerprint, existingAnalysis);
      return;
    }
    renderResponseIndicator(payload, fingerprint, existingAnalysis);
    return;
  } else {
    void emitClientLog("Response marked as analyzing in content script", {
      conversationId: payload.conversationId || null,
      fingerprint
    });

    const inFlightState = {
      status: "analyzing",
      result: null,
      message: "",
      startedAt: Date.now(),
      lastAttemptAt: Date.now(),
      attemptCount: 1
    };
    state.analysesByFingerprint.set(fingerprint, inFlightState);
  }

  const currentAnalysis = state.analysesByFingerprint.get(fingerprint);
  if (currentAnalysis) {
    currentAnalysis.status = "analyzing";
    currentAnalysis.lastAttemptAt = Date.now();
    renderResponseIndicator(payload, fingerprint, currentAnalysis);
  }

  const response = await requestIssueAnalysis(payload);

  if (!response) {
    state.analysesByFingerprint.set(fingerprint, {
      status: "error",
      result: null,
      message: "No analysis response was returned."
    });
    renderResponseIndicator(payload, fingerprint, state.analysesByFingerprint.get(fingerprint));
    return;
  }

  if (!response.ok) {
    const errorMessage = response.error || "Unknown analysis error";
    state.analysesByFingerprint.set(fingerprint, {
      status: "error",
      result: response.result || null,
      message: errorMessage
    });
    renderResponseIndicator(payload, fingerprint, state.analysesByFingerprint.get(fingerprint));
    return;
  }

  const completedState = {
    status: "complete",
    result: response.result || { issueDetected: false, issues: [] },
    message: ""
  };
  state.analysesByFingerprint.set(fingerprint, completedState);
  renderResponseIndicator(payload, fingerprint, completedState);
}

function scheduleAnalysis(reason) {
  state.lastMutationAt = Date.now();

  if (state.analyzeTimer) {
    window.clearTimeout(state.analyzeTimer);
  }

  state.analyzeTimer = window.setTimeout(() => {
    const elapsed = Date.now() - state.lastMutationAt;
    if (elapsed < QUIET_PERIOD_MS) {
      scheduleAnalysis("quiet-period-reset");
      return;
    }

    void maybeAnalyzeLatestTurn();
  }, QUIET_PERIOD_MS);
}

function shouldUseCompletionPoller() {
  const adapter = getActiveSurfaceAdapter();
  return Boolean(adapter && typeof adapter.shouldUseCompletionPoller === "function" && adapter.shouldUseCompletionPoller());
}

function isInternalMutationNode(node) {
  if (!node) {
    return false;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return Boolean(node.parentElement && isInternalMutationNode(node.parentElement));
  }

  if (!(node instanceof Element)) {
    return false;
  }

  return Boolean(node.closest(".safety-nudges-response-anchor") || node.closest(".safety-nudges-inline-highlight"));
}

function isIgnoredMutationNode(node) {
  if (!node) {
    return false;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return Boolean(node.parentElement && isIgnoredMutationNode(node.parentElement));
  }

  if (!(node instanceof Element)) {
    return false;
  }

  if (isInternalMutationNode(node)) {
    return true;
  }

  const adapter = getActiveSurfaceAdapter();
  if (adapter && typeof adapter.isIgnoredMutationNode === "function") {
    return adapter.isIgnoredMutationNode(node);
  }

  return false;
}

function installMutationObserver() {
  const container = getConversationContainer();
  if (!container) {
    window.setTimeout(installMutationObserver, 1000);
    return;
  }

  if (state.observer) {
    return;
  }

  state.observer = new MutationObserver((mutations) => {
    const hasRelevantMutation = mutations.some((mutation) => {
      if (mutation.type === "characterData") {
        return !isIgnoredMutationNode(mutation.target);
      }

      const addedNodes = Array.from(mutation.addedNodes || []);
      const removedNodes = Array.from(mutation.removedNodes || []);
      const externalAdded = addedNodes.some((node) => !isIgnoredMutationNode(node));
      const externalRemoved = removedNodes.some((node) => !isIgnoredMutationNode(node));
      return externalAdded || externalRemoved;
    });

    if (hasRelevantMutation) {
      scheduleAnalysis("dom-mutation");
    }
  });

  state.observer.observe(container, {
    subtree: true,
    childList: true,
    characterData: true
  });

  scheduleAnalysis("observer-installed");
}

function installOutsideClickHandler() {
  if (state.outsideClickInstalled) {
    return;
  }

  state.outsideClickInstalled = true;
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest(".safety-nudges-response-anchor") || target.closest(`#${ROOT_ID}`)) {
      return;
    }

    closeAllResponsePanels();
  });
}

function installViewportListeners() {
  if (state.viewportListenersInstalled) {
    return;
  }

  state.viewportListenersInstalled = true;
  window.addEventListener("resize", refreshOpenResponsePanels);
  document.addEventListener(
    "scroll",
    () => {
      refreshOpenResponsePanels();
    },
    true
  );
}

function installCompletionPoller() {
  if (state.completionPollTimer || !shouldUseCompletionPoller()) {
    return;
  }

  state.completionPollTimer = window.setInterval(() => {
    if (document.visibilityState === "hidden") {
      return;
    }

    if (isGenerationInProgress()) {
      return;
    }

    void maybeAnalyzeLatestTurn();
  }, COMPLETION_POLL_MS);
}

function installShell() {
  if (!isSupportedSurface()) {
    return;
  }

  installOutsideClickHandler();
  installViewportListeners();
  loadStoredAnalysisConfig();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.analysisApi) {
      return;
    }

    applyStoredAnalysisConfig(changes.analysisApi.newValue || null);
  });

  chrome.runtime.sendMessage(
    {
      type: "SAFETY_NUDGES_PING",
      pageUrl: window.location.href
    },
    () => {}
  );

  installMutationObserver();
  installCompletionPoller();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleAnalysis("tab-visible");
      void maybeAnalyzeLatestTurn();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installShell, { once: true });
} else {
  installShell();
}
