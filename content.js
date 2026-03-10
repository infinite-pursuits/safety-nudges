const ROOT_ID = "safety-nudges-root";
const QUIET_PERIOD_MS = 1500;
const RESPONSE_STABLE_MS = 2200;
const RESPONSE_STABLE_WITH_ACTIONS_MS = 900;
const ANALYSIS_RESPONSE_TIMEOUT_MS = 30000;
const ANALYSIS_ATTEMPT_TIMEOUT_MS = 4000;
const MAX_ANALYSIS_ATTEMPTS = 8;
const STALE_ANALYSIS_RETRY_MS = 5000;

const state = {
  observer: null,
  analyzeTimer: null,
  lastMutationAt: 0,
  latestAssistantSnapshot: {
    node: null,
    text: "",
    changedAt: 0
  },
  analysesByFingerprint: new Map(),
  outsideClickInstalled: false,
  viewportListenersInstalled: false,
  extensionRecoveryAttempted: false
};

function isChatGptHost() {
  return window.location.hostname === "chatgpt.com" || window.location.hostname === "chat.openai.com";
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
  return document.querySelector("main");
}

function getTurnNodes(role) {
  return Array.from(document.querySelectorAll(`[data-message-author-role="${role}"]`));
}

function getLastTurnNode(role) {
  const nodes = getTurnNodes(role);
  return nodes.at(-1) || null;
}

function getNodeText(node) {
  if (!node) {
    return "";
  }

  const clone = node.cloneNode(true);
  const injectedUi = Array.from(clone.querySelectorAll(".safety-nudges-response-anchor"));
  for (const injectedNode of injectedUi) {
    injectedNode.remove();
  }

  return clone.innerText.replace(/\s+/g, " ").trim();
}

function getLastTurnText(role) {
  return getNodeText(getLastTurnNode(role));
}

function getConversationId() {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  return pathParts.at(-1) || null;
}

function nowMs() {
  return Date.now();
}

function isGenerationInProgress() {
  const buttons = Array.from(document.querySelectorAll("button"));
  const hasStopButton = buttons.some((button) => {
    const label = (button.getAttribute("aria-label") || button.innerText || "").trim().toLowerCase();
    return label.includes("stop generating") || label === "stop";
  });

  if (hasStopButton) {
    return true;
  }

  const busyNodes = Array.from(document.querySelectorAll('[aria-busy="true"]'));
  return busyNodes.some((node) => {
    if (!(node instanceof Element)) {
      return false;
    }

    return Boolean(
      node.closest("main") &&
        !node.closest(".safety-nudges-response-anchor") &&
        !node.closest(`#${ROOT_ID}`)
    );
  });
}

function hasStreamingUiHints(responseNode) {
  if (!(responseNode instanceof Element)) {
    return false;
  }

  const selectors = [
    '[aria-busy="true"]',
    '[data-testid*="typing"]',
    '[data-testid*="stream"]',
    '[data-testid*="cursor"]',
    '[data-testid*="stop"]',
    '.result-streaming',
    '.animate-pulse',
    '.animate-spin'
  ];

  return selectors.some((selector) => responseNode.querySelector(selector));
}

function hasPostResponseActions(responseNode) {
  if (!(responseNode instanceof Element)) {
    return false;
  }

  const nearbyButtons = Array.from(responseNode.parentElement ? responseNode.parentElement.querySelectorAll("button") : []);
  return nearbyButtons.some((button) => {
    const label = [
      button.getAttribute("aria-label") || "",
      button.getAttribute("title") || "",
      button.innerText || ""
    ]
      .join(" ")
      .trim()
      .toLowerCase();

    return label.includes("copy") || label.includes("share");
  });
}

function isLatestAssistantTurnReady(payload) {
  if (!payload || !payload.responseNode) {
    return false;
  }

  if (isGenerationInProgress() || hasStreamingUiHints(payload.responseNode)) {
    state.latestAssistantSnapshot = {
      node: payload.responseNode,
      text: payload.response,
      changedAt: nowMs()
    };
    return false;
  }

  const sameNode = state.latestAssistantSnapshot.node === payload.responseNode;
  const sameText = state.latestAssistantSnapshot.text === payload.response;

  if (!sameNode || !sameText) {
    state.latestAssistantSnapshot = {
      node: payload.responseNode,
      text: payload.response,
      changedAt: nowMs()
    };
    return false;
  }

  const stableForMs = nowMs() - state.latestAssistantSnapshot.changedAt;
  const requiredStableMs = hasPostResponseActions(payload.responseNode)
    ? RESPONSE_STABLE_WITH_ACTIONS_MS
    : RESPONSE_STABLE_MS;
  return stableForMs >= requiredStableMs;
}

function buildFingerprint(payload) {
  return [payload.conversationId || "", payload.prompt, payload.response].join("::");
}

