---
slug: chrome-extension-crawler
status: approved
scraping-strategies: api-interception, form-scraper, table-scraper, generic-dump
intent: clear
pending-action: write .omo/plans/chrome-extension-crawler.md
approach: Chrome Extension MV3 с content script для перехвата API-запросов и извлечения данных из SPA Sfera
---

# Draft: chrome-extension-crawler

## Components (topology ledger)
| Компонент | Outcome | Статус |
|---|---|---|
| popup UI | Настройка диапазона, задержки, формата, кнопки Start/Stop/Resume | active |
| background service worker | Оркестрация обхода (навигация по номерам + вкладкам), управление очередью | active |
| content script | Перехват API-ответов (fetch/XHR) + DOM-парсинг для каждого таба, отправка данных в background | active |
| JSON export | Формирование и скачивание результата через chrome.downloads | active |
| resume state | Сохранение прогресса в chrome.storage.local для возобновления после остановки | active |

## Open assumptions (announced defaults)
| Assumption | Default | Rationale | Reversible? |
|---|---|---|---|
| Данные экстракции | API-перехват (модификация fetch/XHR) + DOM fallback | SPA загружает данные через API — структурированный JSON надёжнее DOM-парсинга | yes |
| Delay между запросами | 3000ms (настраивается в popup) | Соотношение скорость/нагрузка | yes |
| Стоп-критерий | Пропуск с записью в лог, 10 пропусков подряд -> стоп (настраивается) | Защита от бесконечного цикла | yes |
| Формат вывода | Выбор пользователя: один JSON / пофайлово / обновление | Гибкость | yes |
| Вкладки | Все 10 | Явно указано пользователем | — |

## Findings (cited)
1. **Структура SPA**: React-приложение, Webpack 5 Module Federation, все HTML-файлы — обёртки с `<div id="root"/>`, контент рендерится динамически (zni/*.html)
2. **URL-паттерн**: `https://sfera.vtb.ru/ppcg-fw/change-tasks/C-VTB-{NUMBER}?tab={TAB_NAME}` (link.txt)
3. **Список табов**: mainInfo, influence, relatedItems, riskLevel, implementationTasks, implementationDecision, authorization, result, actualImpact, calendar (link.txt)
4. **Мониторинг**: Dynatrace Ruxit APM — означает, что система отслеживает нагрузку (важно: конфигурируемый delay)
5. **API-перехват**: Chrome extension content script может модифицировать window.fetch / XMLHttpRequest для захвата ответов в структурированном виде
6. **Cookies/сессия**: Сессионные cookie sfera.vtb.ru доступны из background через chrome.cookies API при наличии host_permissions
7. **Скачивание**: chrome.downloads.download позволяет сохранить JSON без запроса у пользователя

## Decisions (with rationale)
1. **Стратегии скраппинга (Strategy Pattern)**: Вместо одного способа — набор стратегий, которые работают последовательно и мержат результаты. Это покрывает разные структуры данных на разных табах SPA.
2. **API Interception (стратегия 1)**: Модификация fetch/XHR — захват JSON-ответов сервера. Самый структурированный источник.
3. **Form Scraper (стратегия 2)**: Парсинг всех label-input, label-select, fieldset пар в DOM. Покрывает стандартные формы.
4. **Table Scraper (стратегия 3)**: Извлечение всех таблиц (thead + tbody → массив объектов). Покрывает табличные данные.
5. **Generic DOM Dump (стратегия 4)**: Универсальный сбор — все видимые текстовые блоки, сгруппированные по ближайшему заголовку/h. Крайний случай, если остальные стратегии ничего не дали.
6. **Background Service Worker как оркестратор**: Единственный persistent-компонент. Управляет очередью (changeNumber → tab), слушает onCompleted, отправляет inject.
7. **Content Script через chrome.scripting.executeScript**: Динамическая инъекция при каждой загрузке таба. Это даёт свежий контекст для перехвата API-запросов.
8. **Хранение прогресса в chrome.storage.local**: Позволяет остановить и возобновить обход без потери данных.
9. **IndexedDB для больших объёмов**: Для >1000 изменений — предотвращает потерю данных при падении.

## Scope IN
- Chrome Extension Manifest V3 для chrome.sfera.vtb.ru
- Popup с интерфейсом: диапазон номеров, задержка, формат вывода, Start/Stop/Resume
- Обход всех 10 табов для каждого номера
- Извлечение данных из API-ответов (перехват fetch/XHR) + DOM fallback
- Сохранение результатов в JSON (один файл / по одному / обновление)
- Сохранение прогресса для возобновления

## Scope OUT (Must NOT have)
- Аутентификация — только ручная, через браузер
- Модификация данных на сайте — только чтение
- Парсинг PDF/изображений — только текст/HTML
- Многопоточный обход — строго последовательный (чтобы не нагружать систему)
- Поддержка Firefox/Edge — только Chrome

## Open questions
(все forks были решены пользователем в опросе)

## Approval gate
status: awaiting-approval
<!-- После утверждения → write .omo/plans/chrome-extension-crawler.md -->
