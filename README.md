# OpenCode MCP Bridge

Локальный MCP-сервер (Streamable HTTP) для делегирования задач в OpenCode.
Реализован на Node.js (`>=22.5`, нужен встроенный `node:sqlite`) с
официальным SDK `@modelcontextprotocol/sdk` (v1.32.x). По умолчанию слушает
loopback-адрес (адрес можно переопределить через BRIDGE_HOST) и вызывает `opencode api` через subprocess (без shell).

```
MCP-клиент → этот сервер (127.0.0.1:9999, Bearer-токен)
           → subprocess `opencode api ...` → агент/сессия OpenCode
```

> Статус: сервер и его конфигурация описаны по фактическому коду. Изолированный
> набор тестов (`npm test`) проходит в CI; сквозная проверка (`test/smoke.js`)
> выполнялась вручную против локального моста; совместимость с конкретными
> внешними MCP-клиентами не проверялась.

## Структура

- `src/config.js` — все константы и их env-переопределения `BRIDGE_*`
- `src/opencode-api.js` — обёртка `opencode api` + классификация ошибок
  (неоднозначный/определённый исход)
- `src/store.js` — SQLite-хранилище задач (`node:sqlite`)
- `src/executor.js` — жизненный цикл задач, один активный слот, watchdog,
  восстановление, проверка готовности executor-агента
- `src/auth.js` — случайный Bearer-токен (файл 0600) + проверка с постоянным
  временем
- `src/server.js` — Streamable HTTP MCP-сервер с мультисессионным
  жизненным циклом, валидацией аргументов и безопасными кодами ошибок
- `src/tool-diagnostics.js` — сводки вызовов инструментов (`name`, `status`,
  опциональные `error`/`callID`) и бюджет результата
- `src/sanitize.js` — best-effort редакция секретов в диагностическом тексте
- `src/main.js` — точка входа
- `test/mock.test.js` — изолированные mock-тесты (FakeApi, временная БД,
  реальный `opencode` не вызывается)
- `test/http.test.js` — тест HTTP/MCP жизненного цикла в процессе, реальный
  `opencode` не вызывается
- `test/api-compat.test.js` — совместимость с формами ответов `opencode api`
- `test/executor-integration.test.js` — жизненный цикл Executor без реального
  `opencode`
- `test/hardening.test.js` — проверки ужесточения/безопасных отказов
- `test/tool-error-diagnostics.test.js` — диагностика ошибок tool calls в
  `get_task_result`
- `test/sanitize-regression.test.js` — регрессии редакции секретов
- `test/tool-diagnostics-unit.test.js` — unit-тесты нормализации ошибок и
  бюджета
- `test/smoke.js` — ручная end-to-end проверка против **запущенного** сервера
- `executor-config.example.json` — **пример** конфигурации ограниченного
  executor-агента (не применён)
- `deploy/opencode-mcp-bridge.service` — systemd unit
- `deploy/install-autostart.sh` — установщик unit (только root)
- `scripts/test-isolated.js` — единый явный список изолированных тестов
- `run_tests.sh` — оболочка того же запуска, что и `npm test`
- `.env.example` — список поддерживаемых переменных окружения (не загружается
  автоматически)

## Установка и запуск (разработка)

```bash
npm install
BRIDGE_EXECUTOR_MODEL=apmix/deepseek-v4.1-flash-1017 npm start
# Пример модели: выберите доступную в вашей конфигурации OpenCode.
# По умолчанию слушает http://127.0.0.1:9999.
```

Остановка: `Ctrl+C` / `SIGTERM`. `npm start` = `node src/main.js`.

На первом старте рядом с проектом создаются:
- `.bearer_token` — случайный токен (права 0600), если файла ещё нет;
- `tasks.db` — база задач SQLite;
- `bridge.log` — лог.

Все три пути переопределяются (`BRIDGE_TOKEN_FILE`, `BRIDGE_DB_PATH`,
`BRIDGE_LOG_FILE`). Эти файлы локальные и не должны попадать в репозиторий
(см. `.gitignore`).

## Конфигурация и переменные окружения

