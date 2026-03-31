// ==UserScript==
// @name         TrainingCove Course Bot
// @namespace    trainingcove-bot
// @version      1.0
// @description  Auto-navigates TrainingCove course, answers questions via local Claude API server
// @match        https://www.trainingcove.com/Members/Courses/go.aspx*
// @match        https://trainingcove.com/Members/Courses/go.aspx*
// @match        https://www.trainingcove.com/Members/Quiz.aspx*
// @match        https://trainingcove.com/Members/Quiz.aspx*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────
  const CONFIG = {
    SERVER_URL: "http://localhost:3847",
    SLIDE_DELAY_MIN: 12000, // 12s min between slide advances
    SLIDE_DELAY_MAX: 25000, // 25s max
    QUESTION_DELAY: 3000, // 3s after answering before proceeding
    POLL_INTERVAL: 2000, // 2s between page state checks
    KEEPALIVE_INTERVAL: 600000, // 10 min keepalive mouse movement
  };

  let running = false;
  let loopTimeout = null;
  let keepaliveInterval = null;
  let stats = { slides: 0, questions: 0, quizzes: 0, errors: 0 };

  // ── UI Panel ───────────────────────────────────────────────────────
  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "tcbot-panel";
    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;">🤖 TC Bot</div>
      <div id="tcbot-status">Stopped</div>
      <div id="tcbot-stats" style="font-size:11px;margin-top:4px;"></div>
      <div style="margin-top:8px;">
        <button id="tcbot-start" style="margin-right:4px;padding:4px 10px;cursor:pointer;">Start</button>
        <button id="tcbot-stop" style="padding:4px 10px;cursor:pointer;">Stop</button>
      </div>
    `;
    Object.assign(panel.style, {
      position: "fixed",
      top: "10px",
      right: "10px",
      zIndex: "99999",
      background: "#1a1a2e",
      color: "#eee",
      padding: "12px 16px",
      borderRadius: "8px",
      fontSize: "13px",
      fontFamily: "monospace",
      boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
      minWidth: "160px",
    });
    document.body.appendChild(panel);

    document.getElementById("tcbot-start").addEventListener("click", start);
    document.getElementById("tcbot-stop").addEventListener("click", stop);
  }

  function setStatus(msg) {
    const el = document.getElementById("tcbot-status");
    if (el) el.textContent = msg;
    console.log(`[TCBot] ${msg}`);
  }

  function updateStats() {
    const el = document.getElementById("tcbot-stats");
    if (el) {
      el.textContent = `Slides: ${stats.slides} | Q: ${stats.questions} | Quiz: ${stats.quizzes} | Err: ${stats.errors}`;
    }
  }

  // ── Page Type Detection ────────────────────────────────────────────
  // Detect what kind of page/state we're currently on.
  // The course player (go.aspx) loads content in an iframe or inline.
  // Quiz pages are at Quiz.aspx.

  function getPageType() {
    const url = window.location.href;

    // Quiz pages
    if (url.includes("Quiz.aspx")) {
      // "Begin Quiz" button
      const beginBtn = findButtonByText("Begin Quiz");
      if (beginBtn) return { type: "QUIZ_START", el: beginBtn };

      // "Correct! - Click To Proceed"
      const correctBtn = findButtonByText("Correct!");
      if (correctBtn) return { type: "QUIZ_CORRECT", el: correctBtn };

      // "Proceed" button (after incorrect or at end)
      const proceedBtn = findButtonByText("Proceed");
      // Check if there's also a "Go Back" button (meaning quiz is done)
      const goBackBtn = findButtonByText("Go Back");

      // Radio buttons present = active quiz question
      const radios = document.querySelectorAll('input[type="radio"]');
      if (radios.length > 0) {
        // Check if there's an unclicked submit/answer button
        const submitBtn =
          findButtonByText("Submit") ||
          findButtonByText("Answer") ||
          findButtonByText("Next") ||
          findButtonByText("Check");
        return { type: "QUIZ_QUESTION", radios, submitBtn, proceedBtn };
      }

      // Pass/fail result - look for score text
      const bodyText = document.body.innerText;
      if (bodyText.includes("Congratulations") || bodyText.includes("passed")) {
        return { type: "QUIZ_PASSED", proceedBtn };
      }
      if (
        bodyText.includes("did not pass") ||
        bodyText.includes("failed") ||
        bodyText.includes("score of")
      ) {
        if (goBackBtn) return { type: "QUIZ_FAILED", goBackBtn };
        return { type: "QUIZ_PASSED", proceedBtn }; // might still have passed
      }

      if (proceedBtn && !goBackBtn) return { type: "QUIZ_CORRECT", el: proceedBtn };
      if (proceedBtn && goBackBtn) return { type: "QUIZ_RESULT_SCREEN", proceedBtn, goBackBtn };

      return { type: "UNKNOWN" };
    }

    // Course content pages (go.aspx)
    // Look for the forward arrow button in the course player
    const forwardArrow = findForwardArrow();

    // Check for embedded interactive questions (radio buttons in course content)
    const radios = document.querySelectorAll('input[type="radio"]');
    const iframes = document.querySelectorAll("iframe");

    // Check inside iframes for questions too
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        const iframeRadios = iframeDoc.querySelectorAll('input[type="radio"]');
        if (iframeRadios.length > 0) {
          return {
            type: "EMBEDDED_QUESTION",
            radios: iframeRadios,
            doc: iframeDoc,
          };
        }
      } catch (e) {
        // Cross-origin iframe, skip
      }
    }

    if (radios.length > 0) {
      return { type: "EMBEDDED_QUESTION", radios, doc: document };
    }

    if (forwardArrow) {
      return { type: "CONTENT_SLIDE", el: forwardArrow };
    }

    return { type: "UNKNOWN" };
  }

  // ── DOM Helpers ────────────────────────────────────────────────────

  function findButtonByText(text) {
    // Search buttons, inputs, anchors, and any clickable element
    const selectors = "button, input[type='button'], input[type='submit'], a, .btn, [role='button']";
    const elements = document.querySelectorAll(selectors);
    for (const el of elements) {
      const elText = (el.textContent || el.value || "").trim();
      if (elText.toLowerCase().includes(text.toLowerCase())) {
        if (el.offsetParent !== null || el.style.display !== "none") {
          return el;
        }
      }
    }
    return null;
  }

  function findForwardArrow() {
    // The forward arrow is typically an image/button at the bottom of the player
    // Look for common patterns: arrow images, "next" buttons, forward navigation
    const candidates = [
      // Try common selectors for course navigation
      ...document.querySelectorAll('img[src*="forward"], img[src*="next"], img[src*="arrow_right"], img[src*="fwd"]'),
      ...document.querySelectorAll('a[title*="Next"], a[title*="Forward"], button[title*="Next"]'),
      ...document.querySelectorAll('.forward, .next-btn, .nav-forward, #forward, #next'),
    ];

    for (const el of candidates) {
      if (el.offsetParent !== null) return el;
    }

    // Fallback: look for the right-side arrow in the player controls
    // The screenshots show arrows at the bottom - try clicking in that area
    const allImages = document.querySelectorAll("img");
    for (const img of allImages) {
      const src = (img.src || "").toLowerCase();
      if (
        (src.includes("right") || src.includes("fwd") || src.includes("next") || src.includes("forward")) &&
        img.offsetParent !== null
      ) {
        return img;
      }
    }

    // Try iframes
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        const arrows = iframeDoc.querySelectorAll(
          'img[src*="forward"], img[src*="next"], img[src*="right"], img[src*="fwd"]'
        );
        for (const a of arrows) {
          if (a.offsetParent !== null) return a;
        }
      } catch (e) {}
    }

    return null;
  }

  function extractQuestionText(doc) {
    // Look for question text - usually in a heading, strong, or specific class
    const candidates = doc.querySelectorAll(
      "h1, h2, h3, h4, .question, .question-text, [class*='question'], strong, b, p"
    );
    let longest = "";
    for (const el of candidates) {
      const text = el.textContent.trim();
      // Question text usually contains a "?" and is longer than labels
      if (text.includes("?") && text.length > longest.length) {
        longest = text;
      }
    }
    // If no question mark found, get the longest substantial text block
    if (!longest) {
      for (const el of candidates) {
        const text = el.textContent.trim();
        if (text.length > 30 && text.length > longest.length && text.length < 500) {
          longest = text;
        }
      }
    }
    return longest;
  }

  function extractOptions(radios) {
    const options = [];
    for (const radio of radios) {
      // Get the label associated with this radio
      let label = "";
      // Check for <label for="id">
      if (radio.id) {
        const labelEl = document.querySelector(`label[for="${radio.id}"]`);
        if (labelEl) label = labelEl.textContent.trim();
      }
      // Check parent/sibling text
      if (!label) {
        const parent = radio.closest("label, li, div, td, span");
        if (parent) {
          label = parent.textContent.trim();
        }
      }
      // Last resort: next sibling text
      if (!label && radio.nextSibling) {
        label = radio.nextSibling.textContent?.trim() || "";
      }
      options.push(label || `Option ${options.length + 1}`);
    }
    return options;
  }

  // ── Claude API Communication ───────────────────────────────────────

  function askClaude(question, options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${CONFIG.SERVER_URL}/answer`,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ question, options }),
        onload: (response) => {
          try {
            const data = JSON.parse(response.responseText);
            if (data.error) {
              reject(new Error(data.error));
            } else {
              resolve(data.answer);
            }
          } catch (e) {
            reject(e);
          }
        },
        onerror: (err) => {
          reject(new Error("Could not reach local server. Is it running?"));
        },
      });
    });
  }

  // ── Action Handlers ────────────────────────────────────────────────

  async function handleContentSlide(pageState) {
    setStatus("Content slide - advancing...");
    const delay = randomBetween(CONFIG.SLIDE_DELAY_MIN, CONFIG.SLIDE_DELAY_MAX);
    await sleep(delay);
    pageState.el.click();
    stats.slides++;
    updateStats();
  }

  async function handleEmbeddedQuestion(pageState) {
    setStatus("Embedded question - asking Claude...");
    const doc = pageState.doc || document;
    const question = extractQuestionText(doc);
    const options = extractOptions(pageState.radios);

    if (!question || options.length === 0) {
      setStatus("Could not extract question, trying next option...");
      stats.errors++;
      // Click first option as fallback
      pageState.radios[0].click();
      await sleep(CONFIG.QUESTION_DELAY);
      const proceedBtn = findButtonByText("Proceed") || findButtonByText("Next") || findButtonByText("Submit");
      if (proceedBtn) proceedBtn.click();
      return;
    }

    try {
      const answerIdx = await askClaude(question, options);
      setStatus(`Answer: ${answerIdx} - ${options[answerIdx]}`);
      pageState.radios[answerIdx]?.click();
      stats.questions++;
      updateStats();

      await sleep(CONFIG.QUESTION_DELAY);

      // Click submit/proceed button
      const btn =
        findButtonByText("Submit") ||
        findButtonByText("Answer") ||
        findButtonByText("Next") ||
        findButtonByText("Check") ||
        findButtonByText("Proceed");
      if (btn) btn.click();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      stats.errors++;
      updateStats();
    }
  }

  async function handleQuizStart(pageState) {
    setStatus("Starting quiz...");
    await sleep(2000);
    pageState.el.click();
    stats.quizzes++;
    updateStats();
  }

  async function handleQuizQuestion(pageState) {
    setStatus("Quiz question - asking Claude...");
    const question = extractQuestionText(document);
    const options = extractOptions(pageState.radios);

    if (!question || options.length === 0) {
      setStatus("Could not extract quiz question");
      stats.errors++;
      // Fallback: pick first option
      pageState.radios[0].click();
      await sleep(1000);
      const btn = pageState.submitBtn || pageState.proceedBtn || findButtonByText("Submit") || findButtonByText("Next");
      if (btn) btn.click();
      return;
    }

    try {
      const answerIdx = await askClaude(question, options);
      setStatus(`Quiz answer: ${answerIdx} - ${options[answerIdx]}`);
      pageState.radios[answerIdx]?.click();
      stats.questions++;
      updateStats();

      await sleep(2000);

      // Click the submit/proceed button
      const btn =
        pageState.submitBtn ||
        pageState.proceedBtn ||
        findButtonByText("Submit") ||
        findButtonByText("Answer") ||
        findButtonByText("Next");
      if (btn) btn.click();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      stats.errors++;
      updateStats();
    }
  }

  async function handleQuizCorrect(pageState) {
    setStatus("Correct! Proceeding...");
    await sleep(CONFIG.QUESTION_DELAY);
    pageState.el.click();
  }

  async function handleQuizPassed(pageState) {
    setStatus("Quiz passed! Proceeding...");
    await sleep(3000);
    if (pageState.proceedBtn) {
      pageState.proceedBtn.click();
    } else {
      // Try to find any proceed/continue button
      const btn = findButtonByText("Proceed") || findButtonByText("Continue") || findButtonByText("Next");
      if (btn) btn.click();
    }
  }

  async function handleQuizFailed(pageState) {
    setStatus("Quiz failed - going back to review...");
    stats.errors++;
    updateStats();
    await sleep(3000);
    if (pageState.goBackBtn) {
      pageState.goBackBtn.click();
    }
  }

  async function handleQuizResultScreen(pageState) {
    // Determine pass or fail from page text
    const text = document.body.innerText.toLowerCase();
    if (text.includes("congratulations") || text.includes("passed")) {
      await handleQuizPassed(pageState);
    } else {
      await handleQuizFailed(pageState);
    }
  }

  // ── Main Loop ──────────────────────────────────────────────────────

  async function tick() {
    if (!running) return;

    try {
      const pageState = getPageType();
      setStatus(`Detected: ${pageState.type}`);

      switch (pageState.type) {
        case "CONTENT_SLIDE":
          await handleContentSlide(pageState);
          break;
        case "EMBEDDED_QUESTION":
          await handleEmbeddedQuestion(pageState);
          break;
        case "QUIZ_START":
          await handleQuizStart(pageState);
          break;
        case "QUIZ_QUESTION":
          await handleQuizQuestion(pageState);
          break;
        case "QUIZ_CORRECT":
          await handleQuizCorrect(pageState);
          break;
        case "QUIZ_PASSED":
          await handleQuizPassed(pageState);
          break;
        case "QUIZ_FAILED":
          await handleQuizFailed(pageState);
          break;
        case "QUIZ_RESULT_SCREEN":
          await handleQuizResultScreen(pageState);
          break;
        case "UNKNOWN":
          setStatus("Unknown page state - waiting...");
          break;
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      stats.errors++;
      updateStats();
    }

    if (running) {
      loopTimeout = setTimeout(tick, CONFIG.POLL_INTERVAL);
    }
  }

  // ── Keepalive ──────────────────────────────────────────────────────

  function keepalive() {
    // Simulate small mouse movement to prevent inactivity timeout
    const event = new MouseEvent("mousemove", {
      clientX: 400 + Math.random() * 10,
      clientY: 400 + Math.random() * 10,
    });
    document.dispatchEvent(event);
  }

  // ── Start / Stop ──────────────────────────────────────────────────

  function start() {
    if (running) return;
    running = true;
    setStatus("Running...");
    keepaliveInterval = setInterval(keepalive, CONFIG.KEEPALIVE_INTERVAL);
    tick();
  }

  function stop() {
    running = false;
    if (loopTimeout) clearTimeout(loopTimeout);
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    setStatus("Stopped");
  }

  // ── Utilities ──────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ── Init ───────────────────────────────────────────────────────────

  // Wait for page to fully load before creating panel
  if (document.readyState === "complete") {
    createPanel();
  } else {
    window.addEventListener("load", createPanel);
  }
})();
