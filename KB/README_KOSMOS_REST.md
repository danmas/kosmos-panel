# Kosmos Panel REST API

Этот документ описывает REST API эндпоинты, предоставляемые бэкендом Kosmos Panel. Эти эндпоинты используются веб-интерфейсом для управления и мониторинга серверов.

## Эндпоинты

### 1. Получить статусы серверов

- **Метод**: `GET`
- **Путь**: `/api/servers`
- **Описание**: Получает текущий статус всех настроенных серверов и их сервисов. Это основной эндпоинт, используемый панелью мониторинга для опроса обновлений.
- **Успешный ответ (200 OK)**:
  ```json
  {
    "ts": "2023-10-27T10:00:00.123Z",
    "servers": [
      {
        "id": "usa",
        "name": "USA Server",
        "env": "prod",
        "color": "green",
        "ssh": {
          "host": "usa",
          "port": 22,
          "user": "ubuntu",
          "credentialId": "cred-sample"
        },
        "services": [
          {
            "id": "usa-web",
            "name": "USA Web",
            "type": "http",
            "ok": true,
            "detail": "OK: 200"
          }
        ]
      }
    ]
  }
  ```
- **Пример**:
  ```bash
  curl http://localhost:3000/api/servers
  ```

### 2. Проверить SSH-соединение

- **Метод**: `GET`
- **Путь**: `/api/test-ssh`
- **Описание**: Выполняет быструю проверку SSH-соединения с указанным сервером для диагностики проблем с подключением и аутентификацией.
- **Параметры URL**:
  - `serverId` (string, обязательный): ID сервера для проверки (из `inventory.json`).
- **Успешный ответ (200 OK)**:
  ```json
  {
    "ok": true,
    "result": {
      "stdout": "__OK__"
    }
  }
  ```
- **Ответ с ошибкой (200 OK с `ok: false`)**:
  ```json
  {
    "ok": false,
    "error": "Authentication failed, please check your credentials."
  }
  ```
- **Пример**:
  ```bash
  curl "http://localhost:3000/api/test-ssh?serverId=usa"
  ```

### 3. Перезагрузить конфигурацию

- **Метод**: `POST`
- **Путь**: `/api/reload`
- **Описание**: Заставляет сервер немедленно перезагрузить конфигурационный файл `inventory.json`. Полезно после внесения изменений в файл вручную.
- **Успешный ответ (200 OK)**:
  ```json
  {
    "ok": true,
    "message": "Inventory reloaded"
  }
  ```
- **Ответ с ошибкой (500 Internal Server Error)**:
  ```json
  {
    "ok": false,
    "error": "Failed to read or parse inventory.json"
  }
  ```
- **Пример**:
  ```bash
  curl -X POST http://localhost:3000/api/reload
  ```

### 4. Получить конфигурацию Inventory

- **Метод**: `GET`
- **Путь**: `/inventory.json`
- **Описание**: Получает "сырой" файл `inventory.json`. Этот эндпоинт в основном используется редактором Inventory.
- **Успешный ответ (200 OK)**:
  - Содержимое файла `inventory.json`.
- **Ответы с ошибками**:
  - `404 Not Found`: Если файл `inventory.json` не существует.
  - `500 Internal Server Error`: Если произошла ошибка при чтении файла.
- **Пример**:
  ```bash
  curl http://localhost:3000/inventory.json
  ```

### 5. Обновить конфигурацию Inventory

- **Метод**: `POST`
- **Путь**: `/api/inventory`
- **Описание**: Сохраняет новую версию файла `inventory.json`. Сервер выполняет резервное копирование старого файла, проверяет новую конфигурацию, а затем сохраняет ее.
- **Тело запроса**: Полная JSON-структура нового `inventory.json`.
  ```json
  {
    "credentials": [...],
    "servers": [...],
    "poll": { ... }
  }
  ```
- **Успешный ответ (200 OK)**:
  ```json
  {
    "ok": true,
    "message": "Файл успешно сохранен"
  }
  ```