Все переменные читаются из `process.env` в `src/config.js`; полный список с
дефолтами — в [`.env.example`](.env.example). Основные:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `BRIDGE_HOST` | `127.0.0.1` | адрес прослушивания |
| `BRIDGE_PORT` | `9999` | порт |
| `BRIDGE_DB_PATH` | `<repo>/tasks.db` | база задач |
| `BRIDGE_TOKEN_FILE` | `<repo>/.bearer_token` | файл Bearer-токена |
| `BRIDGE_LOG_FILE` | `<repo>/bridge.log` | лог |
| `BRIDGE_EXECUTOR_AGENT` | `executor` | имя агента OpenCode |
| `BRIDGE_EXECUTOR_MODEL` | нет, обязательна | модель `provider/model`, опционально `#variant`; без наследования модели OpenCode |
| `BRIDGE_WORKDIR` | `<repo>` | абсолютный каталог сессии, передаваемый как `location.directory`; не `cwd` CLI |
| `BRIDGE_OPENCODE_API_TIMEOUT_MS` | `30000` | таймаут одного вызова |
| `BRIDGE_TASK_EXECUTION_TIMEOUT_MS` | `300000` | таймаут задачи |
| `BRIDGE_WATCHDOG_INTERVAL_MS` | `3000` | период watchdog |
| `BRIDGE_MAX_PROMPT_LENGTH` | `10000` | макс. длина prompt |
| `BRIDGE_MAX_RESULT_LENGTH` | `50000` | макс. размер результата |
| `BRIDGE_MAX_REQUEST_BODY_SIZE` | `1048576` | макс. тело HTTP-запроса |
| `BRIDGE_MAX_SESSIONS` | `100` | макс. MCP-сессий |

Числовые значения `<= 0` или нечисловые заменяются дефолтом.

Если `BRIDGE_HOST` не loopback (`127.0.0.1`, `::1`, `localhost`), при старте
выводится предупреждение с именем хоста: мост даёт доступ к исполнению
инструментов по Bearer-токену, поэтому трафик и токен нужно защищать (TLS,
обратный прокси, файрвол). Запуск не блокируется; на loopback нового вывода
нет.

**Как передавать окружение.** Сервер **не загружает `.env` автоматически**
(в проекте нет dotenv). Варианты:

```bash
# 1) оболочка: экспортировать переменные перед запуском
set -a; . ./.env; set +a; node src/main.js

# 2) systemd: Environment= / EnvironmentFile= в unit
```

`.env.example` — только документация переменных; копия `.env` в репозиторий
не коммитится.

## Авторизация

Каждый запрос (GET/POST/DELETE) требует заголовок `Authorization: Bearer <token>`
иначе возвращается `401`. Токен создаётся один раз в `.bearer_token` (права
0600), не связан с токенами OpenCode/других сервисов и не логируется.

## MCP-инструменты

| Инструмент | Вход | Возврат |
|---|---|---|
| `submit_task` | `{ prompt }` | `{ taskID, status }` |
| `get_task_status` | `{ taskID }` | `{ taskID, status, outcome, error, cost, tokens }` |
| `get_task_result` | `{ taskID, cursor? }` | `{ taskID, status, result, toolCalls, outcome, error, hasMore, cursor, truncated, cost, tokens }` |
| `cancel_task` | `{ taskID }` | `{ taskID, cancelled, status }` |

Клиент не может передавать: agent/model, sessionID, произвольный API path,
shell-команды, путь проекта, permissions. Агент, модель и рабочая директория
задаются локально (`BRIDGE_EXECUTOR_AGENT`, `BRIDGE_EXECUTOR_MODEL`,
`BRIDGE_WORKDIR`). `inputSchema` описан для `tools/list`; аргументы
валидируются явно в коде.

### Диагностика вызовов инструментов (`get_task_result`)

`toolCalls` — массив сводок, собранных мостом из assistant-сообщений:
`{ name, status }` присутствуют всегда (`null`, если в исходном part поля
нет). Только при `status: "error"` могут появиться:

- `error` — строка из `state.error`/`state.detail` (с предпочтением полей
  `message`, `name`, `data`; геттеры и `toJSON` не вызываются, циклы
  помечаются `[circular]`). Сначала выполняется редакция секретов, затем
  управляющие символы заменяются пробелами, текст обрезается. Итог ограничен первыми 300 символами
  (при усечении добавляется `…`); пустой после очистки текст опускается.
- `callID` — идентификатор вызова берётся из `part.callID`, затем
  `part.toolCallID`, затем `state.callID`, а в реальных данных OpenCode — из
  `id` самой части (последний запасной источник), и только если это строка из
  `[A-Za-z0-9_.:-]` длиной 1..128. Поведение best-effort: иначе поле
  отсутствует и не синтезируется.

`input`, `output`, `args` и прочие поля tool part в ответ **не экспортируются**.
В `result` попадает только текст assistant-сообщений; reasoning исключается.

