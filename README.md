# OpenCode MCP Bridge

Локальный MCP-сервер (Streamable HTTP) для делегирования задач в OpenCode.
Реализован на Node.js (`>=22.5`, нужен встроенный `node:sqlite`) с
официальным SDK `@modelcontextprotocol/sdk` (v1.32.x). Слушает только
loopback-адрес и вызывает `opencode api` через subprocess (без shell).

```
MCP-клиент → этот сервер (127.0.0.1:9999, Bearer-токен)
           → subprocess `opencode api ...` → агент/сессия OpenCode
```

> Статус: сервер и его конфигурация описаны по фактическому коду. В рамках
> подготовки публикационной копии код не устанавливался, не собирался и не
> запускался; совместимость с конкретными внешними MCP-клиентами
> (Perplexity и др.) не проверялась.

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
- `src/main.js` — точка входа
- `test/mock.test.js` — изолированные mock-тесты (FakeApi, временная БД,
  реальный `opencode` не вызывается)
- `test/http.test.js` — тест HTTP/MCP жизненного цикла в процессе, реальный
  `opencode` не вызывается
- `test/smoke.js` — ручная end-to-end проверка против **запущенного** сервера
- `executor-config.example.json` — **пример** конфигурации ограниченного
  executor-агента (не применён)
- `deploy/opencode-mcp-bridge.service` — systemd unit
- `deploy/install-autostart.sh` — установщик unit (только root)
- `run_tests.sh` — запуск mock- и http-тестов
- `.env.example` — список поддерживаемых переменных окружения (не загружается
  автоматически)

## Установка и запуск (разработка)

```bash
npm install
npm start            # слушает http://127.0.0.1:9999 (только loopback)
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
| `BRIDGE_EXECUTOR_MODEL` | `apmix/deepseek-v4.1-flash-1017` | модель `provider/model` |
| `BRIDGE_WORKDIR` | `<repo>` | `cwd` subprocess `opencode api` |
| `BRIDGE_OPENCODE_API_TIMEOUT_MS` | `30000` | таймаут одного вызова |
| `BRIDGE_TASK_EXECUTION_TIMEOUT_MS` | `300000` | таймаут задачи |
| `BRIDGE_WATCHDOG_INTERVAL_MS` | `3000` | период watchdog |
| `BRIDGE_MAX_PROMPT_LENGTH` | `10000` | макс. длина prompt |
| `BRIDGE_MAX_RESULT_LENGTH` | `50000` | макс. размер результата |
| `BRIDGE_MAX_REQUEST_BODY_SIZE` | `1048576` | макс. тело HTTP-запроса |
| `BRIDGE_MAX_SESSIONS` | `100` | макс. MCP-сессий |

Числовые значения `<= 0` или нечисловые заменяются дефолтом.

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
| `get_task_status` | `{ taskID }` | `{ taskID, status, outcome, cost, tokens }` |
| `get_task_result` | `{ taskID, cursor? }` | `{ taskID, result, toolCalls, outcome, hasMore, cursor, truncated, cost, tokens }` |
| `cancel_task` | `{ taskID }` | `{ taskID, cancelled, status }` |

Клиент не может передавать: agent/model, sessionID, произвольный API path,
shell-команды, путь проекта, permissions. Агент, модель и рабочая директория
задаются локально (`BRIDGE_EXECUTOR_AGENT`, `BRIDGE_EXECUTOR_MODEL`,
`BRIDGE_WORKDIR`). `inputSchema` описан для `tools/list`; аргументы
валидируются явно в коде.

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
(`Type=exec`, `User=opencode`, `WorkingDirectory=/home/opencode/projects/opencode-mcp-bridge`,
`Restart=on-failure`, `After=opencode.service` — только порядок запуска,
готовность API OpenCode unit не гарантирует).

Установка (по умолчанию `install-autostart.sh` рассчитан на каталог
`/home/opencode/projects/opencode-mcp-bridge`; при другом пути отредактируйте
`UNIT_SRC`/`BRIDGE_DIR` в скрипте и `WorkingDirectory`/`ExecStart` в unit):

```bash
sudo bash deploy/install-autostart.sh
```

Скрипт (только root): ставит unit в `/etc/systemd/system`, выполняет
`systemctl daemon-reload` и `systemd-analyze verify`, останавливает вручную
запущенный `node src/main.js` (точное совпадение: владелец `opencode`,
cwd = каталог моста), проверяет, что порт свободен, затем включает и
запускает сервис; отдельно (идемпотентно) включает автозапуск nginx. Если
ручной процесс не остановился или порт занят — прерывается, не запуская
второй экземпляр.

Окружение в unit задаётся через `Environment=` (`HOME`, `PATH` с каталогом
CLI `opencode`, `NODE_NO_WARNINGS`). Дополнительные переменные `BRIDGE_*`
можно добавить в unit через `Environment=`/`EnvironmentFile=`; `.env` unit
сам не читает.

## Тесты

```bash
./run_tests.sh                                # mock + http (node --test)
node test/smoke.js "$(cat .bearer_token)"     # вручную против запущенного сервера
```

`run_tests.sh` и `http.test.js` не вызывают реальный `opencode`. `test/smoke.js`
— ручная проверка против уже запущенного сервера на `127.0.0.1:9999`: отправляет
задачу, опрашивает статус, проверяет результат и наличие вызовов инструментов.
Она ожидает файл `test/e2e-fixture.txt` относительно рабочей директории
executor-сессии (в репозиторий этот fixture не входит).

## Ограничения

- Рабочая директория сессии OpenCode по умолчанию — каталог запуска OpenCode
  (глобальный корень), а не `BRIDGE_WORKDIR`: тело `POST /api/session` пустое,
  поэтому `cwd` subprocess не задаёт директорию сессии; executor использует
  абсолютные пути.
- Совместимость с конкретными внешними MCP-клиентами не проверялась.