- **Ответы с ошибками**:
  - `400 Bad Request`: Если предоставленный JSON не прошел валидацию (например, отсутствуют поля, дублирующиеся ID). Тело ответа будет содержать подробное сообщение об ошибке.
    ```json
    { "ok": false, "error": "Validation Error: Duplicate server ID 'test-server'" }
    ```
  - `500 Internal Server Error`: Если произошла системная ошибка во время резервного копирования или записи файла.
- **Пример**:
  ```bash
  curl -X POST -H "Content-Type: application/json" --data @/path/to/new_inventory.json http://localhost:3000/api/inventory
  ```

### 6. Получить логи терминала

- **Метод**: `GET`
- **Путь**: `/api/logs`
- **Описание**: Получает все логи взаимодействий с терминалом из файла `terminal_log.json`.
- **Успешный ответ (200 OK)**:
  - JSON-массив, содержащий все записи логов.
  ```json
  [
    {
      "id": "ai-query-123",
      "sessionId": "session-456",
      "timestamp": "2025-08-25T08:35:50.762Z",
      "type": "ai_query",
      "user_ai_query": "показать диски",
      "serverId": "usa",
      "serverName": "USA Server",
      "serverHost": "192.168.1.100"
    }
  ]
  ```
- **Ответ с ошибкой (500 Internal Server Error)**: Если файл логов не может быть прочитан.
- **Пример**:
  ```bash
  curl http://localhost:3000/api/logs
  ```

### `GET /api/config`

Возвращает конфигурационные параметры для UI.

-   **Ответ:**
    -   `aiCommandPrefix` (string): Префикс для AI-команд в терминале.

## Terminal REST API (v1)

Этот API позволяет управлять SSH-сессиями и выполнять команды на удаленных серверах в неинтерактивном режиме.

### `POST /api/v1/terminal/sessions`

Создает новую SSH-сессию.

-   **Тело запроса:**
    -   `serverId` (string, required): ID сервера из `inventory.json`.
-   **Успешный ответ (201):**
    -   `sessionId` (string): Уникальный идентификатор созданной сессии.
-   **Пример:**
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"serverId": "my-server-1"}' http://localhost:3000/api/v1/terminal/sessions
    ```

### `POST /api/v1/terminal/sessions/:sessionId/exec`

Выполняет команду в рамках существующей сессии.

-   **Параметры URL:**
    -   `sessionId` (string, required): ID сессии, полученный при ее создании.
-   **Тело запроса:**
    -   `command` (string, required): Команда для выполнения.
    -   `timeout` (number, optional): Таймаут выполнения в миллисекундах. По умолчанию 30000 (30 секунд).
-   **Успешный ответ (200):**
    -   `exitCode` (number): Код завершения команды.
    -   `signal` (string, optional): Сигнал, которым был прерван процесс (если применимо).
    -   `stdout` (string): Стандартный вывод команды.
    -   `stderr` (string): Стандартный вывод ошибок.
-   **Пример:**
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"command": "ls -la"}' http://localhost:3000/api/v1/terminal/sessions/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/exec
    ```

### `DELETE /api/v1/terminal/sessions/:sessionId`

Закрывает SSH-сессию.

-   **Параметры URL:**
    -   `sessionId` (string, required): ID сессии для закрытия.
-   **Успешный ответ (200):**
    -   `message` (string): Сообщение об успешном закрытии.
-   **Пример:**
    ```bash
    curl -X DELETE http://localhost:3000/api/v1/terminal/sessions/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    ```
## Terminal REST API (v2)

Этот API идентичен `v1`, но предоставляет стандартизированный формат ответа JSON для всех эндпоинтов, что упрощает обработку на стороне клиента.

**Структура ответа:**

-   **Успех:**
    ```json
    {
      "success": true,
      "data": { ... }
    }
    ```
-   **Ошибка:**
    ```json
    {
      "success": false,
      "error": {
        "message": "Описание ошибки"
      }
    }
    ```

### `POST /api/v2/terminal/sessions`

Создает новую SSH-сессию.

-   **Тело запроса:** Аналогично `v1`.
-   **Успешный ответ (201):**
    -   `success`: `true`
    -   `data`: Объект, содержащий `sessionId`.
