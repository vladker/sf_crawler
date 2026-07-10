/* eslint-disable no-undef */
/**
 * Sfera Crawler — Main World API Interceptor
 * Runs in MAIN world (via registerContentScripts with world: "MAIN").
 * Patches window.fetch and XMLHttpRequest BEFORE page scripts load
 * (run_at: document_start), so all SPA API calls to sfera.vtb.ru
 * are captured and stored for the content script (isolated world)
 * to retrieve via postMessage.
 *
 * WHY this approach works where the old S1 (content-script-isolated-world)
 * didn't: page scripts use the MAIN world's fetch/XHR. An isolated-world
 * content script patching window.fetch patches ONLY the copy in its own
 * isolated shadow — page scripts never see it.
 */
(function () {
  "use strict";

  // Guard — page reload re-executes this script, don't double-patch
  if (window.__sferaCrawlerInterceptorReady) return;
  window.__sferaCrawlerInterceptorReady = true;

  // ── Shared cache (main world, page scripts can't tamper with it) ──
  window.__sferaCrawlerApiData = {};
  window.__sferaCrawlerApiCount = 0;

  // ─────────────────────────────────────────────
  // intercept window.fetch
  // ─────────────────────────────────────────────
  var originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function () {
      var args = Array.prototype.slice.call(arguments);
      var url =
        typeof args[0] === "string"
          ? args[0]
          : args[0] && args[0].url
          ? args[0].url
          : "";

      // Intercept ALL requests — microfrontend may use different API gateways
      return originalFetch.apply(this, args).then(function (response) {
        // Clone so the original stream is not consumed
        var clone = response.clone();

        // Only try to parse JSON — skip binary (images, fonts, etc.)
        var contentType = clone.headers.get("content-type") || "";
        if (contentType.indexOf("json") === -1) {
          return response; // not JSON, skip
        }

        clone
          .json()
          .then(function (json) {
            try {
              window.__sferaCrawlerApiData[url] = json;
              window.__sferaCrawlerApiCount++;
            } catch (e) {
              // ignore
            }
          })
          .catch(function () {
            // JSON parse failed — skip
          });

        return response;
      });
    };
  }

  // ─────────────────────────────────────────────
  // intercept XMLHttpRequest
  // ─────────────────────────────────────────────
  var XHRProto = XMLHttpRequest.prototype;
  var origOpen = XHRProto.open;
  var origSend = XHRProto.send;

  XHRProto.open = function () {
    this.__sferaCrawlerUrl = arguments[1] || "";
    return origOpen.apply(this, Array.prototype.slice.call(arguments));
  };

  XHRProto.send = function () {
    var url = this.__sferaCrawlerUrl || "";
    var xhr = this;
    xhr.addEventListener("load", function () {
      try {
        var json = JSON.parse(xhr.responseText);
        window.__sferaCrawlerApiData[url] = json;
        window.__sferaCrawlerApiCount++;
      } catch (e) {
        // response is not JSON — skip
      }
    });
    return origSend.apply(this, Array.prototype.slice.call(arguments));
  };

  // ─────────────────────────────────────────────
  // postMessage bridge ← content script (isolated world)
  // ─────────────────────────────────────────────
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;

    if (event.data && event.data.type === "__SFERA_GET_API__") {
      window.postMessage(
        {
          type: "__SFERA_API_DATA__",
          data: window.__sferaCrawlerApiData || {},
        },
        "*"
      );
    }

    // Allow content script to reset cache between navigations
    if (event.data && event.data.type === "__SFERA_RESET_API__") {
      window.__sferaCrawlerApiData = {};
      window.__sferaCrawlerApiCount = 0;
    }
  });
})();