Извлечение ошибки ограничено глубиной 3 и бюджетом 20 посещаемых узлов;
строковое значение узла длиннее 16384 символов заменяется на
`[diagnostic omitted: oversized error]…`, а собранный текст длиннее 16384
символов целиком заменяется на `[REDACTED] oversized diagnostic`. Редакция — best-effort по шаблонам
(headers, `api_key`, `password`, `token`, Bearer, `sk-`, GitHub, AWS,
Slack): она **не гарантирует** отсутствие секретов в произвольном тексте.

Бюджет: `result.length + JSON.stringify(toolCalls).length` не должен
превышать `BRIDGE_MAX_RESULT_LENGTH` (по умолчанию 50000); это не размер
полного MCP-конверта. При превышении `truncated: true`, текст результата
усекается и получает `[TRUNCATED]`, при отборе приоритет отдаётся вызовам
со статусом `error` (в исходном порядке), длинные `error` могут усекаться,
часть сводок может быть отброшена. `truncated` относится только к бюджету,
не к пагинации `cursor`/`hasMore`. Отдельного счётчика числа ошибок нет.

Статус `partial` выставляется, когда OpenCode сообщил об успехе (outcome не
`failed`/`interrupted` и не пуст), но результат усечён по бюджету или среди
оставленных `toolCalls` есть вызов со `status: "error"`; полным успехом
такая задача не считается.
Ошибочный вызов инструмента возможен и при успешном итоге задачи: например,
если модель передала неизвестное имя аргумента, OpenCode отклоняет вызов, а
текст ошибки может показывать пустые аргументы.

## Мультисессионный Streamable HTTP

Один процесс обслуживает несколько MCP-клиентов: каждый `initialize` создаёт
отдельный транспорт + сессию, маршрутизация идёт по `mcp-session-id`,
`DELETE`/закрытие транспорта удаляет сессию. Все сессии используют **один
общий Executor** и общий лимит «одна активная задача». Отключение MCP-клиента
закрывает только его транспорт и **не отменяет** задачу OpenCode.

## Ошибки

Клиенту возвращаются только безопасные коды (`INVALID_ARGUMENT`,
`PROMPT_TOO_LONG`, `EXECUTOR_UNAVAILABLE`, `EXECUTOR_CHECK_FAILED`,
`AGENT_MISMATCH`, `MODEL_MISMATCH`, `SETUP_FAILED`, `NOT_FOUND`, `TASK_BUSY`,
`PROMPT_REJECTED`, `SESSION_CREATE_AMBIGUOUS`, `SESSION_CREATE_FAILED`,
`RESULT_UNAVAILABLE`, `STATUS_UNAVAILABLE`, `BAD_CONFIG`, `BAD_RESPONSE`, …)
без сырых сообщений. Подробности пишутся только в локальный лог
(`bridge.log`) в очищенном виде.

## Статусы задач

- `submitting` — сессия создаётся, prompt отправляется
- `pending` — prompt отправлен, выполняется
- `unknown` — неопределённый исход отправки/прерывания (слот удерживается,
  следующий submit блокируется)
- `completed` — OpenCode завершил успешно, результат доставлен целиком
- `partial` — OpenCode завершил успешно, но результат усечён по бюджету или
  один из вызовов инструмента завершился с ошибкой (цель не считается
  полностью достигнутой)
- `failed` — OpenCode завершил с ошибкой
- `cancelled` — прервано
- `blocked` — задача не запускалась, результата нет
- `error` — подтверждённый отказ до запуска (слот освобождён)

## Легковесный executor-агент (пример, не обязателен)

С мостом совместим **любой** агент OpenCode, пригодный как `primary`.
`executor-config.example.json` показывает, как можно завести
**ограниченный** агент `executor`: только чтение файлов, без записи, без
shell, без MCP и subagents (итоговое правило `deny`). Это отдельный,
опциональный сценарий.

Если такой ограниченный агент запущен (его правила заканчиваются запретом
всего), проверка готовности при старте определяет режим как `restricted`
(«deny-all, text-only») — агент пригоден как `primary`, но не может выполнять
shell/запись/MCP-инструменты.

**Это не рабочий агент по умолчанию.** Мост не требует ограниченного агента:
как и любой другой OpenCode-агент, executor может иметь полный набор
инструментов (запись файлов, shell, dev-инструменты, MCP-серверы). Проверка
готовности на **каждый** submit (`verifyExecutorReady`, без постоянного кеша)
подтверждает только существование агента и его способность быть `primary`;
фактический режим (`full` / `restricted`) пишется в лог при старте.