-   **Пример:**
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"serverId": "my-server-1"}' http://localhost:3000/api/v2/terminal/sessions
    ```
-   **Пример ответа:**
    ```json
    {
      "success": true,
      "data": {
        "sessionId": "9b6a8f8e-137e-46b9-8e62-6fe449aaee3a"
      }
    }
    ```

### `POST /api/v2/terminal/sessions/:sessionId/exec`

Выполняет команду в рамках существующей сессии.

-   **Тело запроса:** Аналогично `v1`.
-   **Успешный ответ (200):**
    -   `success`: `true`
    -   `data`: Объект, содержащий `exitCode`, `signal`, `stdout`, `stderr`.
-   **Пример:**
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"command": "ls -la"}' http://localhost:3000/api/v2/terminal/sessions/9b6a8f8e-137e-46b9-8e62-6fe449aaee3a/exec
    ```
-   **Пример ответа:**
    ```json
    {
      "success": true,
      "data": {
        "exitCode": 0,
        "stdout": "total 76\ndrwx------ 12 root root  4096 Aug 26 10:31 .\ndrwxr-xr-x 24 root root  4096 Aug 20 09:23 ..\n...",
        "stderr": ""
      }
    }
    ```

### `DELETE /api/v2/terminal/sessions/:sessionId`

Закрывает SSH-сессию.

-   **Успешный ответ (200):**
    -   `success`: `true`
    -   `data`: Объект, содержащий сообщение об успешном закрытии.
-   **Пример:**
    ```bash
    curl -X DELETE http://localhost:3000/api/v2/terminal/sessions/9b6a8f8e-137e-46b9-8e62-6fe449aaee3a
    ```
-   **Пример ответа:**
    ```json
    {
      "success": true,
      "data": {
        "message": "Session closed"
      }
    }
    ```

## WebSocket Terminal REST Bridge API

Этот API позволяет отправлять команды в **браузерные WebSocket терминалы** через REST. В отличие от Terminal REST API v1/v2, который создаёт отдельные SSH-сессии, этот API управляет терминалами, открытыми пользователем в браузере.

### Особенности

- **Интерактивность**: Пользователь видит выполняемые команды в реальном времени
- **Подтверждение**: Опциональное подтверждение команд пользователем перед выполнением
- **Sync/Async**: Поддержка синхронного (ожидание результата) и асинхронного режимов
- **Session ID**: Каждый браузерный терминал получает уникальный ID при подключении

### Получение Session ID

При открытии терминала в браузере (`/term.html`):
1. Session ID отображается в левом верхнем углу терминала
2. Session ID выводится серым текстом при подключении
3. Клик по индикатору копирует полный ID в буфер обмена

### `GET /api/ws-terminal/sessions`

Получает список всех активных браузерных терминалов.

-   **Успешный ответ (200):**
    ```json
    {
      "success": true,
      "data": [
        {
          "sessionId": "0ec45016-b1ae-4d88-94ee-979d8e3cb9de",
          "serverId": "id-server-usa",
          "serverName": "usa - Мой удаленный сервер",
          "connectedAt": "2025-12-05T07:10:09.000Z"
        }
      ]
    }
    ```
-   **Пример:**
    ```bash
    curl http://localhost:3000/api/ws-terminal/sessions
    ```

### `POST /api/ws-terminal/:sessionId/command`

Отправляет команду в браузерный терминал.

-   **Параметры URL:**
    -   `sessionId` (string, required): ID сессии из списка активных терминалов.
-   **Тело запроса:**
    -   `command` (string, required): Команда для выполнения.
    -   `requireConfirmation` (boolean, optional): Требовать подтверждение от пользователя. По умолчанию `false`.
    -   `wait` (boolean, optional): Ждать завершения команды. По умолчанию `false`.
    -   `timeout` (number, optional): Таймаут ожидания в мс. По умолчанию 60000. Максимум 300000 (5 минут).
-   **Успешный ответ (wait=false):**
    ```json
    {
      "success": true,
      "data": {
        "commandId": "a1b2c3d4-...",
        "status": "pending"
      }
    }
    ```
-   **Успешный ответ (wait=true):**
    ```json
    {
      "success": true,
      "data": {
        "commandId": "a1b2c3d4-...",
        "status": "completed",
        "stdout": "root\n",
        "stderr": "",
        "exitCode": 0
      }
    }
    ```
