// ==UserScript==
// @name         TrainingCove Course Bot
// @namespace    trainingcove-bot
// @version      2.0
// @description  Auto-navigates TrainingCove course, answers questions via local Claude API server
// @match        https://www.trainingcove.com/Members/Courses/go.aspx*
// @match        https://trainingcove.com/Members/Courses/go.aspx*
// @match        https://www.trainingcove.com/Members/Quiz.aspx*
// @match        https://trainingcove.com/Members/Quiz.aspx*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────
  const CONFIG = {
    SERVER_URL: "http://localhost:3847",
    SLIDE_DELAY_MIN: 1000, // 1s min between slide advances
    SLIDE_DELAY_MAX: 3000, // 3s max
    QUESTION_DELAY: 1500, // 1.5s after answering before proceeding
    POLL_INTERVAL: 1500, // 1.5s between page state checks
    KEEPALIVE_INTERVAL: 600000, // 10 min keepalive
    TIMER_CHECK_INTERVAL: 60000, // 1 min between "Update Time Remaining" clicks
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
      <div style="font-weight:bold;margin-bottom:6px;">TC Bot</div>
      <div id="tcbot-status">Stopped</div>
      <div id="tcbot-stats" style="font-size:11px;margin-top:4px;"></div>
      <div style="margin-top:8px;">
        <button id="tcbot-start" style="margin-right:4px;padding:4px 10px;cursor:pointer;">Start</button>
        <button id="tcbot-stop" style="padding:4px 10px;cursor:pointer;">Stop</button>
      </div>
      <div id="tcbot-log" style="font-size:10px;margin-top:6px;max-height:100px;overflow-y:auto;color:#aaa;"></div>
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
      minWidth: "200px",
      maxWidth: "300px",
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

  function logMsg(msg) {
    const el = document.getElementById("tcbot-log");
    if (el) {
      const line = document.createElement("div");
      line.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
      // Keep only last 20 lines
      while (el.children.length > 20) el.removeChild(el.firstChild);
    }
    console.log(`[TCBot] ${msg}`);
  }

  function updateStats() {
    const el = document.getElementById("tcbot-stats");
    if (el) {
      el.textContent = `Slides:${stats.slides} Q:${stats.questions} Quiz:${stats.quizzes} Err:${stats.errors}`;
    }
  }

  // ── Page Type Detection ────────────────────────────────────────────

  function getPageType() {
    const url = window.location.href;
    const bodyText = document.body.innerText || "";

    // ─── Quiz pages (Quiz.aspx) ───
    if (url.includes("Quiz.aspx")) {
      return detectQuizPageType(bodyText);
    }

    // ─── Course content pages (go.aspx) ───
    return detectCoursePageType(bodyText);
  }

  function detectQuizPageType(bodyText) {
    // "Begin Quiz" button
    const beginBtn = findButtonByText("Begin Quiz");
    if (beginBtn) return { type: "QUIZ_START", el: beginBtn };

    // "Correct! - Click To Proceed"
    const correctBtn = findButtonByText("Correct!");
    if (correctBtn) return { type: "QUIZ_CORRECT", el: correctBtn };

    // Radio buttons = active quiz question
    const radios = document.querySelectorAll('input[type="radio"]');
    if (radios.length > 0) {
      const submitBtn =
        findButtonByText("Submit") ||
        findButtonByText("Answer") ||
        findButtonByText("Next") ||
        findButtonByText("Check");
      const proceedBtn = findButtonByText("Proceed");
      return { type: "QUIZ_QUESTION", radios, submitBtn, proceedBtn };
    }

    // Pass/fail result
    const proceedBtn = findButtonByText("Proceed");
    const goBackBtn = findButtonByText("Go Back");
    const lowerText = bodyText.toLowerCase();

    if (lowerText.includes("congratulations") || lowerText.includes("you passed")) {
      return { type: "QUIZ_PASSED", proceedBtn };
    }
    if (lowerText.includes("did not pass") || lowerText.includes("you failed")) {
      return { type: "QUIZ_FAILED", goBackBtn };
    }

    // Generic proceed/go-back screen
    if (proceedBtn && !goBackBtn) return { type: "QUIZ_CORRECT", el: proceedBtn };
    if (proceedBtn && goBackBtn) return { type: "QUIZ_RESULT_SCREEN", proceedBtn, goBackBtn };

    return { type: "UNKNOWN" };
  }

  function detectCoursePageType(bodyText) {
    const lowerText = bodyText.toLowerCase();

    // Check for section completion - "Click to Proceed" after completing section
    const clickToProceed = findButtonByText("Click to Proceed");
    if (clickToProceed && lowerText.includes("completed this section")) {
      return { type: "SECTION_COMPLETE", el: clickToProceed };
    }

    // Check for "End of Section" with time remaining
    if (lowerText.includes("end of section")) {
      const updateBtn = findButtonByText("Update Time Remaining");
      const goBackBtn = findButtonByText("Go Back and Review");
      const timeMatch = bodyText.match(/spend\s+(\d+)\s+more\s+minute/i);
      const minutesLeft = timeMatch ? parseInt(timeMatch[1], 10) : 0;
      const forwardArrow = findForwardArrow();

      if (!timeMatch && clickToProceed) {
        return { type: "SECTION_COMPLETE", el: clickToProceed };
      }

      return {
        type: "END_OF_SECTION",
        updateBtn,
        goBackBtn,
        minutesLeft,
        forwardArrow,
      };
    }

    // Check for any generic "Click to Proceed" on course pages
    if (clickToProceed) {
      return { type: "SECTION_COMPLETE", el: clickToProceed };
    }

    // Check for True/False question buttons
    const trueBtn = document.getElementById("ctl00_SlidePlaceHolder_True");
    const falseBtn = document.getElementById("ctl00_SlidePlaceHolder_False");
    if (trueBtn && falseBtn && trueBtn.offsetWidth > 0) {
      // Check if already answered: one button is disabled/grayed out, or answer text shown below
      const trueDisabled = trueBtn.disabled || trueBtn.style.opacity === "0.5" || trueBtn.style.display === "none";
      const falseDisabled = falseBtn.disabled || falseBtn.style.opacity === "0.5" || falseBtn.style.display === "none";
      const bothEnabled = !trueDisabled && !falseDisabled;

      // If both buttons are still fully enabled, it's an unanswered question
      if (bothEnabled) {
        return {
          type: "TRUE_FALSE_QUESTION",
          trueBtn,
          falseBtn,
          doc: document,
        };
      }
      // Otherwise already answered - click Next to proceed
      const forwardArrow = findForwardArrow();
      if (forwardArrow) {
        return { type: "CONTENT_SLIDE", el: forwardArrow };
      }
    }

    // Check for multiple-choice answer buttons (A/B/C/D style)
    const mcButtons = document.querySelectorAll('input.AnswerButton, input[class*="Answer"], input[class*="Choice"], input[class*="Option"]');
    if (mcButtons.length > 1) {
      return {
        type: "MULTIPLE_CHOICE_QUESTION",
        buttons: mcButtons,
        doc: document,
      };
    }

    // Check for radio button questions (fallback)
    const radios = document.querySelectorAll('input[type="radio"]');
    if (radios.length > 0) {
      return { type: "EMBEDDED_QUESTION", radios, doc: document };
    }

    // Check iframes for questions
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        const iframeRadios = iframeDoc.querySelectorAll('input[type="radio"]');
        if (iframeRadios.length > 0) {
          return { type: "EMBEDDED_QUESTION", radios: iframeRadios, doc: iframeDoc };
        }
      } catch (e) {}
    }

    // Regular content slide - find forward arrow
    const forwardArrow = findForwardArrow();
    if (forwardArrow) {
      return { type: "CONTENT_SLIDE", el: forwardArrow };
    }

    return { type: "UNKNOWN" };
  }

  // ── DOM Helpers ────────────────────────────────────────────────────

  function findButtonByText(text) {
    const selectors =
      "button, input[type='button'], input[type='submit'], input[type='image'], a.btn, a[class*='btn'], a[href], [role='button']";
    const elements = document.querySelectorAll(selectors);
    const lowerText = text.toLowerCase();
    for (const el of elements) {
      const elText = (el.textContent || el.value || "").trim().toLowerCase();
      if (elText.includes(lowerText)) {
        // Check if visible
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          return el;
        }
      }
    }
    // Also check inside iframes
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        const els = doc.querySelectorAll(selectors);
        for (const el of els) {
          const elText = (el.textContent || el.value || "").trim().toLowerCase();
          if (elText.includes(lowerText) && el.offsetWidth > 0 && el.offsetHeight > 0) {
            return el;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function findForwardArrow() {
    // The forward arrow is: INPUT.SlideNext with id ctl00_SlidePlaceHolder_Next
    const next = document.getElementById("ctl00_SlidePlaceHolder_Next");
    if (next && next.offsetWidth > 0) return next;

    // Fallback: look by class name
    const byClass = document.querySelector(".SlideNext, input.SlideNext");
    if (byClass && byClass.offsetWidth > 0) return byClass;

    return null;
  }

  function extractQuestionText(doc) {
    // Look for question text - prioritize elements with "?"
    const candidates = doc.querySelectorAll(
      "h1, h2, h3, h4, h5, .question, .question-text, [class*='question'], [class*='Question'], strong, b, p, td, div"
    );
    let best = "";
    // First pass: find text with question mark
    for (const el of candidates) {
      const text = el.textContent.trim();
      if (text.includes("?") && text.length > best.length && text.length < 500) {
        best = text;
      }
    }
    // Second pass: longest substantial text block
    if (!best) {
      for (const el of candidates) {
        const text = el.textContent.trim();
        if (text.length > 30 && text.length < 500 && text.length > best.length) {
          best = text;
        }
      }
    }
    return best;
  }

  function extractOptions(radios) {
    const options = [];
    const doc = radios[0]?.ownerDocument || document;
    for (const radio of radios) {
      let label = "";
      // Method 1: <label for="id">
      if (radio.id) {
        const labelEl = doc.querySelector(`label[for="${radio.id}"]`);
        if (labelEl) label = labelEl.textContent.trim();
      }
      // Method 2: Parent label element
      if (!label) {
        const parentLabel = radio.closest("label");
        if (parentLabel) {
          label = parentLabel.textContent.trim();
        }
      }
      // Method 3: Parent container text (li, div, td, span)
      if (!label) {
        const parent = radio.closest("li, td, div, span");
        if (parent) {
          // Get text content excluding nested radio buttons
          label = parent.textContent.trim();
        }
      }
      // Method 4: Next sibling text node
      if (!label && radio.nextSibling) {
        label = (radio.nextSibling.textContent || "").trim();
      }
      // Method 5: Next element sibling
      if (!label && radio.nextElementSibling) {
        label = radio.nextElementSibling.textContent.trim();
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
        timeout: 30000,
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
        onerror: () => reject(new Error("Cannot reach server. Is it running?")),
        ontimeout: () => reject(new Error("Server timeout")),
      });
    });
  }

  // ── Action Handlers ────────────────────────────────────────────────

  async function handleContentSlide(pageState) {
    const delay = randomBetween(CONFIG.SLIDE_DELAY_MIN, CONFIG.SLIDE_DELAY_MAX);
    setStatus(`Slide - waiting ${Math.round(delay / 1000)}s...`);
    await sleep(delay);
    pageState.el.click();
    stats.slides++;
    updateStats();
    logMsg(`Advanced slide (${stats.slides} total)`);
  }

  async function handleEndOfSection(pageState) {
    if (pageState.minutesLeft > 0) {
      setStatus(`End of section - ${pageState.minutesLeft}m remaining`);
      logMsg(`Waiting for timer: ${pageState.minutesLeft} min left`);

      // Click "Update Time Remaining" periodically
      if (pageState.updateBtn) {
        await sleep(CONFIG.TIMER_CHECK_INTERVAL);
        pageState.updateBtn.click();
        logMsg("Clicked Update Time Remaining");
      } else {
        await sleep(CONFIG.TIMER_CHECK_INTERVAL);
      }
      return; // Will re-check on next tick
    }

    // Timer is done (0 minutes left) - click forward arrow to proceed
    setStatus("Section timer complete - advancing...");
    logMsg("Section timer done, moving forward");
    await sleep(3000);
    if (pageState.forwardArrow) {
      pageState.forwardArrow.click();
    }
  }

  async function handleTrueFalseQuestion(pageState) {
    setStatus("True/False question - asking Claude...");
    const question = extractQuestionText(pageState.doc || document);
    logMsg(`T/F Q: ${question.substring(0, 80)}`);

    try {
      const answerIdx = await askClaude(question, ["True", "False"]);
      const btn = answerIdx === 0 ? pageState.trueBtn : pageState.falseBtn;
      setStatus(`Answer: ${answerIdx === 0 ? "True" : "False"}`);
      logMsg(`Claude says: ${answerIdx === 0 ? "True" : "False"}`);
      stats.questions++;
      updateStats();
      btn.click();
      // After clicking answer, wait for page to update then click Next arrow
      await sleep(2000);
      const nextArrow = findForwardArrow();
      if (nextArrow) {
        logMsg("Clicking Next to advance past answered question");
        nextArrow.click();
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      logMsg(`ERROR: ${err.message}`);
      stats.errors++;
      updateStats();
      pageState.trueBtn.click();
      await sleep(2000);
      const nextArrow = findForwardArrow();
      if (nextArrow) nextArrow.click();
    }
  }

  async function handleMultipleChoiceQuestion(pageState) {
    setStatus("Multiple choice - asking Claude...");
    const question = extractQuestionText(pageState.doc || document);
    const options = Array.from(pageState.buttons).map(btn => (btn.value || btn.textContent || "").trim());
    logMsg(`MC Q: ${question.substring(0, 80)}`);
    logMsg(`Options: ${options.join(" | ")}`);

    try {
      const answerIdx = await askClaude(question, options);
      setStatus(`Answer: ${options[answerIdx]}`);
      logMsg(`Claude says: ${answerIdx} - ${options[answerIdx]}`);
      stats.questions++;
      updateStats();
      if (pageState.buttons[answerIdx]) {
        pageState.buttons[answerIdx].click();
      } else {
        pageState.buttons[0].click();
      }
      // After clicking answer, wait then click Next arrow
      await sleep(2000);
      const nextArrow = findForwardArrow();
      if (nextArrow) {
        logMsg("Clicking Next to advance past answered question");
        nextArrow.click();
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      logMsg(`ERROR: ${err.message}`);
      stats.errors++;
      updateStats();
      pageState.buttons[0].click();
      await sleep(2000);
      const nextArrow = findForwardArrow();
      if (nextArrow) nextArrow.click();
    }
  }

  async function handleEmbeddedQuestion(pageState) {
    setStatus("Question - asking Claude...");
    const doc = pageState.doc || document;
    const question = extractQuestionText(doc);
    const options = extractOptions(pageState.radios);

    logMsg(`Q: ${question.substring(0, 60)}...`);
    logMsg(`Options: ${options.join(" | ")}`);

    if (!question || options.length === 0) {
      setStatus("Could not extract question");
      logMsg("ERROR: Could not extract question text or options");
      stats.errors++;
      updateStats();
      // Fallback: click first option
      pageState.radios[0].click();
      await sleep(CONFIG.QUESTION_DELAY);
      const btn = findButtonByText("Proceed") || findButtonByText("Next") || findButtonByText("Submit");
      if (btn) btn.click();
      return;
    }

    try {
      const answerIdx = await askClaude(question, options);
      setStatus(`Answer: ${options[answerIdx] || answerIdx}`);
      logMsg(`Claude says: ${answerIdx} - ${options[answerIdx]}`);
      if (pageState.radios[answerIdx]) {
        pageState.radios[answerIdx].click();
      } else {
        logMsg(`ERROR: Invalid index ${answerIdx}, clicking 0`);
        pageState.radios[0].click();
      }
      stats.questions++;
      updateStats();

      await sleep(CONFIG.QUESTION_DELAY);

      // Click submit/proceed
      const btn =
        findButtonByText("Submit") ||
        findButtonByText("Answer") ||
        findButtonByText("Next") ||
        findButtonByText("Check") ||
        findButtonByText("Proceed");
      if (btn) {
        logMsg(`Clicking: ${btn.textContent.trim()}`);
        btn.click();
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      logMsg(`ERROR: ${err.message}`);
      stats.errors++;
      updateStats();
    }
  }

  async function handleQuizStart(pageState) {
    setStatus("Starting quiz...");
    logMsg("Clicking Begin Quiz");
    await sleep(2000);
    pageState.el.click();
    stats.quizzes++;
    updateStats();
  }

  async function handleQuizQuestion(pageState) {
    setStatus("Quiz question - asking Claude...");
    const question = extractQuestionText(document);
    const options = extractOptions(pageState.radios);

    logMsg(`Quiz Q: ${question.substring(0, 60)}...`);
    logMsg(`Options: ${options.join(" | ")}`);

    if (!question || options.length === 0) {
      setStatus("Could not extract quiz question");
      logMsg("ERROR: Could not extract quiz question");
      stats.errors++;
      pageState.radios[0].click();
      await sleep(1000);
      const btn = pageState.submitBtn || pageState.proceedBtn || findButtonByText("Submit") || findButtonByText("Next");
      if (btn) btn.click();
      return;
    }

    try {
      const answerIdx = await askClaude(question, options);
      setStatus(`Quiz answer: ${options[answerIdx] || answerIdx}`);
      logMsg(`Claude says: ${answerIdx} - ${options[answerIdx]}`);
      if (pageState.radios[answerIdx]) {
        pageState.radios[answerIdx].click();
      } else {
        pageState.radios[0].click();
      }
      stats.questions++;
      updateStats();

      await sleep(2000);

      const btn =
        pageState.submitBtn ||
        pageState.proceedBtn ||
        findButtonByText("Submit") ||
        findButtonByText("Answer") ||
        findButtonByText("Next");
      if (btn) {
        logMsg(`Clicking: ${btn.textContent.trim()}`);
        btn.click();
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      logMsg(`ERROR: ${err.message}`);
      stats.errors++;
      updateStats();
    }
  }

  async function handleQuizCorrect(pageState) {
    setStatus("Correct! Proceeding...");
    logMsg("Correct answer - proceeding");
    await sleep(CONFIG.QUESTION_DELAY);
    pageState.el.click();
  }

  async function handleQuizPassed(pageState) {
    setStatus("Quiz passed!");
    logMsg("Quiz PASSED - proceeding");
    await sleep(3000);
    const btn = pageState.proceedBtn || findButtonByText("Proceed") || findButtonByText("Continue") || findButtonByText("Next");
    if (btn) btn.click();
  }

  async function handleQuizFailed(pageState) {
    setStatus("Quiz failed - retrying...");
    logMsg("Quiz FAILED - going back to review");
    stats.errors++;
    updateStats();
    await sleep(3000);
    if (pageState.goBackBtn) {
      pageState.goBackBtn.click();
    }
  }

  async function handleQuizResultScreen(pageState) {
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

      switch (pageState.type) {
        case "CONTENT_SLIDE":
          await handleContentSlide(pageState);
          break;
        case "SECTION_COMPLETE":
          setStatus("Section complete - proceeding...");
          logMsg("Section complete, clicking proceed");
          await sleep(3000);
          pageState.el.click();
          break;
        case "END_OF_SECTION":
          await handleEndOfSection(pageState);
          break;
        case "TRUE_FALSE_QUESTION":
          await handleTrueFalseQuestion(pageState);
          break;
        case "MULTIPLE_CHOICE_QUESTION":
          await handleMultipleChoiceQuestion(pageState);
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
          setStatus("Unknown page - waiting...");
          break;
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      logMsg(`ERROR: ${err.message}`);
      stats.errors++;
      updateStats();
    }

    if (running) {
      loopTimeout = setTimeout(tick, CONFIG.POLL_INTERVAL);
    }
  }

  // ── Keepalive ──────────────────────────────────────────────────────

  function keepalive() {
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
    GM_setValue("tcbot_running", true);
    setStatus("Running...");
    logMsg("Bot started");
    keepaliveInterval = setInterval(keepalive, CONFIG.KEEPALIVE_INTERVAL);
    tick();
  }

  function stop() {
    running = false;
    GM_setValue("tcbot_running", false);
    if (loopTimeout) clearTimeout(loopTimeout);
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    setStatus("Stopped");
    logMsg("Bot stopped");
  }

  // ── Utilities ──────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ── Init ───────────────────────────────────────────────────────────

  function init() {
    createPanel();
    // Auto-resume if bot was running before page reload
    if (GM_getValue("tcbot_running", false)) {
      setTimeout(() => {
        logMsg("Auto-resuming after page load...");
        start();
      }, 2000); // Wait 2s for page to settle
    }
  }

  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }
})();
