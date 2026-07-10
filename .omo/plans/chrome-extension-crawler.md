# chrome-extension-crawler - Work Plan

## TL;DR (For humans)

**What you'll get:** Chrome-расширение (плагин) для браузера. Вы открываете sfera.vtb.ru, логинитесь один раз, открываете popup расширения, указываете диапазон номеров (C-VTB-XXXXX), задержку — и оно само обходит все 10 вкладок для каждого изменения и сохраняет все данные в JSON-файл.

**Why this approach:** Расширение работает прямо в вашем браузере — не требует отдельного сервера, использует вашу сессию (куки), не нагружает систему (настраиваемая задержка). Перехватывает API-ответы SPA — это даёт структурированные данные вместо грязного парсинга HTML.

**What it will NOT do:** Не требует пароля (вы логинитесь сами). Ничего не меняет на сайте. Не использует много потоков (только последовательно, чтобы не нагружать). Не работает в Firefox/Edge (только Chrome).

**Effort:** Medium
**Risk:** Medium — SPA может измениться, API-эндпоинты могут поменяться
**Decisions to sanity-check:** 1) API-перехват vs DOM scraping; 2) формат вывода (один/несколько файлов)

Your next move: approve. Full execution detail follows below.

---

> TL;DR (machine): Medium effort, Medium risk, Chrome Extension MV3 for sfera.vtb.ru change-tasks crawler with API interception, 10 tab extraction, resumable JSON export.

## Scope
### Must have
1. Chrome Extension MV3 с popup-интерфейсом (диапазон номеров, задержка, выбор формата вывода)
2. **Множественные стратегии скраппинга** (Strategy Pattern), работающие последовательно и мержащие результаты:
   - **S1: API Interceptor** — перехват fetch/XHR ответов SPA (JSON с сервера)
   - **S2: Form Scraper** — парсинг label-input, label-select, fieldset пар из DOM
   - **S3: Table Scraper** — извлечение всех таблиц (thead + tbody → массив объектов)
   - **S4: Generic DOM Dump** — все видимые текстовые блоки, сгруппированные по заголовкам
   - Каждая стратегия помечает источник данных (чтобы было видно, откуда что взято)
3. Обход всех 10 табов (mainInfo, influence, relatedItems, riskLevel, implementationTasks, implementationDecision, authorization, result, actualImpact, calendar)
4. Обход от N до M (пока не будет N ошибок подряд)
5. Сохранение результатов: 
   - Один JSON-файл со всеми изменениями
   - Или по одному JSON-файлу на изменение
   - Или обновление существующих файлов (upsert по номеру)
6. Сохранение прогресса (Resume после остановки)
7. Логирование пропущенных/ошибочных номеров

### Must NOT have (guardrails, anti-slop, scope boundaries)
- Никакой автоматической аутентификации/логина
- Никакого параллельного/многопоточного обхода
- Никакой модификации данных на сайте
- Никакого парсинга PDF/изображений/вложений
- Никакой поддержки Chrome OS/Android/iOS

## Verification strategy
- Test decision: Manual QA + структурная проверка JSON-вывода
- Evidence: .omo/evidence/ — логи обхода, примеры JSON, скриншоты