-   **Статусы команды:**
    -   `pending` - команда отправлена, ожидает выполнения
    -   `awaiting_confirmation` - ожидает подтверждения пользователя
    -   `executing` - выполняется
    -   `completed` - успешно завершена
    -   `rejected` - отклонена пользователем
    -   `timeout` - превышен таймаут
    -   `cancelled` - отменена через API

-   **Примеры:**
    ```bash
    # Async режим, без подтверждения (команда выполнится сразу)
    curl -X POST http://localhost:3000/api/ws-terminal/SESSION_ID/command \
      -H "Content-Type: application/json" \
      -d '{"command": "whoami", "wait": false}'

    # Sync режим, без подтверждения (ждём результат)
    curl -X POST http://localhost:3000/api/ws-terminal/SESSION_ID/command \
      -H "Content-Type: application/json" \
      -d '{"command": "ls -la", "wait": true, "timeout": 30000}'

    # С подтверждением пользователя
    curl -X POST http://localhost:3000/api/ws-terminal/SESSION_ID/command \
      -H "Content-Type: application/json" \
      -d '{"command": "rm -rf /tmp/test", "requireConfirmation": true, "wait": true}'
    ```

### `GET /api/ws-terminal/command/:commandId`

Получает статус и результат команды (для async режима).

-   **Параметры URL:**
    -   `commandId` (string, required): ID команды, полученный при отправке.
-   **Успешный ответ (200):**
    ```json
    {
      "success": true,
      "data": {
        "commandId": "a1b2c3d4-...",
        "sessionId": "0ec45016-...",
        "command": "whoami",
        "status": "completed",
        "result": {
          "stdout": "root\n",
          "stderr": "",
          "exitCode": 0
        },
        "createdAt": "2025-12-05T07:15:00.000Z"
      }
    }
    ```
-   **Ошибка (404):** Команда не найдена или истекла.
-   **Пример:**
    ```bash
    curl http://localhost:3000/api/ws-terminal/command/COMMAND_ID
    ```

### `DELETE /api/ws-terminal/command/:commandId`

Отменяет ожидающую команду.

-   **Параметры URL:**
    -   `commandId` (string, required): ID команды для отмены.
-   **Успешный ответ (200):**
    ```json
    {
      "success": true,
      "data": {
        "message": "Command cancelled"
      }
    }
    ```
-   **Пример:**
    ```bash
    curl -X DELETE http://localhost:3000/api/ws-terminal/command/COMMAND_ID
    ```

### Пример использования (PowerShell)

```powershell
# 1. Получить список сессий
$sessions = Invoke-RestMethod -Uri 'http://localhost:3000/api/ws-terminal/sessions'
$sessionId = $sessions.data[0].sessionId
Write-Host "Session ID: $sessionId"

# 2. Отправить команду и ждать результат
$body = @{
    command = "uname -a"
    wait = $true
} | ConvertTo-Json

$result = Invoke-RestMethod -Uri "http://localhost:3000/api/ws-terminal/$sessionId/command" `
    -Method Post -Body $body -ContentType 'application/json'

Write-Host "Output: $($result.data.stdout)"

# 3. Отправить команду с подтверждением
$body = @{
    command = "echo 'Hello from REST API'"
    requireConfirmation = $true
    wait = $true
    timeout = 120000
} | ConvertTo-Json

$result = Invoke-RestMethod -Uri "http://localhost:3000/api/ws-terminal/$sessionId/command" `
    -Method Post -Body $body -ContentType 'application/json'

if ($result.data.status -eq "rejected") {
    Write-Host "Команда отклонена пользователем"
} else {
    Write-Host "Output: $($result.data.stdout)"
}
```

### Визуализация в браузере

Когда команда приходит через REST API, в браузерном терминале отображается:

1. **Яркая плашка** `⚡ REST API COMMAND ⚡`
2. **Command ID** и текст команды
3. **Панель подтверждения** (если `requireConfirmation: true`):
   - Кнопка "Выполнить" - выполнить команду
   - Кнопка "Отклонить" - отказаться от выполнения
   - Кнопка "Выполнить без подтверждения" - выполнить и не спрашивать