Каждая задача получает **отдельную сессию OpenCode**: контекст между задачами
не сохраняется. Защита от рекурсии: если в окружении появится MCP-сервер,
пробрасывающий инструменты самого моста (`submit_task`/`get_task_status`/
`get_task_result`/`cancel_task`), делегировать через них свою работу нельзя —
задачу нужно выполнять собственными инструментами.

## Автозапуск (systemd)

В репозитории есть systemd unit: `deploy/opencode-mcp-bridge.service`
(`Type=exec`, `Restart=on-failure`, `After=opencode.service` — только порядок
запуска, готовность API OpenCode unit не гарантирует). В unit указаны
примерные значения: `WorkingDirectory=/opt/opencode-mcp-bridge`, служебный
пользователь `opencode`, `HOME` и `PATH`; приведите их к вашей установке.

Установщик `deploy/install-autostart.sh` определяет каталог моста по своему
расположению и копирует unit как есть, поэтому отредактируйте `User`,
`WorkingDirectory`, `PATH` (и при необходимости `EnvironmentFile`) в unit
до запуска:

```bash
sudo bash deploy/install-autostart.sh
```

Скрипт требует root: ставит unit в `/etc/systemd/system`, выполняет
`systemctl daemon-reload` и `systemd-analyze verify`, останавливает вручную
запущенный `node src/main.js` из каталога моста (точное совпадение: владелец
`opencode`, cwd = каталог моста), проверяет, что порт свободен, затем включает
и запускает сервис. Если ручной процесс не остановился или порт занят —
прерывается, не запуская второй экземпляр. Прочитайте скрипт перед запуском.

Поиск ручного процесса рассчитан на владельца `opencode`; для другого
служебного пользователя отредактируйте проверку владельца в скрипте (без
совпадения скрипт просто не найдёт ручной мост и проверит занятость порта).

Окружение в unit задаётся через `Environment=` (`HOME`, `PATH` — добавьте
каталог CLI `opencode`, `NODE_NO_WARNINGS`). Дополнительные переменные
`BRIDGE_*` можно добавить в unit через `Environment=`/`EnvironmentFile=`;
`.env` unit сам не читает.

В шаблон добавлен обязательный `EnvironmentFile=/etc/opencode-mcp-bridge/bridge.env`.
До старта администратор должен создать этот файл (рекомендуемые права 0600)
с явным `BRIDGE_EXECUTOR_MODEL=apmix/deepseek-v4.1-flash-1017`, заменив пример
на доступную модель. В systemd-файле используйте строки `NAME=value`, без
`export`. Проверьте User, Group, WorkingDirectory и PATH под свою установку.

## Тесты

```bash
npm test                                    # только изолированные тесты
./run_tests.sh                              # тот же список
BRIDGE_SMOKE_TOKEN="$(cat .bearer_token)" npm run test:smoke # отдельно, против живого сервера
```

`npm test` и `run_tests.sh` запускают один явный список из восьми файлов:
`mock.test.js`, `http.test.js`, `api-compat.test.js`,
`executor-integration.test.js`, `hardening.test.js`,
`tool-error-diagnostics.test.js`, `sanitize-regression.test.js`,
`tool-diagnostics-unit.test.js`. Реальный `opencode`
не вызывается; HTTP-тесты могут открывать локальный порт. Smoke в этот список
не входит и может создать реальную задачу и изменить файлы. `test/smoke.js`
— ручная проверка против уже запущенного сервера: URL берётся из
`BRIDGE_SMOKE_URL` (по умолчанию `http://127.0.0.1:9999/mcp`), токен — из
первого аргумента, а при его отсутствии из `BRIDGE_SMOKE_TOKEN` (чтобы не
светить секрет в списке процессов). Она создаёт реальную задачу, вызывает
модель, опрашивает статус, проверяет результат и наличие вызовов инструментов;
токен не печатается.
Она ожидает файл `test/e2e-fixture.txt` относительно рабочей директории
executor-сессии (в репозиторий этот fixture не входит).

## Ограничения

- Мост запрашивает каталог сессии через `location.directory` из
  `BRIDGE_WORKDIR`, но не проверяет фактический каталог обратным чтением.
  CLI запускается с `cwd` процесса моста; это отдельно от каталога сессии.
  Запускайте мост из доверенного каталога.
- Совместимость с конкретными внешними MCP-клиентами не проверялась.
