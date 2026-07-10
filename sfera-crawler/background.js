/* eslint-disable no-undef */
/**
 * Sfera Crawler — Background Service Worker (MV3)
 * Orchestrates crawling through change numbers and tabs,
 * accumulates data, persists progress, handles errors.
 */

(function () {
  "use strict";

  // ─────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────
  var __sfera_crawler_bg_TABS = [
    "mainInfo",
    "influence",
    "relatedItems",
    "riskLevel",
    "implementationTasks",
    "implementationDecision",
    "authorization",
    "result",
    "actualImpact",
    "calendar",
  ];

  var __sfera_crawler_bg_BASE_URL =
    "https://sfera.vtb.ru/ppcg-fw/change-tasks/";

  var __sfera_crawler_bg_STORAGE_KEY = "crawlerProgress";
  var __sfera_crawler_bg_PAGE_TIMEOUT = 30000; // 30s per page
  var __sfera_crawler_bg_MAX_RETRIES = 3;
  var __sfera_crawler_bg_DEFAULT_CONCURRENCY = 3; // parallel worker tabs
  var __sfera_crawler_bg_MAX_CONCURRENCY = 5;
  var __sfera_crawler_bg_LOG_MAX = 50;

  // ─────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────

  var __sfera_crawler_bg_state = null;
  var __sfera_crawler_bg_crawlerTabIds = [];    // array of tab IDs (parallel workers)
  var __sfera_crawler_bg_collectedData = {};
  var __sfera_crawler_bg_isCrawling = false;
  var __sfera_crawler_bg_stopRequested = false;
  var __sfera_crawler_bg_log = [];
  var __sfera_crawler_bg_errors = [];
  var __sfera_crawler_bg_pageDataMap = {};      // key: "changeNumber:tabName", value: { resolve, reject, timeoutId }
  var __sfera_crawler_bg_changeQueue = [];      // queue of change numbers to process
  var __sfera_crawler_bg_activeWorkers = 0;     // how many workers are currently running
  var __sfera_crawler_bg_tabBusy = [];          // parallel to crawlerTabIds, true=in use
  var __sfera_crawler_bg_navigationListener = null;
  var __sfera_crawler_bg_interceptorRegistered = false;

  // ─────────────────────────────────────────────
  // Logging
  // ─────────────────────────────────────────────

  function __sfera_crawler_bg_addLog(message) {
    var timestamp = new Date().toISOString();
    var entry = "[" + timestamp + "] " + message;
    __sfera_crawler_bg_log.push(entry);
    if (__sfera_crawler_bg_log.length > __sfera_crawler_bg_LOG_MAX) {
      __sfera_crawler_bg_log.shift();
    }
    console.log("[SferaCrawler]", message);
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  function __sfera_crawler_bg_sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Format number to C-VTB-XXXXXXXX (padded to at least 8 digits).
   */
  function __sfera_crawler_bg_formatChangeNumber(num) {
    var numStr = String(num);
    while (numStr.length < 8) {
      numStr = "0" + numStr;
    }
    return "C-VTB-" + numStr;
  }

  /**
   * Parse change number from a C-VTB-XXXXX string or number.
   */
  function __sfera_crawler_bg_parseChangeNumber(raw) {
    if (typeof raw === "number") {
      return __sfera_crawler_bg_formatChangeNumber(raw);
    }
    if (typeof raw === "string") {
      var match = raw.match(/^C-VTB-(\d+)$/i);
      if (match) {
        return raw.toUpperCase();
      }
      // Try as plain number string
      var numMatch = raw.match(/^(\d+)$/);
      if (numMatch) {
        return __sfera_crawler_bg_formatChangeNumber(numMatch[1]);
      }
    }
    return null;
  }

  /**
   * Build URL for a change number and tab.
   */
  function __sfera_crawler_bg_buildUrl(changeNumber, tabName) {
    return __sfera_crawler_bg_BASE_URL + changeNumber + "?tab=" + tabName;
  }

  /**
   * Get the user-facing tab name from index.
   */
  function __sfera_crawler_bg_getTabName(index) {
    if (index >= 0 && index < __sfera_crawler_bg_TABS.length) {
      return __sfera_crawler_bg_TABS[index];
    }
    return null;
  }

  /**
   * Determine the next change number string.
   */
  function __sfera_crawler_bg_nextNumber(currentStr) {
    var match = currentStr.match(/^C-VTB-(\d+)$/i);
    if (!match) return null;
    var num = parseInt(match[1], 10);
    if (isNaN(num)) return null;
    return __sfera_crawler_bg_formatChangeNumber(num + 1);
  }

  // ─────────────────────────────────────────────
  // Main-world API Interceptor Lifecycle
  // ─────────────────────────────────────────────

  /**
   * Register the main-world API interceptor content script so it runs
   * automatically on every sfera.vtb.ru page load at document_start,
   * BEFORE page scripts execute. The interceptor patches fetch/XHR in
   * the MAIN world (where page scripts actually run) and bridges
   * captured data to the content script via postMessage.
   */
  function __sfera_crawler_bg_registerInterceptor() {
    if (__sfera_crawler_bg_interceptorRegistered) return;

    try {
      chrome.scripting
        .registerContentScripts([
          {
            id: "api-interceptor",
            matches: ["https://sfera.vtb.ru/*"],
            js: ["api-interceptor.js"],
            world: "MAIN",
            runAt: "document_start",
            allFrames: false,
          },
        ])
        .then(function () {
          __sfera_crawler_bg_interceptorRegistered = true;
          __sfera_crawler_bg_addLog(
            "API-перехватчик зарегистрирован (main world)"
          );
        })
        .catch(function (err) {
          // "Duplicate script ID" happens if service worker restarted but
          // Chrome still has the registration — treat as success
          if (err.message && err.message.indexOf("Duplicate") !== -1) {
            __sfera_crawler_bg_interceptorRegistered = true;
            __sfera_crawler_bg_addLog(
              "API-перехватчик уже был зарегистрирован"
            );
          } else {
            __sfera_crawler_bg_addLog(
              "Ошибка регистрации перехватчика: " + err.message
            );
          }
        });
    } catch (e) {
      __sfera_crawler_bg_addLog(
        "Ошибка registerContentScripts: " + e.message
      );
    }
  }

  /**
   * Unregister the main-world API interceptor — crawling is done.
   */
  function __sfera_crawler_bg_unregisterInterceptor() {
    if (!__sfera_crawler_bg_interceptorRegistered) return;

    try {
      chrome.scripting
        .unregisterContentScripts({ ids: ["api-interceptor"] })
        .then(function () {
          __sfera_crawler_bg_interceptorRegistered = false;
          __sfera_crawler_bg_addLog("API-перехватчик удалён");
        })
        .catch(function (err) {
          // Ignore "not found" errors — already unregistered
          if (err.message && err.message.indexOf("not found") === -1) {
            __sfera_crawler_bg_addLog(
              "Ошибка удаления перехватчика: " + err.message
            );
          }
          __sfera_crawler_bg_interceptorRegistered = false;
        });
    } catch (e) {
      __sfera_crawler_bg_addLog(
        "Ошибка unregisterContentScripts: " + e.message
      );
    }
  }

  /**
   * Check if crawling should stop — includes queue state.
   */
  function __sfera_crawler_bg_shouldStopOnQueue() {
    if (__sfera_crawler_bg_stopRequested) return true;
    var state = __sfera_crawler_bg_state;
    if (!state) return true;
    if (state.consecutiveErrors >=
        (state.settings ? state.settings.maxErrors : 10)) return true;

    // If queue is empty AND no workers are active, we're done
    if (__sfera_crawler_bg_changeQueue.length === 0 && __sfera_crawler_bg_activeWorkers === 0) {
      if (state.settings && state.settings.endNumber) {
        var currentNum = parseInt(
          state.currentNumber.replace("C-VTB-", ""), 10
        );
        if (currentNum > state.settings.endNumber) return true;
      }
      return true; // No more work
    }

    return false;
  }

  // ─────────────────────────────────────────────
  // State Persistence
  // ─────────────────────────────────────────────

  function __sfera_crawler_bg_buildState() {
    return {
      status: "running",
      currentNumber: null,
      currentTabIndex: 0,
      collectedData: __sfera_crawler_bg_collectedData,
      errors: __sfera_crawler_bg_errors,
      consecutiveErrors: 0,
      settings: null,
      startedAt: new Date().toISOString(),
      log: __sfera_crawler_bg_log,
    };
  }

  function __sfera_crawler_bg_saveProgress() {
    try {
      var state = __sfera_crawler_bg_state;
      if (!state) return;
      state.collectedData = __sfera_crawler_bg_collectedData;
      state.errors = __sfera_crawler_bg_errors;
      state.log = __sfera_crawler_bg_log;
      chrome.storage.local.set({ crawlerProgress: state }, function () {
        if (chrome.runtime.lastError) {
          console.error(
            "[SferaCrawler] Failed to save progress:",
            chrome.runtime.lastError
          );
        }
      });
    } catch (e) {
      console.error("[SferaCrawler] saveProgress error:", e);
    }
  }

  function __sfera_crawler_bg_loadProgress(callback) {
    try {
      chrome.storage.local.get("crawlerProgress", function (result) {
        if (chrome.runtime.lastError) {
          console.error(
            "[SferaCrawler] Failed to load progress:",
            chrome.runtime.lastError
          );
          callback(null);
          return;
        }
        callback(result.crawlerProgress || null);
      });
    } catch (e) {
      console.error("[SferaCrawler] loadProgress error:", e);
      callback(null);
    }
  }

  function __sfera_crawler_bg_clearProgress() {
    try {
      chrome.storage.local.remove("crawlerProgress", function () {
        if (chrome.runtime.lastError) {
          console.error(
            "[SferaCrawler] Failed to clear progress:",
            chrome.runtime.lastError
          );
        }
      });
    } catch (e) {
      console.error("[SferaCrawler] clearProgress error:", e);
    }
  }

  // ─────────────────────────────────────────────
  // Status Updates to Popup
  // ─────────────────────────────────────────────

  function __sfera_crawler_bg_sendStatus() {
    try {
      var state = __sfera_crawler_bg_state;
      var effectiveStatus = "stopped";
      if (__sfera_crawler_bg_isCrawling) {
        effectiveStatus = "running";
      } else if (state && state.status) {
        effectiveStatus = state.status;
      }
      var payload = {
        status: effectiveStatus,
        currentNumber: state ? state.currentNumber : null,
        currentTab: state
          ? __sfera_crawler_bg_getTabName(state.currentTabIndex)
          : null,
        processedCount: state
          ? Object.keys(__sfera_crawler_bg_collectedData).length
          : 0,
        totalCount: state && state.settings ? 
          (state.settings.endNumber
            ? state.settings.endNumber - state.settings.startNumber + 1
            : "∞")
          : 0,
        errorsCount: __sfera_crawler_bg_errors.length,
        mode: state && state.settings ? state.settings.mode : "single",
        autoDownload: state && state.settings ? state.settings.autoDownload : false,
        log: __sfera_crawler_bg_log.slice(-20),
      };

      chrome.runtime.sendMessage(
        { type: "STATUS", payload: payload },
        function () {
          // Ignore error — popup may be closed
          void chrome.runtime.lastError;
        }
      );
    } catch (e) {
      // Popup may be closed
    }
  }

  // ─────────────────────────────────────────────
  // Tab Management
  // ─────────────────────────────────────────────

  /**
   * Create a single crawler tab and add to the pool.
   */
  function __sfera_crawler_bg_createTab(callback) {
    try {
      chrome.tabs.create(
        { url: "about:blank", active: false },
        function (tab) {
          if (chrome.runtime.lastError || !tab) {
            __sfera_crawler_bg_addLog(
              "Ошибка создания вкладки: " +
                (chrome.runtime.lastError
                  ? chrome.runtime.lastError.message
                  : "unknown")
            );
            callback(null);
            return;
          }
          __sfera_crawler_bg_crawlerTabIds.push(tab.id);
          callback(tab.id);
        }
      );
    } catch (e) {
      __sfera_crawler_bg_addLog("Ошибка createTab: " + e.message);
      callback(null);
    }
  }

  /**
   * Ensure we have at least `count` tabs in the pool.
   * Creates missing tabs and calls back with the full array of tab IDs.
   */
  function __sfera_crawler_bg_ensureTabs(count, callback) {
    var existing = [];
    var pending = 0;

    // Check which tabs still exist
    for (var i = 0; i < __sfera_crawler_bg_crawlerTabIds.length; i++) {
      var tid = __sfera_crawler_bg_crawlerTabIds[i];
      (function (tabId) {
        try {
          chrome.tabs.get(tabId, function (tab) {
            if (chrome.runtime.lastError || !tab) {
              // Remove dead tab from pool
              var idx = __sfera_crawler_bg_crawlerTabIds.indexOf(tabId);
              if (idx !== -1) __sfera_crawler_bg_crawlerTabIds.splice(idx, 1);
            } else {
              existing.push(tabId);
            }
            pending++;
            if (pending === __sfera_crawler_bg_crawlerTabIds.length) {
              finishEnsureTabs(existing);
            }
          });
        } catch (e) {
          pending++;
          if (pending === __sfera_crawler_bg_crawlerTabIds.length) {
            finishEnsureTabs(existing);
          }
        }
      })(tid);
    }

    if (__sfera_crawler_bg_crawlerTabIds.length === 0) {
      finishEnsureTabs(existing);
    }

    function finishEnsureTabs(validTabs) {
      __sfera_crawler_bg_crawlerTabIds = validTabs;
      var needed = count - validTabs.length;
      if (needed <= 0) {
        callback(validTabs.slice());
        return;
      }

      var created = [];
      var createdCount = 0;
      for (var k = 0; k < needed; k++) {
        (function () {
          try {
            chrome.tabs.create(
              { url: "about:blank", active: false },
              function (tab) {
                if (chrome.runtime.lastError || !tab) {
                  createdCount++;
                  if (createdCount >= needed) {
                    callback(created.length > 0 ? created : null);
                  }
                  return;
                }
                __sfera_crawler_bg_crawlerTabIds.push(tab.id);
                created.push(tab.id);
                createdCount++;
                if (createdCount >= needed) {
                  callback(created.length > 0 ? validTabs.concat(created) : null);
                }
              }
            );
          } catch (e) {
            createdCount++;
            if (createdCount >= needed) {
              callback(created.length > 0 ? validTabs.concat(created) : null);
            }
          }
        })();
      }
    }
  }

  /**
   * Close all crawler tabs.
   */
  function __sfera_crawler_bg_closeAllTabs() {
    var ids = __sfera_crawler_bg_crawlerTabIds.slice();
    __sfera_crawler_bg_crawlerTabIds = [];
    if (ids.length > 0) {
      try {
        chrome.tabs.remove(ids, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) {
        // ignore
      }
    }
    __sfera_crawler_bg_removeNavListener();
  }

  // ─────────────────────────────────────────────
  // Navigation Listener
  // ─────────────────────────────────────────────

  function __sfera_crawler_bg_setupNavListener() {
    __sfera_crawler_bg_removeNavListener();
    __sfera_crawler_bg_navigationListener = function (details) {
      if (
        __sfera_crawler_bg_crawlerTabIds.indexOf(details.tabId) !== -1 &&
        details.url &&
        details.url.indexOf("change-tasks/") !== -1
      ) {
        // Navigation completed — content script will send PAGE_DATA
        __sfera_crawler_bg_addLog(
          "Страница загружена: " + details.url
        );
      }
    };
    try {
      chrome.webNavigation.onCompleted.addListener(
        __sfera_crawler_bg_navigationListener,
        { url: [{ hostContains: "sfera.vtb.ru" }] }
      );
    } catch (e) {
      console.error("[SferaCrawler] Failed to add nav listener:", e);
    }
  }

  function __sfera_crawler_bg_removeNavListener() {
    if (__sfera_crawler_bg_navigationListener) {
      try {
        chrome.webNavigation.onCompleted.removeListener(
          __sfera_crawler_bg_navigationListener
        );
      } catch (e) {
        // ignore
      }
      __sfera_crawler_bg_navigationListener = null;
    }
  }

  // ─────────────────────────────────────────────
  // Wait for PAGE_DATA from Content Script
  // ─────────────────────────────────────────────

  function __sfera_crawler_bg_waitForPageData(
    changeNumber,
    tabName,
    timeoutMs
  ) {
    return new Promise(function (resolve, reject) {
      var key = changeNumber + ":" + tabName;

      // Check if data already arrived before we started waiting
      if (__sfera_crawler_bg_pageDataMap[key] && __sfera_crawler_bg_pageDataMap[key].data) {
        var pending = __sfera_crawler_bg_pageDataMap[key].data;
        delete __sfera_crawler_bg_pageDataMap[key];
        resolve(pending);
        return;
      }

      var timeoutId = setTimeout(function () {
        delete __sfera_crawler_bg_pageDataMap[key];
        reject(new Error("Timeout waiting for PAGE_DATA: " + changeNumber + " / " + tabName));
      }, timeoutMs);

      __sfera_crawler_bg_pageDataMap[key] = {
        resolve: function (message) {
          clearTimeout(timeoutId);
          resolve(message);
        },
        reject: reject,
        timeoutId: timeoutId,
      };
    });
  }

  // ─────────────────────────────────────────────
  // Process One Tab
  // ─────────────────────────────────────────────

  /**
   * Navigate one tab to a change's tab page and wait for PAGE_DATA.
   * @param {number} tabId - The Chrome tab ID to use.
   * @param {string} changeNumber - e.g. "C-VTB-00123456".
   * @param {number} tabIndex - Index into TABS array.
   */
  function __sfera_crawler_bg_processTab(tabId, changeNumber, tabIndex) {
    return new Promise(function (resolve, reject) {
      var tabName = __sfera_crawler_bg_getTabName(tabIndex);
      var url = __sfera_crawler_bg_buildUrl(changeNumber, tabName);

      __sfera_crawler_bg_addLog(
        "Навигация: " + changeNumber + " / " + tabName
      );
      __sfera_crawler_bg_sendStatus();

      // Navigate tab
      try {
        chrome.tabs.update(
          tabId,
          { url: url, active: false },
          function () {
            if (chrome.runtime.lastError) {
              reject(
                new Error(
                  "Ошибка навигации: " +
                    chrome.runtime.lastError.message
                )
              );
              return;
            }
          }
        );
      } catch (e) {
        reject(new Error("Ошибка chrome.tabs.update: " + e.message));
        return;
      }

      // Wait for PAGE_DATA
      __sfera_crawler_bg_waitForPageData(
        changeNumber,
        tabName,
        __sfera_crawler_bg_PAGE_TIMEOUT
      )
        .then(function (message) {
          __sfera_crawler_bg_addLog(
            "Данные получены: " + tabName + " (strategies: " +
              (message.strategies || []).join(",") + ")"
          );
          resolve({
            tabName: tabName,
            data: message.data || {},
            strategies: message.strategies || [],
            partial: message.partial || false,
          });
        })
        .catch(function (err) {
          __sfera_crawler_bg_addLog(
            "Ошибка: " + tabName + " — " + err.message
          );
          reject(err);
        });
    });
  }

  // ─────────────────────────────────────────────
  // Process One Change Number (all 10 tabs)
  // ─────────────────────────────────────────────

  /**
   * Process all 10 tabs of a change number using a given worker tab.
   * @param {number} tabId - The Chrome tab to use.
   * @param {string} changeNumber - e.g. "C-VTB-00123456".
   * @param {number} startTabIndex - Tab index to resume from (0 for fresh).
   */
  function __sfera_crawler_bg_processNumber(tabId, changeNumber, startTabIndex) {
    return new Promise(function (resolve) {
      var numberData = {};
      var tabIndex = startTabIndex || 0;

      function __sfera_crawler_bg_processNextTab() {
        if (__sfera_crawler_bg_stopRequested) {
          resolve("stopped");
          return;
        }

        if (tabIndex >= __sfera_crawler_bg_TABS.length) {
          // All tabs done — save data
          __sfera_crawler_bg_collectedData[changeNumber] = numberData;
          __sfera_crawler_bg_addLog(
            "Номер завершён: " + changeNumber +
              " (табов: " + Object.keys(numberData).length + ")"
          );
          __sfera_crawler_bg_saveProgress();
          __sfera_crawler_bg_sendStatus();
          resolve("ok");
          return;
        }

        var tabName = __sfera_crawler_bg_getTabName(tabIndex);

        // Try up to MAX_RETRIES
        var retries = 0;
        function __sfera_crawler_bg_tryTab() {
          __sfera_crawler_bg_processTab(tabId, changeNumber, tabIndex)
            .then(function (result) {
              numberData[result.tabName] = result;
              tabIndex++;
              __sfera_crawler_bg_processNextTab();
            })
            .catch(function (err) {
              retries++;
              if (retries < __sfera_crawler_bg_MAX_RETRIES) {
                __sfera_crawler_bg_addLog(
                  "Повтор " + retries + "/" + __sfera_crawler_bg_MAX_RETRIES +
                    " для " + tabName
                );
                // Wait before retry
                setTimeout(__sfera_crawler_bg_tryTab, 2000);
              } else {
                // Give up on this tab
                __sfera_crawler_bg_errors.push({
                  number: changeNumber,
                  tab: tabName,
                  error: err.message,
                  timestamp: new Date().toISOString(),
                });
                numberData[tabName] = {
                  error: err.message,
                  partial: true,
                };
                tabIndex++;
                __sfera_crawler_bg_processNextTab();
              }
            });
        }

        __sfera_crawler_bg_tryTab();
      }

      __sfera_crawler_bg_processNextTab();
    });
  }

  // ─────────────────────────────────────────────
  // Main Crawl Loop
  // ─────────────────────────────────────────────

  /**
   * Start the crawl: build queue, create tab pool, launch workers.
   */
  function __sfera_crawler_bg_startCrawl() {
    if (__sfera_crawler_bg_isCrawling) {
      __sfera_crawler_bg_addLog("Обход уже запущен");
      return;
    }

    var state = __sfera_crawler_bg_state;
    if (!state || !state.settings) {
      __sfera_crawler_bg_addLog("Ошибка: состояние не инициализировано");
      return;
    }

    __sfera_crawler_bg_isCrawling = true;
    __sfera_crawler_bg_stopRequested = false;
    __sfera_crawler_bg_changeQueue = [];
    __sfera_crawler_bg_activeWorkers = 0;

    // Build initial queue from currentNumber to endNumber
    var current = state.currentNumber;
    var endNum = state.settings.endNumber;
    while (true) {
      __sfera_crawler_bg_changeQueue.push(current);
      if (endNum) {
        var numPart = parseInt(current.replace("C-VTB-", ""), 10);
        if (numPart >= endNum) break;
      }
      var next = __sfera_crawler_bg_nextNumber(current);
      if (!next) break;
      // For open-ended: only enqueue first number (workers will add more)
      if (!endNum) break;
      current = next;
    }

    var concurrency = state.settings.concurrency || __sfera_crawler_bg_DEFAULT_CONCURRENCY;
    if (concurrency < 1) concurrency = 1;
    if (concurrency > __sfera_crawler_bg_MAX_CONCURRENCY) concurrency = __sfera_crawler_bg_MAX_CONCURRENCY;

    __sfera_crawler_bg_addLog(
      "Создание пула вкладок (" + concurrency + " потоков)..."
    );

    __sfera_crawler_bg_ensureTabs(concurrency, function (tabIds) {
      if (!tabIds || tabIds.length === 0) {
        __sfera_crawler_bg_addLog("Ошибка: не удалось создать вкладки");
        __sfera_crawler_bg_isCrawling = false;
        __sfera_crawler_bg_sendStatus();
        return;
      }

      __sfera_crawler_bg_setupNavListener();
      // Initialize tab busy tracking (parallel to crawlerTabIds)
      __sfera_crawler_bg_tabBusy = [];
      for (var ti = 0; ti < tabIds.length; ti++) {
        __sfera_crawler_bg_tabBusy.push(false);
      }
      __sfera_crawler_bg_addLog(
        "Обход начат. Старт: " + state.currentNumber +
          ", задержка: " + state.settings.delay + "ms" +
          ", потоки: " + tabIds.length
      );
      __sfera_crawler_bg_sendStatus();

      // Launch the scheduler
      __sfera_crawler_bg_crawlLoop();
    });
  }

  /**
   * Scheduler: while workers are free and queue has items, dispatch.
   * Workers feed new numbers into the queue when they finish.
   */
  function __sfera_crawler_bg_crawlLoop() {
    if (__sfera_crawler_bg_stopRequested) {
      __sfera_crawler_bg_finishCrawl("stopped");
      return;
    }

    var state = __sfera_crawler_bg_state;
    if (!state) {
      __sfera_crawler_bg_finishCrawl("error");
      return;
    }

    // Check stop conditions
    if (__sfera_crawler_bg_shouldStopOnQueue()) {
      __sfera_crawler_bg_finishCrawl("completed");
      return;
    }

    var poolSize = __sfera_crawler_bg_crawlerTabIds.length;

    // Dispatch workers while we have free tabs and queued work
    while (
      __sfera_crawler_bg_activeWorkers < poolSize &&
      __sfera_crawler_bg_changeQueue.length > 0
    ) {
      // Find first non-busy tab index
      var freeTabIndex = -1;
      for (var i = 0; i < poolSize; i++) {
        if (!__sfera_crawler_bg_tabBusy[i]) {
          freeTabIndex = i;
          break;
        }
      }
      if (freeTabIndex === -1) break; // no free slots (safety)

      var changeNumber = __sfera_crawler_bg_changeQueue.shift();
      var tabId = __sfera_crawler_bg_crawlerTabIds[freeTabIndex];
      var busyIdx = freeTabIndex; // captured in IIFE below

      __sfera_crawler_bg_tabBusy[busyIdx] = true;
      __sfera_crawler_bg_activeWorkers++;
      __sfera_crawler_bg_state.currentNumber = changeNumber;
      __sfera_crawler_bg_state.currentTabIndex = 0;

      __sfera_crawler_bg_addLog(
        "Запуск потока: " + changeNumber +
        " (активно: " + __sfera_crawler_bg_activeWorkers + "/" + poolSize + ")"
      );
      __sfera_crawler_bg_sendStatus();

      // IIFE captures changeNumber, busyIdx so the .then closure sees the right values
      (function (capturedNumber, capturedBusyIdx) {
        __sfera_crawler_bg_processNumber(tabId, capturedNumber, 0)
          .then(function (result) {
            __sfera_crawler_bg_activeWorkers--;
            __sfera_crawler_bg_tabBusy[capturedBusyIdx] = false;

            if (__sfera_crawler_bg_stopRequested) {
              __sfera_crawler_bg_finishCrawl("stopped");
              return;
            }

            // Update consecutive errors
            if (result === "error") {
              state.consecutiveErrors++;
            } else {
              state.consecutiveErrors = 0;
            }

            // Feed next number into the queue
            if (!__sfera_crawler_bg_stopRequested) {
              __sfera_crawler_bg_enqueueNextNumber(state);
              __sfera_crawler_bg_saveProgress();
              __sfera_crawler_bg_sendStatus();
            }

            if (__sfera_crawler_bg_shouldStopOnQueue()) {
              __sfera_crawler_bg_finishCrawl("completed");
              return;
            }

            // Wait delay before scheduling next worker
            setTimeout(function () {
              __sfera_crawler_bg_crawlLoop();
            }, state.settings.delay || 3000);
          });
      })(changeNumber, busyIdx);
    }

    // If no active workers and queue empty, we're done
    if (__sfera_crawler_bg_activeWorkers === 0 && __sfera_crawler_bg_changeQueue.length === 0) {
      __sfera_crawler_bg_finishCrawl("completed");
    }
  }

  /**
   * Enqueue the next change number after a worker finishes.
   */
  function __sfera_crawler_bg_enqueueNextNumber(state) {
    if (!state || !state.currentNumber) return;
    var endNum = state.settings ? state.settings.endNumber : null;
    var next = __sfera_crawler_bg_nextNumber(state.currentNumber);
    if (!next) return;

    var nextNumPart = parseInt(next.replace("C-VTB-", ""), 10);
    if (endNum && nextNumPart > endNum) return;

    __sfera_crawler_bg_changeQueue.push(next);
    state.currentNumber = next;
  }

  function __sfera_crawler_bg_finishCrawl(reason) {
    __sfera_crawler_bg_isCrawling = false;
    __sfera_crawler_bg_activeWorkers = 0;
    __sfera_crawler_bg_changeQueue = [];
    __sfera_crawler_bg_tabBusy = [];
    __sfera_crawler_bg_removeNavListener();

    if (reason === "completed") {
      __sfera_crawler_bg_addLog("Обход завершён");
      if (__sfera_crawler_bg_state) {
        __sfera_crawler_bg_state.status = "completed";
      }
    } else if (reason === "stopped") {
      __sfera_crawler_bg_addLog("Обход остановлен пользователем");
      if (__sfera_crawler_bg_state) {
        __sfera_crawler_bg_state.status = "stopped";
      }
    } else {
      __sfera_crawler_bg_addLog("Обход прерван: " + reason);
      if (__sfera_crawler_bg_state) {
        __sfera_crawler_bg_state.status = "stopped";
      }
    }

    // Save final data and close all tabs
    __sfera_crawler_bg_saveProgress();
    __sfera_crawler_bg_closeAllTabs();

    // Unregister main-world interceptor — crawling is done
    __sfera_crawler_bg_unregisterInterceptor();

    __sfera_crawler_bg_sendStatus();
  }

  // ─────────────────────────────────────────────
  // JSON Export
  // ─────────────────────────────────────────────

  /**
   * Format collected data for JSON export.
   * Returns a clean object with metadata + collected data per change number.
   */
  function __sfera_crawler_bg_formatExportData() {
    var exportData = {
      exportedAt: new Date().toISOString(),
      totalNumbers: Object.keys(__sfera_crawler_bg_collectedData).length,
      mode: __sfera_crawler_bg_state && __sfera_crawler_bg_state.settings
        ? __sfera_crawler_bg_state.settings.mode
        : "single",
      changes: {},
    };

    var keys = Object.keys(__sfera_crawler_bg_collectedData);
    for (var i = 0; i < keys.length; i++) {
      var changeNumber = keys[i];
      var tabs = __sfera_crawler_bg_collectedData[changeNumber];
      var cleanTabs = {};

      var tabNames = Object.keys(tabs);
      for (var j = 0; j < tabNames.length; j++) {
        var tabName = tabNames[j];
        var tabData = tabs[tabName];
        cleanTabs[tabName] = {
          data: tabData.data || {},
          strategies: tabData.strategies || [],
          partial: tabData.partial || false,
          error: tabData.error || null,
        };
      }

      exportData.changes[changeNumber] = cleanTabs;
    }

    return exportData;
  }

  /**
   * Download one JSON file using chrome.downloads API.
   */
  function __sfera_crawler_bg_downloadJson(filename, jsonData) {
    return new Promise(function (resolve, reject) {
      try {
        var jsonStr = JSON.stringify(jsonData, null, 2);
        var blob = new Blob([jsonStr], { type: "application/json" });
        var url = URL.createObjectURL(blob);

        chrome.downloads.download(
          {
            url: url,
            filename: filename,
            saveAs: false,
          },
          function (downloadId) {
            URL.revokeObjectURL(url);
            if (chrome.runtime.lastError) {
              reject(
                new Error(
                  "Ошибка скачивания: " +
                    chrome.runtime.lastError.message
                )
              );
            } else {
              __sfera_crawler_bg_addLog(
                "Скачан файл: " + filename + " (ID: " + downloadId + ")"
              );
              resolve(downloadId);
            }
          }
        );
      } catch (e) {
        reject(new Error("Ошибка создания файла: " + e.message));
      }
    });
  }

  /**
   * Export data in single-file mode: one changes.json with all numbers.
   */
  function __sfera_crawler_bg_exportSingleFile() {
    var data = __sfera_crawler_bg_formatExportData();
    data.mode = "single";
    return __sfera_crawler_bg_downloadJson("sfera-changes.json", data);
  }

  /**
   * Export data in per-number mode: one JSON file per change number.
   */
  function __sfera_crawler_bg_exportPerNumber() {
    var keys = Object.keys(__sfera_crawler_bg_collectedData);
    var promises = [];

    for (var i = 0; i < keys.length; i++) {
      var changeNumber = keys[i];
      var singleData = {
        exportedAt: new Date().toISOString(),
        changeNumber: changeNumber,
        tabs: __sfera_crawler_bg_collectedData[changeNumber],
      };
      promises.push(
        __sfera_crawler_bg_downloadJson(
          changeNumber + ".json",
          singleData
        )
      );
    }

    return Promise.all(promises);
  }

  /**
   * Export data in update mode: download individual files (merge not possible
   * in extension — user can merge existing files manually).
   */
  function __sfera_crawler_bg_exportUpdate() {
    // In update mode, we download individual per-number files.
    // User replaces existing files with new ones.
    return __sfera_crawler_bg_exportPerNumber();
  }

  /**
   * Trigger export based on the selected mode.
   */
  function __sfera_crawler_bg_triggerExport() {
    var mode = "single";
    if (
      __sfera_crawler_bg_state &&
      __sfera_crawler_bg_state.settings
    ) {
      mode = __sfera_crawler_bg_state.settings.mode;
    }

    if (Object.keys(__sfera_crawler_bg_collectedData).length === 0) {
      __sfera_crawler_bg_addLog(
        "Нет данных для экспорта"
      );
      return;
    }

    __sfera_crawler_bg_addLog(
      "Экспорт данных (режим: " + mode + ")..."
    );

    var exportPromise = null;
    switch (mode) {
      case "per-number":
        exportPromise = __sfera_crawler_bg_exportPerNumber();
        break;
      case "update":
        exportPromise = __sfera_crawler_bg_exportUpdate();
        break;
      case "single":
      default:
        exportPromise = __sfera_crawler_bg_exportSingleFile();
        break;
    }

    exportPromise
      .then(function () {
        __sfera_crawler_bg_addLog("Экспорт завершён");
        // Don't clear progress — keep data in storage in case SW restarts
      })
      .catch(function (err) {
        __sfera_crawler_bg_addLog("Ошибка экспорта: " + err.message);
      });
  }

  // ─────────────────────────────────────────────
  // CSV Export
  // ─────────────────────────────────────────────

  /**
   * Extract human-readable value from a custom field value.
   * Custom field values can be JSON objects/arrays or plain strings.
   */
  function __sfera_crawler_bg_extractCsvValue(raw) {
    if (raw === null || raw === undefined) return "";
    if (typeof raw === "string") {
      // Try parse JSON
      if (raw.startsWith("{") || raw.startsWith("[")) {
        try {
          var parsed = JSON.parse(raw);
          return __sfera_crawler_bg_extractCsvValue(parsed);
        } catch (e) {
          return raw;
        }
      }
      return raw;
    }
    if (typeof raw === "boolean") return raw ? "Да" : "Нет";
    if (typeof raw === "number") return String(raw);

    // Object or array
    if (Array.isArray(raw)) {
      if (raw.length === 0) return "";
      if (raw.length === 1) return __sfera_crawler_bg_extractCsvValue(raw[0]);
      return raw
        .map(function (item) { return __sfera_crawler_bg_extractCsvValue(item); })
        .filter(function (v) { return v !== ""; })
        .join("; ");
    }

    if (typeof raw === "object") {
      // Try common patterns
      if (raw.value !== undefined) return __sfera_crawler_bg_extractCsvValue(raw.value);
      if (raw.name !== undefined) return raw.name;
      if (raw.title !== undefined) return raw.title;
      if (raw.firstName !== undefined) {
        return (raw.firstName || "") + " " + (raw.lastName || "");
      }
      if (raw.code !== undefined) return raw.code;
      // Fallback: join all string values
      var parts = [];
      for (var k in raw) {
        if (Object.prototype.hasOwnProperty.call(raw, k)) {
          var v = raw[k];
          if (typeof v === "string" && v.length > 0 && v.length < 200) {
            parts.push(v);
          }
        }
      }
      return parts.length > 0 ? parts.join(" / ") : JSON.stringify(raw);
    }

    return String(raw);
  }

  /**
   * Escape a value for CSV (RFC 4180).
   */
  function __sfera_crawler_bg_csvEscape(str) {
    if (str === null || str === undefined) return "";
    var s = String(str);
    if (s.indexOf('"') !== -1 || s.indexOf(",") !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * Flatten one change's data into a flat row object for CSV.
   * Extracts data from the "mainInfo" tab (the change entity).
   */
  function __sfera_crawler_bg_flattenChange(changeNumber, tabs) {
    var row = { changeNumber: changeNumber };

    var mainInfo = tabs["mainInfo"];
    if (!mainInfo || !mainInfo.data) return row;

    // mainInfo.data is keyed by URL — find the entity object
    var entity = null;
    var dataUrls = Object.keys(mainInfo.data);
    for (var i = 0; i < dataUrls.length; i++) {
      var candidate = mainInfo.data[dataUrls[i]];
      if (candidate && candidate.number === changeNumber) {
        entity = candidate;
        break;
      }
    }
    if (!entity) {
      // Fallback: take the first non-empty object
      for (var j = 0; j < dataUrls.length; j++) {
        var c = mainInfo.data[dataUrls[j]];
        if (c && typeof c === "object" && Object.keys(c).length > 0) {
          entity = c;
          break;
        }
      }
    }
    if (!entity) return row;

    // Top-level fields
    row.number = entity.number || "";
    row.type = entity.type || "";
    row.status = entity.status || "";
    row.priority = entity.priority || "";
    row.name = entity.name || "";
    row.description = entity.description || "";
    row.createDate = entity.createDate || "";
    row.updateDate = entity.updateDate || "";
    row.state = entity.state || "";

    // Created by / Updated by
    if (entity.createdBy) {
      row.creator = (entity.createdBy.firstName || "") + " " + (entity.createdBy.lastName || "");
    }
    if (entity.updatedBy) {
      row.updater = (entity.updatedBy.firstName || "") + " " + (entity.updatedBy.lastName || "");
    }

    // Configuration unit (first entry)
    if (entity.configurationUnit && entity.configurationUnit.length > 0) {
      var cu = entity.configurationUnit[0];
      row.configUnit = cu.name || "";
      row.configUnitType = cu.type || "";
      row.configUnitStatus = cu.status || "";
      row.configUnitEnvironment = cu.environment || "";
      row.plannedDegradation = cu.plannedDegradation || "";
    }

    // Custom fields — each code becomes a column
    if (entity.customFieldsValues && Array.isArray(entity.customFieldsValues)) {
      for (var k = 0; k < entity.customFieldsValues.length; k++) {
        var cf = entity.customFieldsValues[k];
        if (cf.code) {
          row["cf_" + cf.code] = __sfera_crawler_bg_extractCsvValue(cf.value);
        }
      }
    }

    return row;
  }

  /**
   * Discover all CSV column names from flattened rows.
   * "changeNumber" is always first, then standard fields, then dynamic custom field columns.
   */
  function __sfera_crawler_bg_getCsvColumns(rows) {
    var standardCols = [
      "changeNumber",
      "number",
      "type",
      "status",
      "priority",
      "name",
      "description",
      "creator",
      "updater",
      "createDate",
      "updateDate",
      "state",
      "configUnit",
      "configUnitType",
      "configUnitStatus",
      "configUnitEnvironment",
      "plannedDegradation",
    ];

    // Collect all custom field column names
    var customCols = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var keys = Object.keys(rows[i]);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        if (key.indexOf("cf_") === 0 && !seen[key]) {
          seen[key] = true;
          customCols.push(key);
        }
      }
    }
    customCols.sort();

    return standardCols.concat(customCols);
  }

  /**
   * Generate CSV string from all collected data.
   */
  function __sfera_crawler_bg_buildCsv() {
    var keys = Object.keys(__sfera_crawler_bg_collectedData);
    if (keys.length === 0) return null;

    var rows = [];
    for (var i = 0; i < keys.length; i++) {
      var row = __sfera_crawler_bg_flattenChange(
        keys[i],
        __sfera_crawler_bg_collectedData[keys[i]]
      );
      rows.push(row);
    }

    var columns = __sfera_crawler_bg_getCsvColumns(rows);

    // Build CSV lines
    var lines = [];

    // Header
    var headerParts = [];
    for (var c = 0; c < columns.length; c++) {
      headerParts.push(__sfera_crawler_bg_csvEscape(columns[c]));
    }
    lines.push(headerParts.join(","));

    // Data rows
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var rowParts = [];
      for (var c2 = 0; c2 < columns.length; c2++) {
        var colName = columns[c2];
        rowParts.push(__sfera_crawler_bg_csvEscape(row[colName] !== undefined ? row[colName] : ""));
      }
      lines.push(rowParts.join(","));
    }

    // BOM for Excel UTF-8 compatibility
    return "\uFEFF" + lines.join("\r\n");
  }

  /**
   * Download CSV file.
   */
  function __sfera_crawler_bg_downloadCsv() {
    return new Promise(function (resolve, reject) {
      try {
        var csvStr = __sfera_crawler_bg_buildCsv();
        if (!csvStr) {
          reject(new Error("Нет данных для CSV экспорта"));
          return;
        }

        var blob = new Blob([csvStr], { type: "text/csv;charset=utf-8" });
        var url = URL.createObjectURL(blob);

        chrome.downloads.download(
          {
            url: url,
            filename: "sfera-changes.csv",
            saveAs: false,
          },
          function (downloadId) {
            URL.revokeObjectURL(url);
            if (chrome.runtime.lastError) {
              reject(
                new Error("Ошибка скачивания CSV: " + chrome.runtime.lastError.message)
              );
            } else {
              __sfera_crawler_bg_addLog("Скачан CSV файл (ID: " + downloadId + ")");
              resolve(downloadId);
            }
          }
        );
      } catch (e) {
        reject(new Error("Ошибка создания CSV файла: " + e.message));
      }
    });
  }

  // ─────────────────────────────────────────────
  // Message Handlers
  // ─────────────────────────────────────────────

  function __sfera_crawler_bg_handleStart(payload, sendResponse) {
    // Parse start number
    var startStr = __sfera_crawler_bg_parseChangeNumber(
      payload.startNumber
    );
    if (!startStr) {
      __sfera_crawler_bg_addLog(
        "Ошибка: неверный стартовый номер"
      );
      if (sendResponse)
        sendResponse({ success: false, error: "Неверный номер" });
      return;
    }

    var endNumber = payload.endNumber
      ? parseInt(payload.endNumber, 10)
      : null;
    if (endNumber) {
      var startNum = parseInt(
        startStr.replace("C-VTB-", ""),
        10
      );
      if (endNumber < startNum) {
        __sfera_crawler_bg_addLog(
          "Ошибка: конечный номер меньше стартового"
        );
        if (sendResponse)
          sendResponse({
            success: false,
            error: "Конечный номер меньше стартового",
          });
        return;
      }
    }

    // Reset state
    __sfera_crawler_bg_collectedData = {};
    __sfera_crawler_bg_errors = [];
    __sfera_crawler_bg_log = [];
    __sfera_crawler_bg_stopRequested = false;

    __sfera_crawler_bg_state = __sfera_crawler_bg_buildState();
    __sfera_crawler_bg_state.currentNumber = startStr;
    __sfera_crawler_bg_state.currentTabIndex = 0;
    __sfera_crawler_bg_state.settings = {
      startNumber: payload.startNumber,
      endNumber: endNumber,
      delay: payload.delay || 3000,
      mode: payload.mode || "single",
      maxErrors: payload.maxErrors || 10,
      autoDownload: payload.autoDownload || false,
      concurrency: payload.concurrency || __sfera_crawler_bg_DEFAULT_CONCURRENCY,
    };
    __sfera_crawler_bg_state.consecutiveErrors = 0;

    // Ensure main-world API interceptor is active for this crawling session
    __sfera_crawler_bg_registerInterceptor();

    __sfera_crawler_bg_addLog(
      "Получена команда START: " + startStr +
        (endNumber ? " → " + endNumber : " (до ошибок)")
    );

    if (sendResponse) sendResponse({ success: true });

    // Start crawl in next tick
    setTimeout(function () {
      __sfera_crawler_bg_startCrawl();
    }, 100);
  }

  function __sfera_crawler_bg_handleStop(sendResponse) {
    __sfera_crawler_bg_addLog("Получена команда STOP");
    __sfera_crawler_bg_stopRequested = true;
    if (sendResponse) sendResponse({ success: true });
    __sfera_crawler_bg_sendStatus();
  }

  function __sfera_crawler_bg_handleResume(sendResponse) {
    __sfera_crawler_bg_loadProgress(function (progress) {
      if (!progress || progress.status === "completed") {
        __sfera_crawler_bg_addLog(
          "Нет сохранённого прогресса для возобновления"
        );
        if (sendResponse)
          sendResponse({
            success: false,
            error: "Нет сохранённого прогресса",
          });
        return;
      }

      // Restore state
      __sfera_crawler_bg_state = progress;
      __sfera_crawler_bg_collectedData =
        progress.collectedData || {};
      __sfera_crawler_bg_errors = progress.errors || [];
      __sfera_crawler_bg_log = progress.log || [];
      __sfera_crawler_bg_state.status = "running";
      __sfera_crawler_bg_stopRequested = false;

      // Ensure main-world API interceptor is active when resuming
      __sfera_crawler_bg_registerInterceptor();

      __sfera_crawler_bg_addLog(
        "Возобновление обхода с " + progress.currentNumber +
          " (таб: " + __sfera_crawler_bg_getTabName(progress.currentTabIndex) + ")"
      );

      if (sendResponse) sendResponse({ success: true });

      // Start crawl in next tick
      setTimeout(function () {
        __sfera_crawler_bg_startCrawl();
      }, 100);
    });
  }

  function __sfera_crawler_bg_handleDownload(sendResponse) {
    __sfera_crawler_bg_addLog("Получена команда DOWNLOAD");
    __sfera_crawler_bg_triggerExport();
    if (sendResponse) sendResponse({ success: true });
  }

  function __sfera_crawler_bg_handleExportCsv(sendResponse) {
    __sfera_crawler_bg_addLog("Получена команда EXPORT_CSV");
    if (Object.keys(__sfera_crawler_bg_collectedData).length === 0) {
      __sfera_crawler_bg_addLog("Нет данных для CSV экспорта");
      if (sendResponse) sendResponse({ success: false, error: "Нет данных" });
      return;
    }
    __sfera_crawler_bg_downloadCsv()
      .then(function () {
        __sfera_crawler_bg_addLog("CSV экспорт завершён");
        if (sendResponse) sendResponse({ success: true });
      })
      .catch(function (err) {
        __sfera_crawler_bg_addLog("Ошибка CSV экспорта: " + err.message);
        if (sendResponse) sendResponse({ success: false, error: err.message });
      });
  }

  function __sfera_crawler_bg_handleGetExportData(sendResponse) {
    // If in-memory data is empty, try loading from storage (SW may have restarted)
    if (Object.keys(__sfera_crawler_bg_collectedData).length === 0) {
      chrome.storage.local.get("crawlerProgress", function (result) {
        if (chrome.runtime.lastError || !result.crawlerProgress) {
          if (sendResponse) sendResponse({ error: "Нет данных для экспорта" });
          return;
        }
        // Restore from storage
        var progress = result.crawlerProgress;
        __sfera_crawler_bg_collectedData = progress.collectedData || {};
        __sfera_crawler_bg_state = progress;
        if (Object.keys(__sfera_crawler_bg_collectedData).length === 0) {
          if (sendResponse) sendResponse({ error: "Нет данных для экспорта" });
          return;
        }
        sendExportData(sendResponse);
      });
      return;
    }
    sendExportData(sendResponse);
  }

  function sendExportData(sendResponse) {
    var data = __sfera_crawler_bg_formatExportData();
    var mode = (__sfera_crawler_bg_state && __sfera_crawler_bg_state.settings)
      ? __sfera_crawler_bg_state.settings.mode
      : "single";
    var filename = mode === "single"
      ? "sfera-changes.json"
      : "sfera-changes-export.json";
    __sfera_crawler_bg_addLog("Отправка данных экспорта (" + Object.keys(__sfera_crawler_bg_collectedData).length + " номеров)");
    if (sendResponse) sendResponse({ data: data, filename: filename, mode: mode });
  }

  function __sfera_crawler_bg_handleGetStatus(sendResponse) {
    var effectiveStatus = "stopped";
    if (__sfera_crawler_bg_isCrawling) {
      effectiveStatus = "running";
    } else if (__sfera_crawler_bg_state && __sfera_crawler_bg_state.status) {
      effectiveStatus = __sfera_crawler_bg_state.status;
    }
    var payload = {
      status: effectiveStatus,
      currentNumber: __sfera_crawler_bg_state
        ? __sfera_crawler_bg_state.currentNumber
        : null,
      currentTab: __sfera_crawler_bg_state
        ? __sfera_crawler_bg_getTabName(
            __sfera_crawler_bg_state.currentTabIndex
          )
        : null,
      processedCount: Object.keys(__sfera_crawler_bg_collectedData)
        .length,
      totalCount: __sfera_crawler_bg_state && __sfera_crawler_bg_state.settings
        ? (__sfera_crawler_bg_state.settings.endNumber
            ? __sfera_crawler_bg_state.settings.endNumber - __sfera_crawler_bg_state.settings.startNumber + 1
            : "∞")
        : 0,
      errorsCount: __sfera_crawler_bg_errors.length,
      mode: __sfera_crawler_bg_state
        ? __sfera_crawler_bg_state.settings
          ? __sfera_crawler_bg_state.settings.mode
          : "single"
        : "single",
      hasSavedProgress: false,
    };

    // Also check if there's saved progress
    try {
      chrome.storage.local.get(
        "crawlerProgress",
        function (result) {
          if (
            !chrome.runtime.lastError &&
            result.crawlerProgress &&
            result.crawlerProgress.status !== "completed"
          ) {
            payload.hasSavedProgress = true;
          }
          if (sendResponse) sendResponse(payload);
        }
      );
    } catch (e) {
      if (sendResponse) sendResponse(payload);
    }
  }

  // ─────────────────────────────────────────────
  // Chrome Runtime Message Listener
  // ─────────────────────────────────────────────

  try {
    chrome.runtime.onMessage.addListener(function (
      message,
      sender,
      sendResponse
    ) {
      try {
        switch (message.type) {
          case "START":
            __sfera_crawler_bg_handleStart(
              message.payload,
              sendResponse
            );
            return true; // Keep channel open for async response

          case "STOP":
            __sfera_crawler_bg_handleStop(sendResponse);
            return true;

          case "RESUME":
            __sfera_crawler_bg_handleResume(sendResponse);
            return true;

          case "DOWNLOAD":
            __sfera_crawler_bg_handleDownload(sendResponse);
            return true;

          case "EXPORT_CSV":
            __sfera_crawler_bg_handleExportCsv(sendResponse);
            return true;

          case "GET_EXPORT_DATA":
            __sfera_crawler_bg_handleGetExportData(sendResponse);
            return true;

          case "GET_STATUS":
            __sfera_crawler_bg_handleGetStatus(sendResponse);
            return true;

          case "PAGE_DATA": {
            // From content script — route via pageDataMap using changeNumber:tabName
            var msg = message;
            var mapKey = (msg.changeNumber || "unknown") + ":" + (msg.tabName || "unknown");
            if (__sfera_crawler_bg_pageDataMap[mapKey] && __sfera_crawler_bg_pageDataMap[mapKey].resolve) {
              var pageResolve = __sfera_crawler_bg_pageDataMap[mapKey].resolve;
              delete __sfera_crawler_bg_pageDataMap[mapKey];
              pageResolve(msg);
            } else {
              // Buffer for later — someone will wait for it
              __sfera_crawler_bg_pageDataMap[mapKey] = {
                data: msg,
                resolve: null,
                reject: null,
                timeoutId: null,
              };
            }
            break;
          }

          default:
            console.log(
              "[SferaCrawler] Unknown message type:",
              message.type
            );
            break;
        }
      } catch (e) {
        console.error(
          "[SferaCrawler] Message handler error:",
          e
        );
      }

      // Return false for sync handlers (already handled above)
      return false;
    });
  } catch (e) {
    console.error(
      "[SferaCrawler] Failed to register message listener:",
      e
    );
  }

  // ─────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────

  __sfera_crawler_bg_addLog("Service Worker загружен");

  // Auto-send status when popup connects
  try {
    chrome.runtime.onConnect.addListener(function () {
      __sfera_crawler_bg_sendStatus();
    });
  } catch (e) {
    // ignore
  }

  // If there was a crash, clean stale tab references
  __sfera_crawler_bg_loadProgress(function (progress) {
    if (
      progress &&
      progress.status === "running"
    ) {
      // Previous crawl was interrupted — mark as stopped
      progress.status = "stopped";
      __sfera_crawler_bg_state = progress;
      __sfera_crawler_bg_collectedData =
        progress.collectedData || {};
      __sfera_crawler_bg_errors = progress.errors || [];
      __sfera_crawler_bg_log = progress.log || [];
      __sfera_crawler_bg_saveProgress();
      __sfera_crawler_bg_addLog(
        "Предыдущий обход был прерван. Прогресс сохранён."
      );
    }
  });
})();