## Execution strategy
### Parallel execution waves
- Wave 1: Scaffold проекта + manifest.json + иконки
- Wave 2: Content script (API interception + DOM extraction)
- Wave 3: Background service worker (orchestrator)
- Wave 4: Popup UI
- Wave 5: JSON export + resume + интеграция компонентов

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. Scaffold | — | 2, 3, 4 | — |
| 2. Content script | 1 | 5 | 3, 4 |
| 3. Background worker | 1 | 5 | 2, 4 |
| 4. Popup UI | 1 | 5 | 2, 3 |
| 5. Export + Resume + Integration | 2, 3, 4 | — | — |
| F1-F4 | 5 | — | все |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Scaffold проекта Chrome Extension
  **Что сделать**: Создать папку `sfera-crawler/` и файлы: `manifest.json` (MV3, permissions: tabs, scripting, storage, downloads, webNavigation, cookies, host_permissions: https://sfera.vtb.ru/*), `background.js`, `content-script.js`, `popup/popup.html`, `popup/popup.css`, `popup/popup.js`, `icons/`. Иконку — простую SVG-иконку 128x128.
  **Must NOT**: Не добавлять лишних зависимостей, никаких сторонних библиотек (vanilla JS).
  **Parallelization**: Wave 1 | Blocked by: — | Blocks: 2, 3, 4
  **References**: zni/link.txt (URL pattern, tabs), zni/*.html (SPA structure)
  **Acceptance criteria**: manifest.json валиден, расширение загружается в chrome://extensions без ошибок
  **QA**: `chrome://extensions` — проверить загрузку. Попробовать открыть popup.
  **Commit**: Y | feat: scaffold Chrome Extension MV3 project structure

- [x] 2. Content script — архитектура стратегий скраппинга (4 стратегии + merger)
  **Что сделать**: Создать `content-script.js` с архитектурой Strategy Pattern.
  
  **Общая структура**:
  ```javascript
  // Каждая стратегия implements ScrapingStrategy:
  // { name: string, scrape(): Promise<Record<string, any>>, source: string }
  
  const strategies = [
    new ApiInterceptor(),   // S1
    new FormScraper(),      // S2
    new TableScraper(),     // S3
    new GenericDump(),      // S4
  ];
  // Sequential execution + merge результатов
  // Каждое значение помечается источником: { value, source: "api|form|table|generic" }
  ```
  
  **S1: API Interceptor**
  - Перехватывает `window.fetch` — сохраняет response.json() для URL, содержащих `/change-tasks/`
  - Перехватывает `XMLHttpRequest` — сохраняет responseText
  - Не модифицирует оригинальные ответы (только читает)
  
  **S2: Form Scraper**
  - Ищет все паттерны label-input: `label + input`, `label + select`, `label + textarea`
  - Ищет fieldset/field-group структуры
  - Извлекает значения: input.value / select.options[selected].text / textarea.value
  - Формирует `{ "Название поля": { value: "значение", source: "form" } }`
  
  **S3: Table Scraper**
  - Находит все `<table>` на странице
  - Для каждой: заголовки из `<thead>` + строки из `<tbody>` → массив объектов
  - Если заголовков нет — нумерует колонки
  
  **S4: Generic DOM Dump**
  - Ищет все текстовые блоки (div, span, p, section с текстом)
  - Группирует по ближайшему заголовку (h1-h6) или секции
  - Формирует вложенную структуру: `{ "Название секции": { "текст1": "...", "текст2": "..." } }`
  
  **Merger**:
  - Запускает стратегии последовательно (S1 → S2 → S3 → S4)
  - S1 даёт сырые JSON с сервера — самые точные
  - S2-S4 заполняют пробелы (там, где S1 не нашёл данных)
  - Приоритет: API > Form > Table > Generic (поздние не перезаписывают ранние)
  - Отправляет `{type: "PAGE_DATA", data: mergedResult, changeNumber, tabName, strategies: [...used]}`
  
  **Механизм тайминга**:
  - После `DOMContentLoaded` запускает MutationObserver
  - Ждёт 1.5с без мутаций → стабильный DOM → запускает S2-S4
  - S1 (API) работает постоянно с момента инжекта, ответы приходят асинхронно
  - Отправка: как только DOM стабилен + хотя бы одна стратегия дала данные
  - Если через 15с ничего не собрано — отправляет что есть с флагом `partial: true`
  - Удаляет все перехватчики после отправки
  
  **Must NOT**: Не модифицировать оригинальные API-ответы. Не использовать глобальные переменные без префикса `__sfera_crawler_`.
  **Parallelization**: Wave 2 | Blocked by: 1 | Blocks: 5
  **References**: background.js (формат PAGE_DATA), popup/popup.js (возможность выбора стратегий)
  **Acceptance criteria**: 
    - При загрузке `sfera.vtb.ru/ppcg-fw/change-tasks/C-VTB-*` content script выполняет все 4 стратегии
    - В логах background видно merged-сообщение PAGE_DATA с source-метками
    - Если API-перехват не нашёл данных, Form или Table scraper находят что-то из DOM
  **QA**: 
    1. Открыть страницу изменения → проверить сообщение PAGE_DATA с данными от S1 (API) + S2 (Form)
    2. Если API заблокирован — S2/S3/S4 должны дать данные из DOM
  **Commit**: Y | feat: multi-strategy scraping (API interception + Form + Table + Generic DOM)

- [x] 3. Background Service Worker — оркестратор обхода
  **Что сделать**: Создать `background.js` (service worker), который:
    1. Слушает сообщения от `popup.js`:
       - `{type: "START", payload: {startNumber, endNumber, delay, mode: "single|multi|update", maxErrors}}`
       - `{type: "STOP"}`
       - `{type: "RESUME"}`
       - `{type: "GET_STATUS"}`
    2. Оркестрирует обход:
       - Выбирает текущий номер → creates/updates tab
       - Следит за `webNavigation.onCompleted`
       - Инжектирует `content-script.js` через `chrome.scripting.executeScript`
       - Ждёт `PAGE_DATA` от content script
       - Если это последний таб для номера — сохраняет собранные данные
       - Переходит к следующему табу/номеру
    3. Обрабатывает ошибки:
       - Если загрузилась страница с ошибкой (нет такого изменения) — логирует и переходит к следующему номеру
       - Если таймаут (30с) — пробует ещё раз, после 3 попыток — пропускает
    4. Сохраняет прогресс: `chrome.storage.local.set({crawlerProgress: {...}})` после каждого номера
    5. Отправляет статус в popup: `{type: "STATUS", current, total, errors, collected: [...]}`
  **Must NOT**: Не использовать `setInterval/setTimeout` с малыми интервалами. Все задержки — через `await sleep(delay)`.
  **Parallelization**: Wave 2 | Blocked by: 1 | Blocks: 5
  **References**: content-script.js (ожидаемый PAGE_DATA), popup/popup.js (статус сообщения)
  **Acceptance criteria**: 
    - При запуске из popup: background открывает новую вкладку с первым номером
    - После получения PAGE_DATA переходит к следующему табу/номеру
    - При STOP сохраняет прогресс и завершает обход
    - При RESUME продолжает с сохранённого места
  **QA**: Запустить обход на 3 номера → проверить лог в background (chrome://extensions → Service Worker → Inspect).
  **Commit**: Y | feat: background service worker orchestrator with crawl/resume

- [x] 4. Popup UI — пользовательский интерфейс
  **Что сделать**: Создать popup-интерфейс:
    1. `popup/popup.html`: форма с полями:
       - Стартовый номер (обязательно)
       - Конечный номер (опционально — если пусто, обходить до N ошибок)
       - Задержка (ms, slider или input, по умолчанию 3000)
       - Режим вывода: radio (Один файл / По файлу на номер / Обновление)
       - Кнопки: Start / Stop / Resume
    2. `popup/popup.css`: чистый, аккуратный дизайн
    3. `popup/popup.js`: связь с background через `chrome.runtime.sendMessage`
       - Start: отправляет START + параметры
       - Stop: отправляет STOP
       - Resume: отправляет RESUME (если есть сохранённый прогресс)
       - Слушает STATUS обновления и показывает прогресс (текущий номер/всего, таб, ошибки)
    4. Страница статуса: текущий номер, текущий таб, сколько собрано, ошибки, лог последних действий
  **Must NOT**: Не использовать сторонние UI-библиотеки. Только vanilla HTML/CSS/JS.
  **Parallelization**: Wave 3 | Blocked by: 1 | Blocks: 5
  **References**: background.js (формат сообщений), content-script.js
  **Acceptance criteria**: 
    - Popup открывается из панели расширений
    - Все поля ввода работают
    - Кнопка Start отправляет START в background
    - Статус обновляется каждые 2 секунды
  **QA**: Открыть popup, заполнить, нажать Start → проверить в background что сообщение пришло.
  **Commit**: Y | feat: popup UI with crawl configuration and status display

- [x] 5. JSON Export + Resume + Интеграция
  **Что сделать**: Реализовать сохранение результатов:
    1. Накопление данных в background: `chrome.storage.session.set({crawlerData: {...}})` 
       - Для больших объёмов: передавать данные в popup частями и сохранять через `chrome.downloads.download` чанками
    2. Режимы вывода:
       - **Один файл**: `changes.json` — массив всех собранных изменений
       - **Пофайлово**: `C-VTB-XXXXX.json` для каждого номера
       - **Обновление**: проверять наличие файла по номеру, мержить/обновлять
    3. Resume: 
       - `chrome.storage.local.get('crawlerProgress')` при старте
       - Если есть — показать кнопку Resume в popup
       - При Resume: продолжить с последнего незавершённого номера
    4. Связать все компоненты: проверить поток popup → background → content → background → download
  **Must NOT**: Не сохранять данные в файловой системе расширения (только через chrome.downloads). 
  **Parallelization**: Wave 4 | Blocked by: 2, 3, 4 | Blocks: —
  **References**: background.js (data accumulation), popup/popup.js (format selection)
  **Acceptance criteria**: 
    - После обхода >0 номеров: скачивается JSON с данными
    - При повторном открытии popup: кнопка Resume активна если есть прогресс
    - Resume продолжает с прерванного номера
  **QA**: 
    1. Запустить обход 2 номеров → проверить JSON (один файл)
    2. Запустить обход 2 номеров → проверить пофайловый режим
    3. Прервать обход (Stop) → Resume → проверить что продолжил с того же места
  **Commit**: Y | feat: JSON export with single/multi/update modes and resume support

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit: проверить, что все todos выполнены, scope IN реализован, scope OUT не нарушен
- [x] F2. Code quality review: проверить код на наличие AI-слопов, дублирования, необработанных ошибок
- [~] F3. Real manual QA: загрузить расширение в Chrome, запустить обход на реальном сайте, проверить качество извлечения данных — **REQUIRES USER** (auth-gated site)
- [x] F4. Scope fidelity: убедиться, что расширение не модифицирует данные, не использует параллельные запросы, не пытается аутентифицироваться

## Commit strategy
1. feat: scaffold Chrome Extension MV3 project structure
2. feat: content script with API interception and DOM extraction
3. feat: background service worker orchestrator with crawl/resume
4. feat: popup UI with crawl configuration and status display
5. feat: JSON export with single/multi/update modes and resume support

## Success criteria
- Расширение загружается в Chrome без ошибок
- Popup открывается, параметры настраиваются
- Обход начинается, перебирает номера от N до N+M (или до N ошибок)
- Для каждого номера посещаются все 10 табов
- С каждого таба извлекаются данные (API interception + DOM fallback)
- Результат скачивается в JSON (в одном или нескольких файлах)
- Обход можно прервать и возобновить
- Система не перегружена (настраиваемая задержка работает)
