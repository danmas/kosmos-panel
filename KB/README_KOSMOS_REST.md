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