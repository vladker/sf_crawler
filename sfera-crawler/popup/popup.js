/* eslint-disable no-undef */
/**
 * Sfera Crawler — Popup UI
 * Communicates with background service worker via chrome.runtime.sendMessage.
 * Manages crawl configuration, start/stop/resume, and status display.
 */

(function () {
  "use strict";

  var __sfera_crawler_popup = {
    isRunning: false,
    hasSavedProgress: false,
    logEntries: [],
    statusPollId: null,

    // DOM refs
    els: {},

    /**
     * Initialize popup: bind DOM elements, load status.
     */
    init: function () {
      this.els = {
        startNumber: document.getElementById("startNumber"),
        endNumber: document.getElementById("endNumber"),
        delay: document.getElementById("delay"),
        delayNum: document.getElementById("delayNum"),
        delayValue: document.getElementById("delayValue"),
        concurrency: document.getElementById("concurrency"),
        concurrencyNum: document.getElementById("concurrencyNum"),
        concurrencyValue: document.getElementById("concurrencyValue"),
        maxErrors: document.getElementById("maxErrors"),
        modeRadios: document.querySelectorAll(
          'input[name="mode"]'
        ),
        autoDownload: document.getElementById("autoDownload"),
        startBtn: document.getElementById("startBtn"),
        stopBtn: document.getElementById("stopBtn"),
        resumeBtn: document.getElementById("resumeBtn"),
        downloadBtn: document.getElementById("downloadBtn"),
        csvBtn: document.getElementById("csvBtn"),
        exportButtons: document.getElementById("exportButtons"),
        currentNumber: document.getElementById("currentNumber"),
        collected: document.getElementById("collected"),
        errors: document.getElementById("errors"),
        log: document.getElementById("log"),
      };

      this.bindEvents();
      this.syncDelay();
      this.checkSavedProgress();
    },

    /**
     * Bind UI event handlers.
     */
    bindEvents: function () {
      var self = this;

      // Start
      if (this.els.startBtn) {
        this.els.startBtn.addEventListener("click", function () {
          self.onStart();
        });
      }

      // Stop
      if (this.els.stopBtn) {
        this.els.stopBtn.addEventListener("click", function () {
          self.onStop();
        });
      }

      // Resume
      if (this.els.resumeBtn) {
        this.els.resumeBtn.addEventListener("click", function () {
          self.onResume();
        });
      }

      // Download JSON
      if (this.els.downloadBtn) {
        this.els.downloadBtn.addEventListener("click", function () {
          self.onDownload();
        });
      }

      // Download CSV
      if (this.els.csvBtn) {
        this.els.csvBtn.addEventListener("click", function () {
          self.onExportCsv();
        });
      }

      // Delay slider ↔ number sync
      if (this.els.delay) {
        this.els.delay.addEventListener("input", function () {
          var val = parseInt(self.els.delay.value, 10);
          if (self.els.delayNum) self.els.delayNum.value = val;
          if (self.els.delayValue)
            self.els.delayValue.textContent = val;
        });
      }

      // Concurrency slider ↔ number sync
      if (this.els.concurrency) {
        this.els.concurrency.addEventListener("input", function () {
          var val = parseInt(self.els.concurrency.value, 10);
          if (self.els.concurrencyNum) self.els.concurrencyNum.value = val;
          if (self.els.concurrencyValue) self.els.concurrencyValue.textContent = val;
        });
      }

      if (this.els.concurrencyNum) {
        this.els.concurrencyNum.addEventListener("input", function () {
          var val = parseInt(self.els.concurrencyNum.value, 10);
          if (isNaN(val) || val < 1) val = 1;
          if (val > 5) val = 5;
          if (self.els.concurrency) self.els.concurrency.value = val;
          if (self.els.concurrencyValue) self.els.concurrencyValue.textContent = val;
        });
      }

      if (this.els.delayNum) {
        this.els.delayNum.addEventListener("input", function () {
          var val = parseInt(self.els.delayNum.value, 10);
          if (isNaN(val) || val < 1000) val = 1000;
          if (val > 30000) val = 30000;
          if (self.els.delay) self.els.delay.value = val;
          if (self.els.delayValue)
            self.els.delayValue.textContent = val;
        });
      }

      // Listen for STATUS messages from background
      try {
        chrome.runtime.onMessage.addListener(function (message) {
          try {
            if (message && message.type === "STATUS") {
              self.updateStatus(message.payload);
            }
          } catch (e) {
            // ignore
          }
        });
      } catch (e) {
        self.addLogEntry(
          "Ошибка: не удалось подключиться к фону"
        );
      }
    },

    /**
     * Sync delay display value.
     */
    syncDelay: function () {
      if (this.els.delay && this.els.delayValue) {
        this.els.delayValue.textContent = this.els.delay.value;
      }
    },

    /**
     * Check for saved progress to show Resume button.
     */
    checkSavedProgress: function () {
      var self = this;
      try {
        chrome.runtime.sendMessage(
          { type: "GET_STATUS" },
          function (response) {
            void chrome.runtime.lastError;
            if (!response) return;
            // Update full UI with current status (show export buttons if crawl finished)
            self.updateStatus(response);
            if (response.hasSavedProgress) {
              self.hasSavedProgress = true;
              if (self.els.resumeBtn) {
                self.els.resumeBtn.style.display = "";
              }
            }
          }
        );
      } catch (e) {
        // background may not be ready
      }
    },

    /**
     * Validate form fields.
     */
    validate: function () {
      var startVal = this.els.startNumber
        ? this.els.startNumber.value.trim()
        : "";
      if (!startVal) {
        this.addLogEntry("Ошибка: введите стартовый номер");
        return false;
      }
      var startNum = parseInt(startVal, 10);
      if (isNaN(startNum) || startNum < 1) {
        this.addLogEntry(
          "Ошибка: стартовый номер должен быть положительным числом"
        );
        return false;
      }

      var endVal = this.els.endNumber
        ? this.els.endNumber.value.trim()
        : "";
      if (endVal) {
        var endNum = parseInt(endVal, 10);
        if (isNaN(endNum)) {
          this.addLogEntry(
            "Ошибка: конечный номер должен быть числом"
          );
          return false;
        }
        if (endNum < startNum) {
          this.addLogEntry(
            "Ошибка: конечный номер меньше стартового"
          );
          return false;
        }
      }

      return true;
    },

    /**
     * Collect form data.
     */
    getFormData: function () {
      var mode = "single";
      if (this.els.modeRadios) {
        for (var i = 0; i < this.els.modeRadios.length; i++) {
          if (this.els.modeRadios[i].checked) {
            mode = this.els.modeRadios[i].value;
            break;
          }
        }
      }

      return {
        startNumber: this.els.startNumber
          ? parseInt(this.els.startNumber.value, 10)
          : 0,
        endNumber: this.els.endNumber
          ? parseInt(this.els.endNumber.value, 10) || null
          : null,
        delay: this.els.delay
          ? parseInt(this.els.delay.value, 10)
          : 3000,
        mode: mode,
        concurrency: this.els.concurrency
          ? parseInt(this.els.concurrency.value, 10) || 3
          : 3,
        maxErrors: this.els.maxErrors
          ? parseInt(this.els.maxErrors.value, 10) || 10
          : 10,
        autoDownload: this.els.autoDownload
          ? this.els.autoDownload.checked
          : false,
      };
    },

    /**
     * Handle Start button click.
     */
    onStart: function () {
      var self = this;
      if (this.isRunning) return;
      if (!this.validate()) return;

      var formData = this.getFormData();
      this.addLogEntry(
        "Запуск: C-VTB-" + formData.startNumber +
          (formData.endNumber ? " → " + formData.endNumber : "") +
          " (задержка: " + formData.delay + "ms" +
          ", режим: " + formData.mode + ")"
      );

      try {
        chrome.runtime.sendMessage(
          { type: "START", payload: formData },
          function (response) {
            void chrome.runtime.lastError;
            if (response && !response.success) {
              self.addLogEntry(
                "Ошибка запуска: " +
                  (response.error || "неизвестная")
              );
            }
          }
        );
      } catch (e) {
        self.addLogEntry(
          "Ошибка отправки START: " + e.message
        );
      }

      // Remember autoDownload for the duration of this crawl
      self.autoDownloadEnabled = formData.autoDownload;

      this.setRunning(true);
      this.startStatusPoll();
    },

    /**
     * Handle Stop button click.
     */
    onStop: function () {
      if (!this.isRunning) return;
      this.addLogEntry("Остановка обхода...");

      try {
        chrome.runtime.sendMessage({ type: "STOP" }, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) {
        // ignore
      }

      this.setRunning(false);
      this.stopStatusPoll();
    },

  /**
   * Handle CSV Export button click — ask background to generate CSV.
   */
    onExportCsv: function () {
      var self = this;
      self.addLogEntry("Экспорт CSV...");
      try {
        chrome.runtime.sendMessage(
          { type: "EXPORT_CSV" },
          function (response) {
            void chrome.runtime.lastError;
            if (response) {
              if (response.success) {
                self.addLogEntry("CSV экспорт запущен");
              } else {
                self.addLogEntry(
                  "Ошибка CSV: " + (response.error || "неизвестная")
                );
              }
            } else {
              self.addLogEntry("Ошибка: нет ответа от фона");
            }
          }
        );
      } catch (e) {
        self.addLogEntry(
          "Ошибка отправки EXPORT_CSV: " + e.message
        );
      }
    },

  /**
   * Handle Download button click — fetch data from background and save via popup.
   */
    onDownload: function () {
      var self = this;
      self.addLogEntry("Ручной экспорт JSON...");
      try {
      chrome.runtime.sendMessage(
        { type: "GET_EXPORT_DATA" },
        function (response) {
          void chrome.runtime.lastError;
          if (!response || !response.data) {
            self.addLogEntry(
              "Ошибка: " + ((response && response.error) || "нет данных")
            );
            return;
          }

          var data = response.data;
          var jsonStr = JSON.stringify(data, null, 2);
          var blob = new Blob([jsonStr], { type: "application/json" });
          var url = URL.createObjectURL(blob);

          var a = document.createElement("a");
          a.href = url;
          a.download = response.filename || "sfera-changes.json";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          // Revoke after a short delay to ensure download started
          setTimeout(function () {
            URL.revokeObjectURL(url);
          }, 1000);

          self.addLogEntry("Файл \"" + a.download + "\" сохранён");
        }
      );
    } catch (e) {
      self.addLogEntry(
        "Ошибка экспорта: " + e.message
      );
    }
  },

  /**
   * Handle Resume button click.
   */
    onResume: function () {
      var self = this;
      if (this.isRunning) return;
      this.addLogEntry("Возобновление обхода...");

      try {
        chrome.runtime.sendMessage(
          { type: "RESUME" },
          function (response) {
            void chrome.runtime.lastError;
            if (response && !response.success) {
              self.addLogEntry(
                "Ошибка: " +
                  (response.error || "не удалось возобновить")
              );
            }
          }
        );
      } catch (e) {
        self.addLogEntry(
          "Ошибка отправки RESUME: " + e.message
        );
      }

      this.setRunning(true);
      this.startStatusPoll();
    },

    /**
     * Update UI with status from background.
     */
    updateStatus: function (payload) {
      if (!payload) return;

      if (this.els.currentNumber) {
        this.els.currentNumber.textContent =
          payload.currentNumber || "—";
      }
      if (this.els.collected) {
        this.els.collected.textContent =
          payload.processedCount + "/" + (payload.totalCount || "∞");
      }
      if (this.els.errors) {
        this.els.errors.textContent = payload.errorsCount || "0";
      }

      // Show export buttons container if there's collected data
      if (this.els.exportButtons) {
        var collected = payload.processedCount || 0;
        this.els.exportButtons.style.display =
          collected > 0 && payload.status !== "running"
            ? ""
            : "none";
      }

      // Update running state from status
      if (payload.status === "running" && !this.isRunning) {
        this.setRunning(true);
        this.startStatusPoll();
      } else if (
        payload.status !== "running" &&
        this.isRunning
      ) {
        this.setRunning(false);
        this.stopStatusPoll();

        // Auto-download on completion if enabled
        if (
          payload.status === "completed" &&
          this.autoDownloadEnabled &&
          (payload.processedCount || 0) > 0
        ) {
          this.autoDownloadEnabled = false;
          this.addLogEntry("Автоскачивание...");
          var popup = this;
          setTimeout(function () {
            popup.onDownload();
          }, 300);
        }
      }

      // Add log entries from status
      if (payload.log && payload.log.length > 0) {
        for (
          var i = 0;
          i < payload.log.length;
          i++
        ) {
          var entry = payload.log[i];
          if (
            this.logEntries.indexOf(entry) === -1
          ) {
            this.addLogEntry(entry);
          }
        }
      }
    },

    /**
     * Add entry to log container.
     */
    addLogEntry: function (text) {
      if (!text) return;
      this.logEntries.push(text);
      if (this.logEntries.length > 50) {
        this.logEntries.shift();
      }

      if (this.els.log) {
        var line = document.createElement("div");
        line.className = "log-entry";
        line.textContent = text;
        this.els.log.appendChild(line);
        this.els.log.scrollTop = this.els.log.scrollHeight;
      }
    },

    /**
     * Toggle UI between running and stopped states.
     */
    setRunning: function (running) {
      this.isRunning = running;
      if (this.els.startBtn) {
        this.els.startBtn.disabled = running;
      }
      if (this.els.stopBtn) {
        this.els.stopBtn.disabled = !running;
      }
      if (this.els.resumeBtn) {
        this.els.resumeBtn.style.display = running
          ? "none"
          : this.hasSavedProgress
            ? ""
            : "none";
      }
    },

    /**
     * Start polling status every 2 seconds.
     */
    startStatusPoll: function () {
      this.stopStatusPoll();
      var self = this;
      this.statusPollId = setInterval(function () {
        if (!self.isRunning) {
          self.stopStatusPoll();
          return;
        }
        try {
          chrome.runtime.sendMessage(
            { type: "GET_STATUS" },
            function (response) {
              void chrome.runtime.lastError;
              if (response) {
                self.updateStatus(response);
              }
            }
          );
        } catch (e) {
          // ignore
        }
      }, 2000);
    },

    /**
     * Stop polling status.
     */
    stopStatusPoll: function () {
      if (this.statusPollId) {
        clearInterval(this.statusPollId);
        this.statusPollId = null;
      }
    },
  };

  // Boot
  document.addEventListener("DOMContentLoaded", function () {
    __sfera_crawler_popup.init();
  });
})();
