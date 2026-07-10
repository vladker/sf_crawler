/* eslint-disable no-undef */
/**
 * Sfera.vtb.ru Content Script
 * Strategy Pattern architecture for data extraction.
 */

(function () {
  "use strict";

  // ─────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────
  var __sfera_crawler_apiCache = {};
  var __sfera_crawler_MUTATION_THRESHOLD = 1500; // 1.5s
  var __sfera_crawler_TIMEOUT_THRESHOLD = 15000; // 15s
  var __sfera_crawler_CHANGE_TASKS_PREFIX = "/change-tasks/";
  var __sfera_crawler_INFRASTRUCTURE_PATTERNS = [
    "/api/tenant/v1/localizations/",
    "/api/auth/",
    "/api/config/themes",
    "/api/tenant/v1/user/routes",
    "/api/config/",
    "user-routes",
  ];

  // Whitelist of entity fields to keep — everything else is stripped to reduce
  // data volume and system load. Based on user's "lite" export.
  var __sfera_crawler_ENTITY_FIELD_WHITELIST = [
    "id", "number", "areaCode",
    "typeId", "type", "statusId", "status",
    "priorityId", "priority",
    "name", "description",
    "createDate", "createdBy",
    "updateDate", "updatedBy",
    "state", "rank",
    "childEntities",
    "customFieldsValues",
    "permissions",
    "relatedEntities", "externalRelatedEntities",
    "attachments", "linkedRelatedEntities",
    "emNumber", "label", "customEntityTypes",
    "currentDateInfo", "currentUser",
    "component", "ctTemplate",
    "configurationUnit",
    "messages", "rolledBack", "drpAttachments",
  ];

  // Entity API URL pattern — only apply field whitelist to these
  var __sfera_crawler_ENTITY_API_PATTERN = "/api/v0.1/entities/";

  // ─────────────────────────────────────────────
  // Utility helpers
  // ─────────────────────────────────────────────

  /**
   * Get API cache from in-memory object.
   */
  function __sfera_crawler_getApiCache() {
    return __sfera_crawler_apiCache;
  }

  /**
   * Set API cache (in-memory).
   */
  function __sfera_crawler_setApiCache(cache) {
    __sfera_crawler_apiCache = cache;
  }

  /**
   * Check if an element is visible.
   */
  function __sfera_crawler_isVisible(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;
    if (parseInt(style.opacity, 10) === 0) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    return true;
  }

  /**
   * Extract text content from an element, trimming whitespace.
   */
  function __sfera_crawler_getText(el) {
    if (!el) return "";
    return (el.textContent || "").trim();
  }

  // ─────────────────────────────────────────────
  // URL Parsing
  // ─────────────────────────────────────────────

  /**
   * Parse changeNumber from current URL.
   * URL pattern: sfera.vtb.ru/ppcg-fw/change-tasks/(C-VTB-\d+)/...
   */
  function __sfera_crawler_parseUrl() {
    var changeNumber = null;

    try {
      var pathname = window.location.pathname;

      var changeTasksMatch = pathname.match(/\/change-tasks\/([^/]+)/i);
      if (changeTasksMatch) {
        var segment = changeTasksMatch[1];
        var cvtMatch = segment.match(/^C-VTB-(\d+)$/i);
        if (cvtMatch) {
          changeNumber = "C-VTB-" + cvtMatch[1];
        } else {
          changeNumber = segment;
        }
      }
    } catch (e) {
      // ignore
    }

    return { changeNumber: changeNumber, tabName: "entity" };
  }

  // ─────────────────────────────────────────────
  // S1: ApiInterceptor Strategy
  // ─────────────────────────────────────────────

  var __sfera_crawler_apiIntercepted = false;

  var __sfera_crawler_S1 = {
    name: "ApiInterceptor",
    source: "api",

    /**
     * Intercept window.fetch — captures response.json() for URLs containing
     * /change-tasks/. Uses clone() to avoid modifying original responses.
     */
    _interceptFetch: function () {
      if (__sfera_crawler_apiIntercepted) return;
      __sfera_crawler_apiIntercepted = true;

      var originalFetch = window.fetch;
      var self = this;

      if (!originalFetch) return;

      window.fetch = function () {
        var fetchArgs = Array.prototype.slice.call(arguments);
        var url = fetchArgs[0];
        var urlString = typeof url === "string" ? url : "";

        if (urlString.indexOf(__sfera_crawler_CHANGE_TASKS_PREFIX) === -1) {
          return originalFetch.apply(this, fetchArgs);
        }

        return originalFetch.apply(this, fetchArgs).then(function (response) {
          var cloned = response.clone();
          var cache = __sfera_crawler_getApiCache();

          cloned
            .json()
            .then(function (data) {
              try {
                cache[urlString] = data;
                __sfera_crawler_setApiCache(cache);
              } catch (e) {
                // ignore
              }
            })
            .catch(function () {
              // ignore JSON parse errors
            });

          return response;
        });
      };
    },

    /**
     * Intercept XMLHttpRequest — captures responseText for URLs containing
     * /change-tasks/ using addEventListener to avoid recursion.
     */
    _interceptXHR: function () {
      var originalXHR = window.XMLHttpRequest;
      if (!originalXHR) return;

      var originalOpen = originalXHR.prototype.open;
      var originalSend = originalXHR.prototype.send;

      originalXHR.prototype.open = function () {
        this.__sfera_crawler_url = arguments[1] || "";
        return originalOpen.apply(this, Array.prototype.slice.call(arguments));
      };

      originalXHR.prototype.send = function () {
        var xhrUrl = this.__sfera_crawler_url || "";
        if (xhrUrl.indexOf(__sfera_crawler_CHANGE_TASKS_PREFIX) === -1) {
          return originalSend.apply(this, Array.prototype.slice.call(arguments));
        }

        var selfXHR = this;
        selfXHR.addEventListener("load", function () {
          try {
            var cache = __sfera_crawler_getApiCache();
            cache[xhrUrl] = selfXHR.responseText;
            __sfera_crawler_setApiCache(cache);
          } catch (e) {
            // ignore
          }
        });

        return originalSend.apply(this, Array.prototype.slice.call(arguments));
      };
    },

    /**
     * Start API interception.
     */
    scrape: function () {
      this._interceptFetch();
      this._interceptXHR();
      return Promise.resolve({});
    },

    /**
     * Get collected API data.
     */
    getData: function () {
      return __sfera_crawler_getApiCache();
    },
  };

  // ─────────────────────────────────────────────
  // S2: FormScraper Strategy
  // ─────────────────────────────────────────────

  var __sfera_crawler_S2 = {
    name: "FormScraper",
    source: "form",

    /**
     * Extract field value from a select element.
     */
    _getSelectValue: function (select) {
      var options = select.options;
      var selectedIndex = select.selectedIndex;
      if (selectedIndex < 0 || !options[selectedIndex]) return "";
      return options[selectedIndex].text;
    },

    /**
     * Find the label for a given input element.
     */
    _findLabel: function (input) {
      // 1. Check for associated label via 'for' attribute
      if (input.id) {
        var labeledBy = input.getAttribute("aria-labelledby");
        if (labeledBy) {
          var labelEl = document.getElementById(labeledBy);
          if (labelEl) return __sfera_crawler_getText(labelEl);
        }
        var label = document.querySelector('label[for="' + input.id + '"]');
        if (label) return __sfera_crawler_getText(label);
      }

      // 2. Check closest label parent
      var parentLabel = input.closest("label");
      if (parentLabel) return __sfera_crawler_getText(parentLabel);

      // 3. Check previous sibling or ancestor
      var prev = input.previousElementSibling;
      if (prev && prev.tagName === "LABEL") return __sfera_crawler_getText(prev);

      // 4. Check data-testid
      var testId = input.getAttribute("data-testid");
      if (testId) return testId;

      // 5. Check placeholder
      return input.getAttribute("placeholder") || "";
    },

    /**
     * Extract data from form elements (input, select, textarea).
     */
    scrape: function () {
      var result = {};
      try {
        var forms = document.querySelectorAll(
          "form, [role='form'], fieldset, [class*='field-group'], [class*='form-group']"
        );

        for (var i = 0; i < forms.length; i++) {
          var form = forms[i];
          var inputs = form.querySelectorAll("input, select, textarea");

          for (var j = 0; j < inputs.length; j++) {
            var input = inputs[j];
            var type = (input.type || "").toLowerCase();

            if (type === "hidden" || type === "submit" || type === "button" || type === "reset") continue;
            if (!__sfera_crawler_isVisible(input)) continue;

            var label = this._findLabel(input);
            if (!label) continue;

            var value = "";
            if (input.tagName === "SELECT") {
              value = this._getSelectValue(input);
            } else if (type === "checkbox" || type === "radio") {
              value = input.checked ? "checked" : "unchecked";
            } else {
              value = input.value || "";
            }

            if (value === "") continue;

            result[label] = {
              value: value,
              source: "form",
            };
          }
        }
      } catch (e) {
        // ignore
      }

      return Promise.resolve(result);
    },
  };

  // ─────────────────────────────────────────────
  // S3: TableScraper Strategy
  // ─────────────────────────────────────────────

  var __sfera_crawler_S3 = {
    name: "TableScraper",
    source: "table",

    /**
     * Extract headers from thead or first row.
     */
    _extractHeaders: function (table) {
      var thead = table.querySelector("thead");
      if (thead) {
        var firstRow = thead.querySelector("tr");
        if (firstRow) {
          var cells = firstRow.querySelectorAll("th, td");
          var headers = [];
          for (var i = 0; i < cells.length; i++) {
            headers.push(__sfera_crawler_getText(cells[i]) || "Col " + (i + 1));
          }
          return headers;
        }
      }

      // Fallback: first row of tbody
      var tbody = table.querySelector("tbody");
      if (tbody) {
        var firstRow = tbody.querySelector("tr");
        if (firstRow) {
          var cells = firstRow.querySelectorAll("td, th");
          var headers = [];
          for (var i = 0; i < cells.length; i++) {
            headers.push(__sfera_crawler_getText(cells[i]) || "Col " + (i + 1));
          }
          return headers;
        }
      }

      return null;
    },

    /**
     * Extract rows from tbody.
     */
    _extractRows: function (table) {
      var tbody = table.querySelector("tbody");
      if (!tbody) {
        tbody = table; // fallback: entire table
      }

      var rows = tbody.querySelectorAll("tr");
      var headers = this._extractHeaders(table);
      var results = [];

      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll("td, th");
        if (cells.length === 0) continue;

        var rowObj = {};
        for (var j = 0; j < cells.length; j++) {
          var cellText = __sfera_crawler_getText(cells[j]);
          if (!cellText) continue;

          if (headers && headers[j]) {
            rowObj[headers[j]] = cellText;
          } else {
            rowObj["Col " + (j + 1)] = cellText;
          }
        }
        results.push(rowObj);
      }

      return results;
    },

    /**
     * Scrape all tables on the page.
     */
    scrape: function () {
      var result = [];
      try {
        var tables = document.querySelectorAll("table");

        for (var i = 0; i < tables.length; i++) {
          var table = tables[i];
          if (!__sfera_crawler_isVisible(table)) continue;

          var rows = this._extractRows(table);
          if (rows.length > 0) {
            var caption = table.querySelector("caption");
            var tableName = caption ? __sfera_crawler_getText(caption) : "Table " + (i + 1);
            result.push({
              name: tableName,
              data: rows,
              source: "table",
            });
          }
        }
      } catch (e) {
        // ignore
      }

      return Promise.resolve(result);
    },
  };

  // ─────────────────────────────────────────────
  // S4: GenericDomDump Strategy
  // ─────────────────────────────────────────────

  var __sfera_crawler_S4 = {
    name: "GenericDomDump",
    source: "generic",

    /**
     * Find the nearest heading (h1-h6) ancestor for an element.
     */
    _findNearestHeading: function (el) {
      var heading = el.closest("h1, h2, h3, h4, h5, h6");
      if (heading) return __sfera_crawler_getText(heading);

      // Search parent chain
      var parent = el.parentElement;
      while (parent) {
        var h = parent.querySelector("h1, h2, h3, h4, h5, h6");
        if (h) return __sfera_crawler_getText(h);
        parent = parent.parentElement;
      }

      // Search section ancestor
      var section = el.closest("section, article, [role='region'], [class*='section']");
      if (section) {
        var s = section.querySelector("h1, h2, h3, h4, h5, h6");
        if (s) return __sfera_crawler_getText(s);
      }

      return null;
    },

    /**
     * Dump text blocks grouped by nearest heading/section.
     */
    scrape: function () {
      var result = {};
      try {
        var selectors = "div, span, p, section, article, li, dd, dt";
        var elements = document.querySelectorAll(selectors);
        var seen = {};

        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          if (!__sfera_crawler_isVisible(el)) continue;

          var text = __sfera_crawler_getText(el);
          if (!text || text.length < 3) continue;

          // Skip if element is only whitespace
          if (/^\s*$/.test(text)) continue;

          var key = el.getAttribute("data-testid") || el.className || el.tagName;
          if (seen[key]) continue;
          seen[key] = true;

          var heading = this._findNearestHeading(el);
          if (heading) {
            if (!result[heading]) {
              result[heading] = {};
            }
            result[heading][text.substring(0, 50)] = text;
          } else {
            result["Uncategorized"] = result["Uncategorized"] || {};
            result["Uncategorized"][text.substring(0, 50)] = text;
          }
        }
      } catch (e) {
        // ignore
      }

      return Promise.resolve(result);
    },
  };

  // ─────────────────────────────────────────────
  // S5: EmbeddedDataExtractor Strategy
  // ─────────────────────────────────────────────

  var __sfera_crawler_S5 = {
    name: "EmbeddedDataExtractor",
    source: "embedded",

    /**
     * Extract SSR/SPA preloaded state from window globals and script tags.
     * Microfrontends often embed initial data via:
     *   - window.__INITIAL_STATE__
     *   - window.__PRELOADED_STATE__
     *   - <script id="__NEXT_DATA__" type="application/json">
     *   - <script type="application/json"> with data-* attrs
     *   - <script> with __INITIAL_STATE__ assignment
     */
    scrape: function () {
      var result = {};

      try {
        // 1. window.__INITIAL_STATE__ (common in module federation SPAs)
        if (
          typeof window.__INITIAL_STATE__ !== "undefined" &&
          window.__INITIAL_STATE__ !== null
        ) {
          result["__INITIAL_STATE__"] = JSON.parse(
            JSON.stringify(window.__INITIAL_STATE__)
          );
        }
      } catch (e) {
        // ignore
      }

      try {
        // 2. window.__PRELOADED_STATE__ (common in Redux SSR)
        if (
          typeof window.__PRELOADED_STATE__ !== "undefined" &&
          window.__PRELOADED_STATE__ !== null
        ) {
          result["__PRELOADED_STATE__"] = JSON.parse(
            JSON.stringify(window.__PRELOADED_STATE__)
          );
        }
      } catch (e) {
        // ignore
      }

      try {
        // 3. <script id="__NEXT_DATA__" type="application/json">
        var nextDataScript = document.getElementById("__NEXT_DATA__");
        if (nextDataScript && nextDataScript.textContent) {
          var parsed = JSON.parse(nextDataScript.textContent);
          result["__NEXT_DATA__"] = parsed;
        }
      } catch (e) {
        // ignore
      }

      try {
        // 4. All <script type="application/json"> tags (generic SSR pattern)
        var jsonScripts = document.querySelectorAll(
          'script[type="application/json"]'
        );
        for (var i = 0; i < jsonScripts.length; i++) {
          var script = jsonScripts[i];
          var scriptId = script.id || "json-script-" + (i + 1);
          if (script.textContent) {
            try {
              var parsed = JSON.parse(script.textContent);
              result[scriptId] = parsed;
            } catch (e) {
              // individual parse failure — skip
            }
          }
        }
      } catch (e) {
        // ignore
      }

      try {
        // 5. <script> with assignment to __INITIAL_STATE__ or similar
        //    Pattern: window.__INITIAL_STATE__ = {...} or var initialState = {...}
        var allScripts = document.querySelectorAll("script:not([type])");
        for (var j = 0; j < allScripts.length; j++) {
          var s = allScripts[j];
          if (!s.textContent) continue;
          var text = s.textContent;

          // Match: window.__INITIAL_STATE__ = {...}
          //         or __INITIAL_STATE__ = {...}
          //         or __PRELOADED_STATE__ = {...}
          var match = text.match(
            /(?:window\.)?__(?:INITIAL|PRELOADED)_STATE__\s*=\s*(\{.+?\});/s
          );
          if (match && match[1]) {
            try {
              result["__STATE_ASSIGNMENT__"] = JSON.parse(match[1]);
            } catch (e) {
              // ignore JSON parse errors
            }
          }
        }
      } catch (e) {
        // ignore
      }

      return Promise.resolve(result);
    },
  };

  // ─────────────────────────────────────────────
  // Infrastructure URL Filter
  // ─────────────────────────────────────────────

  /**
   * Remove infrastructure API calls from captured API data.
   * These are internal calls (localization, auth, themes, routes)
   * that don't carry change-specific data.
   */
  function __sfera_crawler_filterInfrastructureApi(apiData) {
    if (!apiData || typeof apiData !== "object") {
      return apiData;
    }

    var filtered = {};
    var keys = Object.keys(apiData);
    for (var i = 0; i < keys.length; i++) {
      var url = keys[i];
      var isInfrastructure = false;

      for (var j = 0; j < __sfera_crawler_INFRASTRUCTURE_PATTERNS.length; j++) {
        if (url.indexOf(__sfera_crawler_INFRASTRUCTURE_PATTERNS[j]) !== -1) {
          isInfrastructure = true;
          break;
        }
      }

      if (!isInfrastructure) {
        filtered[url] = apiData[url];
      }
    }

    return filtered;
  }

  // ─────────────────────────────────────────────
  // Entity Field Whitelist
  // ─────────────────────────────────────────────

  /**
   * Strip non-whitelisted fields from entity API responses.
   * Only URLs matching __sfera_crawler_ENTITY_API_PATTERN are filtered;
   * all other API responses pass through unchanged.
   * This dramatically reduces data volume and chrome.runtime.sendMessage payload.
   */
  function __sfera_crawler_applyFieldWhitelist(apiData) {
    if (!apiData || typeof apiData !== "object") {
      return apiData;
    }

    var result = {};
    var keys = Object.keys(apiData);

    for (var i = 0; i < keys.length; i++) {
      var url = keys[i];
      var data = apiData[url];

      // Only filter entity API responses
      if (url.indexOf(__sfera_crawler_ENTITY_API_PATTERN) !== -1 && data && typeof data === "object" && !Array.isArray(data)) {
        var filtered = {};
        for (var j = 0; j < __sfera_crawler_ENTITY_FIELD_WHITELIST.length; j++) {
          var field = __sfera_crawler_ENTITY_FIELD_WHITELIST[j];
          if (field in data) {
            filtered[field] = data[field];
          }
        }
        result[url] = filtered;
      } else {
        // Non-entity responses pass through unchanged
        result[url] = data;
      }
    }

    return result;
  }

  // ─────────────────────────────────────────────
  // Merger
  // ─────────────────────────────────────────────

  /**
   * Merge strategy results with priority: API > Form > Table > Embedded > Generic.
   * Later strategies fill gaps but do NOT overwrite existing keys.
   */
  function __sfera_crawler_mergeResults(apiData, formResult, tableResult, genericResult, embeddedResult) {
    var merged = {};
    var strategies = [];

    // S1: API data — highest priority
    if (apiData && Object.keys(apiData).length > 0) {
      strategies.push("api");
      var apiKeys = Object.keys(apiData);
      for (var i = 0; i < apiKeys.length; i++) {
        merged[apiKeys[i]] = apiData[apiKeys[i]];
      }
    }

    // S5: Embedded data (SSR/preloaded state) — next priority after API
    if (embeddedResult && Object.keys(embeddedResult).length > 0) {
      strategies.push("embedded");
      var embeddedKeys = Object.keys(embeddedResult);
      for (var e = 0; e < embeddedKeys.length; e++) {
        if (!(embeddedKeys[e] in merged)) {
          merged[embeddedKeys[e]] = embeddedResult[embeddedKeys[e]];
        }
      }
    }

    // S2: Form data — fills gaps
    if (formResult && Object.keys(formResult).length > 0) {
      strategies.push("form");
      var formKeys = Object.keys(formResult);
      for (var j = 0; j < formKeys.length; j++) {
        if (!(formKeys[j] in merged)) {
          merged[formKeys[j]] = formResult[formKeys[j]];
        }
      }
    }

    // S3: Table data — fills gaps
    if (tableResult && tableResult.length > 0) {
      strategies.push("table");
      for (var k = 0; k < tableResult.length; k++) {
        var tableName = tableResult[k].name || "Table " + (k + 1);
        if (!(tableName in merged)) {
          merged[tableName] = tableResult[k];
        }
      }
    }

    // S4: Generic data — fills gaps
    if (genericResult && Object.keys(genericResult).length > 0) {
      strategies.push("generic");
      var genericKeys = Object.keys(genericResult);
      for (var m = 0; m < genericKeys.length; m++) {
        if (!(genericKeys[m] in merged)) {
          merged[genericKeys[m]] = genericResult[genericKeys[m]];
        }
      }
    }

    return { merged: merged, strategies: strategies };
  }

  // ─────────────────────────────────────────────
  // Main World API Data Bridge (via postMessage)
  // ─────────────────────────────────────────────

  /**
   * Request API response data from the main-world interceptor
   * (api-interceptor.js, injected at document_start with world: MAIN).
   * Communication via window.postMessage bridges the isolated-world
   * content script and the main-world interceptor.
   *
   * Retries up to 5 times with 1s interval in case the SPA hasn't
   * finished its API calls yet.
   */
  function __sfera_crawler_requestApiData() {
    return new Promise(function (resolve) {
      // Increase attempts and interval — microfrontend loads dynamically,
      // its API calls may come with significant delay
      var maxAttempts = 15;
      var intervalMs = 2000;
      var attempts = 0;
      var done = false;

      function handler(event) {
        if (event.source !== window) return;
        if (
          event.data &&
          event.data.type === "__SFERA_API_DATA__"
        ) {
          done = true;
          window.removeEventListener("message", handler);
          resolve(event.data.data || null);
        }
      }

      window.addEventListener("message", handler);

      function sendRequest() {
        if (done) return;
        attempts++;
        window.postMessage({ type: "__SFERA_GET_API__" }, "*");

        if (attempts < maxAttempts) {
          setTimeout(sendRequest, intervalMs);
        } else if (!done) {
          window.removeEventListener("message", handler);
          resolve(null);
        }
      }

      // Initial delay — give the SPA time to mount microfrontends and make API calls
      setTimeout(sendRequest, 1000);
    });
  }

  // ─────────────────────────────────────────────
  // Generic Result Cleaner
  // ─────────────────────────────────────────────

  /**
   * Clean the output of GenericDomDump (S4):
   * - Remove @font-face and CSS rules that leak into text dump
   * - Remove icon-only entries (CamelCase icon component names)
   * - Remove self-referential (key === value) noise
   * - Remove empty or whitespace-only entries
   */
  function __sfera_crawler_cleanGenericResult(genericResult) {
    if (!genericResult || typeof genericResult !== "object") {
      return genericResult;
    }

    // Known icon/UI component name prefixes used by Sfera
    var iconPattern = /^(Chevron|Search|Update|Settings|Close|Plus|Link|Outline|Person|Info|Arrow|Edit|Copy|Refresh|Delete|Menu|More|Drag|Handle|Check|Clear|Filter|Sort)/;

    var cleaned = {};
    var rootKeys = Object.keys(genericResult);

    for (var i = 0; i < rootKeys.length; i++) {
      var sectionKey = rootKeys[i];
      var section = genericResult[sectionKey];

      if (typeof section !== "object" || section === null) {
        cleaned[sectionKey] = section;
        continue;
      }

      var cleanSection = {};
      var entryKeys = Object.keys(section);

      for (var j = 0; j < entryKeys.length; j++) {
        var key = entryKeys[j];
        var value = section[key];

        // 1. Skip CSS/font-face rules
        if (
          typeof value === "string" &&
          (value.indexOf("@font-face") === 0 ||
            (value.indexOf("{") !== -1 &&
              value.indexOf("}") !== -1 &&
              value.indexOf("font-family") !== -1))
        ) {
          continue;
        }

        // 2. Skip icon component names (CamelCase UI icon identifiers)
        if (
          typeof key === "string" &&
          /^[A-Z][a-zA-Z]+$/.test(key) &&
          key.length < 40 &&
          iconPattern.test(key)
        ) {
          continue;
        }

        // 3. Skip self-referential entries (key === value)
        if (key === value) {
          continue;
        }

        // 4. Skip entries where value is just whitespace or punctuation
        if (
          typeof value === "string" &&
          (value.trim() === "" || /^[\s\-–—.,;:!?]+$/.test(value))
        ) {
          continue;
        }

        // 5. Skip entries shorter than 2 characters
        if (
          typeof key === "string" &&
          key.trim().length < 2 &&
          typeof value !== "object"
        ) {
          continue;
        }

        cleanSection[key] = value;
      }

      if (Object.keys(cleanSection).length > 0) {
        cleaned[sectionKey] = cleanSection;
      }
    }

    return Object.keys(cleaned).length > 0 ? cleaned : genericResult;
  }

  // ─────────────────────────────────────────────
  // Message Sender
  // ─────────────────────────────────────────────

  /**
   * Send PAGE_DATA message to extension.
   */
  function __sfera_crawler_sendMessage(message) {
    try {
      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(message);
      }
    } catch (e) {
      // ignore send errors
    }
  }

  // ─────────────────────────────────────────────
  // Timing Mechanism
  // ─────────────────────────────────────────────

  var __sfera_crawler_initialized = false;

  /**
   * Core logic: wait for DOM stability, run strategies, send result.
   */
  function __sfera_crawler_run() {
    if (__sfera_crawler_initialized) return;
    __sfera_crawler_initialized = true;

    var urlInfo = __sfera_crawler_parseUrl();
    var changeNumber = urlInfo.changeNumber || null;
    var tabName = "entity";  // single entity API, no tab routing

    var observer = null;
    var mutationTimeout = null;
    var lastMutationTime = Date.now();
    var hasData = false;
    var completed = false;
    var cleanupDone = false;

    /**
     * Clean up all observers and interceptors.
     */
    function __sfera_crawler_cleanup() {
      if (cleanupDone) return;
      cleanupDone = true;

      if (observer) {
        try {
          observer.disconnect();
        } catch (e) {
          // ignore
        }
        observer = null;
      }

      if (mutationTimeout) {
        clearTimeout(mutationTimeout);
        mutationTimeout = null;
      }
    }

    /**
     * Execute all strategies and send result.
     */
    function __sfera_crawler_execute() {
      if (completed) return;
      completed = true;

      __sfera_crawler_cleanup();

      // Request API data intercepted by main-world interceptor (PRIMARY source)
      var mainWorldApiPromise = __sfera_crawler_requestApiData();
      // Legacy S1 cache (isolated-world — mostly dead but keep as fallback)
      var apiData = __sfera_crawler_S1.getData();
      var formPromise = __sfera_crawler_S2.scrape();
      var tablePromise = __sfera_crawler_S3.scrape();
      var genericPromise = __sfera_crawler_S4.scrape();
      var embeddedPromise = __sfera_crawler_S5.scrape();

      Promise.all([mainWorldApiPromise, formPromise, tablePromise, genericPromise, embeddedPromise])
        .then(function (results) {
          var mainWorldApiData = results[0]; // from main-world interceptor
          var formResult = results[1];
          var tableResult = results[2];
          var genericResult = results[3];
          var embeddedResult = results[4]; // SSR/preloaded state from S5

          // Merge main-world API data into effective API cache
          // Main world data has highest priority (actually catches real API calls)
          var effectiveApiData = {};
          if (mainWorldApiData && typeof mainWorldApiData === "object") {
            var mwKeys = Object.keys(mainWorldApiData);
            for (var i = 0; i < mwKeys.length; i++) {
              effectiveApiData[mwKeys[i]] = mainWorldApiData[mwKeys[i]];
            }
          }
          // S1 cache fills gaps (if anything was caught in isolated world)
          if (apiData && typeof apiData === "object") {
            var s1Keys = Object.keys(apiData);
            for (var j = 0; j < s1Keys.length; j++) {
              if (!(s1Keys[j] in effectiveApiData)) {
                effectiveApiData[s1Keys[j]] = apiData[s1Keys[j]];
              }
            }
          }

          // Filter out infrastructure calls (localization, auth, themes, routes)
          var filteredApiData = __sfera_crawler_filterInfrastructureApi(effectiveApiData);
          // Apply field whitelist — keep only user-selected entity fields
          filteredApiData = __sfera_crawler_applyFieldWhitelist(filteredApiData);

          // Clean generic output: remove CSS, icons, noise
          var cleanedGeneric = __sfera_crawler_cleanGenericResult(genericResult);

          // Merge all strategies: API > Form > Table > Embedded > Generic
          var merged = __sfera_crawler_mergeResults(
            filteredApiData,
            formResult,
            tableResult,
            cleanedGeneric,
            embeddedResult
          );

          // Check if we have any data
          var hasAnyData =
            Object.keys(filteredApiData).length > 0 ||
            (formResult && Object.keys(formResult).length > 0) ||
            (tableResult && tableResult.length > 0) ||
            (cleanedGeneric && Object.keys(cleanedGeneric).length > 0) ||
            (embeddedResult && Object.keys(embeddedResult).length > 0);

          if (!hasAnyData) {
            hasData = false;
            __sfera_crawler_sendMessage({
              type: "PAGE_DATA",
              data: {},
              changeNumber: changeNumber,
              tabName: tabName,
              strategies: [],
              partial: true,
            });
            __sfera_crawler_cleanup();
            return;
          }

          hasData = true;

          // Build strategy list: base strategies + API if we got data
          var strategies = merged.strategies.slice(); // copy
          if (Object.keys(effectiveApiData).length > 0) {
            strategies.push("api-main-world");
          }

          __sfera_crawler_sendMessage({
            type: "PAGE_DATA",
            data: merged.merged,
            changeNumber: changeNumber,
            tabName: tabName,
            strategies: strategies,
            partial: false,
          });

          __sfera_crawler_cleanup();
        })
        .catch(function (err) {
          // ignore strategy errors
          __sfera_crawler_cleanup();
        });
    }

    /**
     * MutationObserver callback — track DOM stability.
     */
    function __sfera_crawler_onMutation() {
      lastMutationTime = Date.now();

      if (mutationTimeout) {
        clearTimeout(mutationTimeout);
      }

      mutationTimeout = setTimeout(function () {
        // DOM stable — execute strategies
        __sfera_crawler_execute();
      }, __sfera_crawler_MUTATION_THRESHOLD);
    }

    // Start MutationObserver
    observer = new MutationObserver(__sfera_crawler_onMutation);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    // Fallback: if no mutations happen, execute after timeout
    setTimeout(function () {
      if (!completed) {
        __sfera_crawler_execute();
      }
    }, __sfera_crawler_TIMEOUT_THRESHOLD);
  }

  // ─────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────

  /**
   * Initialize the crawler.
   */
  function __sfera_crawler_init() {
    // Start API interception immediately
    __sfera_crawler_S1.scrape();

    // Run timing mechanism
    if (document.readyState === "complete" || document.readyState === "interactive") {
      __sfera_crawler_run();
    } else {
      document.addEventListener("DOMContentLoaded", function () {
        __sfera_crawler_run();
      });
    }
  }

  // Boot
  if (document.readyState !== "loading") {
    __sfera_crawler_init();
  } else {
    document.addEventListener("DOMContentLoaded", __sfera_crawler_init);
  }
})();