function readLatestConversationTurn() {
  const promptNode = getLastTurnNode("user");
  const prompt = getLastTurnText("user");
  const responseNode = getLastTurnNode("assistant");
  const response = getNodeText(responseNode);

  if (!prompt || !response || !responseNode || !promptNode) {
    return null;
  }

  return {
    pageUrl: window.location.href,
    prompt,
    promptNode,
    response,
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
  const sampleXs = Array.from(
    new Set([
      Math.max(16, Math.min(window.innerWidth - 16, anchorRect.right - 16)),
      Math.max(16, Math.min(window.innerWidth - 16, window.innerWidth / 2)),
      Math.max(16, Math.min(window.innerWidth - 16, window.innerWidth - 32))
    ])
  );

  let obstructionBottom = fallbackTop;
  for (const x of sampleXs) {
    const stack = document.elementsFromPoint(x, 8);
    for (const element of stack) {
      if (shouldIgnoreViewportBlocker(element)) {
        continue;
      }

      const style = window.getComputedStyle(element);
      if (style.position !== "fixed" && style.position !== "sticky") {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (rect.top > 4 || rect.height < 40) {
        continue;
      }

      obstructionBottom = Math.max(obstructionBottom, rect.bottom);
    }
  }

  return obstructionBottom;
}

function updateResponsePanelPlacement(anchor) {
  if (!anchor) {
    return;
  }

  const panel = anchor.querySelector(".safety-nudges-response-panel");
  if (!panel || panel.hidden) {
    return;
  }

  const margin = 12;
  const gap = 10;
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

  const hiddenAnchorOffset = Math.max(0, anchorRect.top - safeBottom);
  panel.style.top = "auto";
  panel.style.bottom = `${anchor.offsetHeight + gap + hiddenAnchorOffset}px`;
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

  const range = document.createRange();
  range.setStart(startEntry.startNode, startEntry.startOffset);
  range.setEnd(endEntry.endNode, endEntry.endOffset);

  const wrapper = document.createElement("span");
  wrapper.className = "safety-nudges-inline-highlight";
  wrapper.dataset.severity = spec.severity;
  wrapper.dataset.comment = spec.comment;
  wrapper.setAttribute("role", "note");
  wrapper.setAttribute("tabindex", "0");
  if (spec.comment) {
    wrapper.setAttribute("aria-label", spec.comment);
  }

  try {
    const fragment = range.extractContents();
    wrapper.appendChild(fragment);
    range.insertNode(wrapper);
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
  if (!result.issueDetected) {
    clearInlineHighlights(promptNode);
    clearInlineHighlights(responseNode);
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

    const evidenceSpans = Array.isArray(issue && issue.evidenceSpans) ? issue.evidenceSpans : [];
    if (evidenceSpans.length > 0) {
      const evidenceList = document.createElement("ul");
      evidenceList.className = "safety-nudges-evidence-list";

      for (const span of evidenceSpans) {
        const evidenceItem = document.createElement("li");
        evidenceItem.className = "safety-nudges-evidence-item";

        const quote = document.createElement("p");
        quote.className = "safety-nudges-evidence-quote";
        quote.textContent = `"${span.text}"`;

        const note = document.createElement("p");
        note.className = "safety-nudges-evidence-note";
        note.textContent = span.rationale || "Evidence span.";

        evidenceItem.append(quote, note);
        evidenceList.appendChild(evidenceItem);
      }

      details.appendChild(evidenceList);
    }

    item.append(severity, details);
    listNode.appendChild(item);
  }
}

function renderResponseIndicator(payload, fingerprint, analysisState) {
  const responseNode = payload.responseNode;
  if (!responseNode || !responseNode.isConnected) {
    return;
  }

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
    return;
  }

  spinner.hidden = true;

  if (analysisState.status === "error") {
    chipText.textContent = "Analysis failed";
    summary.textContent = analysisState.message || "Safety Nudges could not analyze this response.";
    issueList.replaceChildren();
    return;
  }

  chipText.textContent = buildCompletionMessage(result);
  summary.textContent = result.summary || buildCompletionMessage(result);
  renderIssueList(issueList, result);
  maybeLogSpanDisplayMessage(payload, result, highlightDiagnostics);
}

async function maybeAnalyzeLatestTurn() {
  const payload = readLatestConversationTurn();
  if (!payload) {
    return;
  }

  if (!isLatestAssistantTurnReady(payload)) {
    scheduleAnalysis("awaiting-complete-response");
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
        return !isInternalMutationNode(mutation.target);
      }

      const addedNodes = Array.from(mutation.addedNodes || []);
      const removedNodes = Array.from(mutation.removedNodes || []);
      const externalAdded = addedNodes.some((node) => !isInternalMutationNode(node));
      const externalRemoved = removedNodes.some((node) => !isInternalMutationNode(node));
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

function installShell() {
  if (!isChatGptHost()) {
    return;
  }

  installOutsideClickHandler();
  installViewportListeners();

  chrome.runtime.sendMessage(
    {
      type: "SAFETY_NUDGES_PING",
      pageUrl: window.location.href
    },
    () => {}
  );

  installMutationObserver();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleAnalysis("tab-visible");
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installShell, { once: true });
} else {
  installShell();
}
