# Kosmos-model REST API

Полноценная документация по REST-интерфейсу приложения Kosmos-model. Описывает все маршруты, поддерживаемые провайдерами (GROQ, OpenRouter, Direct, GigaChat, Togeter), работу с промптами, историей ответов, RAG и файловыми операциями.

## Базовая информация

- Базовый URL (по умолчанию): `http://localhost:3002`
- Формат данных: `application/json` для всех запросов и ответов
- Аутентификация: на уровне внешних API (OpenRouter/GROQ). Сам REST-интерфейс не требует токена, но ожидает корректные ключи в `.env`.
- **OpenAI-совместимый API**: `/v1/chat/completions` и `/v1/models` (опциональная Bearer Token аутентификация)

## Quick Start

### Шаги
1. Поднимите сервер (`npm start`), убедитесь что `.env` содержит нужные ключи (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GIGACHAT_AUTH_DATA` и др.).
2. Выберите профиль модели (`CHEAP`, `FAST`, `RICH`) или конкретное имя из `/api/available-models`.

## OpenAI-совместимый API
Сервер поддерживает стандартный OpenAI Chat Completions API, что позволяет использовать его с OpenAI SDK, LangChain, LlamaIndex и другими клиентами.

### POST `/v1/chat/completions`

Полностью совместимый с OpenAI эндпоинт для chat completions.

**Запрос:**
```json
{
  "model": "llama-3.3-70b-versatile",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.7,
  "max_tokens": 1024
}
```

**Ответ:**
```json
{
  "id": "chatcmpl-abc123xyz",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "llama-3.3-70b-versatile",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello! How can I help?"},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 8,
    "total_tokens": 28
  }
}
```

**Параметры:**
- `model` — имя модели или алиас (`CHEAP`, `FAST`, `RICH`)
- `messages` — массив сообщений с `role` (system/user/assistant) и `content`
- `temperature` — температура генерации (0-2, по умолчанию 0.7)
- `max_tokens` — максимум токенов в ответе (по умолчанию 1024)
- `stream` — потоковый режим SSE (по умолчанию `false`)

**Важно про system prompt:**
- System message добавляется **только если явно передан** в `messages`
- Если system не передан — запрос идёт к провайдеру без system role
- Это важно для моделей, которые не поддерживают system role (например, некоторые Together модели)

### Streaming (SSE)

При `stream: true` ответ приходит в формате Server-Sent Events:

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}}]}
data: [DONE]
```

**Поддержка провайдеров:**
| Провайдер | Streaming |
|-----------|-----------|
| GROQ | ✅ Нативный |
| OpenRouter | ✅ Нативный |
| Direct/GigaChat | ✅ Эмуляция |

**Пример с OpenAI Python SDK (streaming):**
```python
stream = client.chat.completions.create(
    model="FAST",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### GET `/v1/models`

Возвращает список доступных моделей в формате OpenAI.

**Ответ:**
```json
{
  "object": "list",
  "data": [
    {"id": "llama-3.3-70b-versatile", "object": "model", "created": 1700000000, "owned_by": "groq"},
    {"id": "GigaChat-Max", "object": "model", "created": 1700000000, "owned_by": "gigachat"}
  ]
}
```

### Аутентификация

- Если `OPENAI_COMPAT_API_KEY` задан в `.env` — требуется заголовок `Authorization: Bearer <token>`
- Если не задан — доступ без аутентификации

### Пример с OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3903/v1",
    api_key="your-key"  # любая строка если аутентификация отключена
)

response = client.chat.completions.create(
    model="FAST",
    messages=[
        {"role": "system", "content": "Ты помощник"},
        {"role": "user", "content": "Привет!"}
    ]
)
print(response.choices[0].message.content)
```

### Пример с curl

```bash
curl -X POST http://localhost:3903/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -d '{"model":"FAST","messages":[{"role":"user","content":"Hello!"}]}'
```

## Предустановленные профили моделей

| Тип | Назначение | Как использовать |
| --- | ---------- | ---------------- |
| `CHEAP` | Бесплатные простые запросы | Укажите `model: "CHEAP"` или оставьте поле `model` пустым |
| `FAST`  | Молниеносные ответы от GROQ | Укажите `model: "FAST"` |
| `RICH`  | Максимальное качество и контекст | Укажите `model: "RICH"` |

Профили определяются через поле `user_type` в конфигурации моделей. Список текущих профилей можно получить через `GET /api/user-types`.

### Приоритет `user_type`

**Важно:** При указании `user_type` (включая `CHEAP`, `FAST`, `RICH` и произвольные метки) система **игнорирует** переданные параметры `model` и `provider` — они всегда берутся из найденной по `user_type` модели.

| Параметр | Приоритет при `user_type` |
|----------|---------------------------|
| `model` | ❌ Игнорируется, берётся из модели |
| `provider` | ❌ Игнорируется, берётся из модели |
| `temperature` | ✅ Приоритет от клиента |
| `maxTokens` / `max_tokens` | ✅ Приоритет от клиента |

Это позволяет внешним системам использовать абстрактные метки (`FAST`, `MY_CUSTOM_TYPE`) без знания конкретных моделей и провайдеров.

## Структура ошибок

```json
{
  "error": "Описание ошибки",
  "details": {
    "extra": "опциональные данные"
  }
}
```

При ошибках внешних API поле `data` может содержать полный ответ провайдера.

## 1. Работа с AI моделями

### POST `/api/send-request`

Отправка запроса с произвольным промптом.

Параметры тела:
- `model` — полное имя модели или ключевые слова `CHEAP` / `FAST` / `RICH`. Пустое значение эквивалентно `CHEAP`.
- `prompt` *(обязателен)* — системный промпт.
- `inputText` *(обязателен)* — пользовательский запрос.
- `provider` *(опционально)* — `groq`, `openroute`, `direct` или `gigachat` для принудительного выбора.
- `useRag` *(boolean)* — добавить контекст из RAG.
- `contextCode` — код набора документов для RAG.
- `saveResponse` *(boolean, default=false)* — сохранить ответ в историю.

Пример (профиль FAST):

```bash
curl -X POST http://localhost:3002/api/send-request ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"FAST\",\"prompt\":\"Ты аналитик\",\"inputText\":\"Сводка за Q3\",\"saveResponse\":true}"
```

Успешный ответ возвращает:
- `success`
- `content` — текст модели
- `model`, `provider`
- `usage` — `prompt_tokens`, `completion_tokens`, `total_tokens`
- `rag` — информация об использованных документах (если применялся RAG)

### POST `/api/send-request-sys`

То же, но промпт выбирается по имени из хранилища промптов.

Тело: `model`, `prompt_name`, `inputText`, опционально `provider`, `saveResponse` (по умолчанию `true`). Поддержка ключевых слов моделей идентична базовому маршруту.

### POST `/analyze`

Альтернативный маршрут с тем же телом, что и `/api/send-request`, но ориентирован на сценарии анализа (включая RAG).

### GET `/api/available-models`

Возвращает массив строк с именами моделей, доступных для выбора в API (`showInApi: true`).

### GET `/api/all-models`

Возвращает массив объектов `ModelInfo` с полным набором метаданных: `name`, `visible_name`, `provider`, `context`, `fast`, `showInApi`, `use_in_ui`.

### POST `/api/models/update/:id`

Обновляет параметры существующей модели.
Тело: `{ enabled: boolean, ... }`

### POST `/api/models/add`

Добавляет новую модель в систему.
Тело: `{ id, name, provider, context, ... }`

### POST `/api/test-model`

Тестирует модель живым запросом ("Кто ты? Ответь в одном предложении на русском.").
Тело: `{ modelId }`.
Ответ: `{ success, result: { success, response_time_ms, sample_response, error_message, timestamp } }`.
Результат сохраняется в поле `last_test` модели.

**UI кнопки тестирования:**
| Кнопка | Эндпоинт | Описание |
|--------|----------|----------|
| **Test** | `/api/test-model` | Прямой тест через провайдера |
| **CURL** | `/v1/chat/completions` | Тест через OpenAI-совместимый API |
| **About** | `/api/about-model` | Самоописание модели |

Кнопка CURL также показывает готовую curl команду для копирования.

### POST `/api/about-model`

Запрашивает у модели самоописание.
Тело: `{ modelId }`.
Ответ: `{ success, about }` — текст от модели о себе.

### GET `/api/user-types`

Возвращает список уникальных `user_type` из моделей (CHEAP, FAST, RICH и др.).
Ответ: `{ success, count, types[], details[] }`.

## 2. Управление промптами

### GET `/api/prompts`
Список всех сохранённых промптов. Возвращает массив `{ name, text }`.
Есть упрощённый алиас `GET /api/available-prompts`, который отдаёт тот же список и используется UI для автодополнения.

### POST `/api/prompts`
Создаёт новый промпт. Тело: `{ name, text }`.

### PUT `/api/prompts/{name}`
Обновляет текст промпта. Тело: `{ text }`.

### DELETE `/api/prompts/{name}`
Удаляет промпт по имени.

Во всех случаях возвращается успех или ошибка 404 (если промпт не найден).

## 3. История ответов

### GET `/api/responses`

Поддерживает фильтры в query:
- `sortBy`, `sortOrder`
- `model`, `prompt`
- `dateFrom`, `dateTo` (ISO datetime)
- `limit`

Ответ — массив `ResponseRecord` с полями `id`, `timestamp`, `model`, `promptName`, `prompt`, `inputText`, `response`.

### POST `/api/responses`
Ручное сохранение записи. Тело: `{ model, promptName, prompt, inputText, response }`.

### DELETE `/api/responses/{id}`
Удаляет запись по идентификатору.

## 4. RAG (Retrieval-Augmented Generation)

- `GET /api/rag/context-codes` — список доступных кодов контекста.
- `GET /api/rag/documents` — массив `RagDocument` (id, filename, contextCode, source).
- `POST /api/rag/ask` — тело `{ question, contextCode?, showDetails? }`. Возвращает `RagResponse` с `answer` и массивом документов.
- `GET /api/rag/debug-info` — последняя информация о выполненном запросе с RAG (`ragEnabled`, `finalInputText`, `ragInfo`, `timestamp`).

## 5. Работа с файлами

### POST `/api/save-markdown`

Сохраняет Markdown-файл. Тело:
- `content` *(обязателен)* — markdown-текст
- `filename` *(опционально)* — имя файла
- `directory` *(опционально)* — путь сохранения

Ответ: `{ success, filePath, message }`.

### GET `/api/output-dir-info`

Возвращает информацию о директории вывода: `outputDir`, `exists`, `files[]` (имя, путь, размер).

## 6. Конфигурация и состояние сервера

- `GET /api/check-api-key` — проверяет доступность текущего API-ключа. Ответ `{ isAvailable, serviceProvider }`.
- `GET /api/config` — серверная конфигурация (`server`, `n8n`, маскированный `apiKey`, `logging`).
- `GET /server-info` — хостнейм, платформа, архитектура, версия Node, uptime, `baseUrl`, `port`, `appName`, `timestamp`.

## 7. Маршруты для статического UI

- `GET /` — перенаправляет на `/main`.
- `GET /main` — основной интерфейс (`main.html`).
- `GET /models.html` — страница со списком моделей.
- UI опирается на те же REST-эндпоинты, поэтому поведение описано выше.

## 8. Инструменты для Markdown

- `GET /api/markdown_files` — список `.md` файлов в корне проекта.
- `GET /show_md` — страница просмотра markdown (использует query `file`).
- `GET /get_md_content?file=README.md` — возвращает содержимое выбранного файла.
- `POST /api/save-markdown` / `GET /api/output-dir-info` — см. раздел «Работа с файлами».

## 9. Подсказки по интеграции

1. **Выбор модели** — сначала попробуйте ключевые слова `CHEAP/FAST/RICH`. Для кастомных моделей используйте имена из `/api/available-models`.
2. **RAG** — устанавливайте `useRag: true` и указывайте `contextCode`. В отладочных целях используйте `/api/rag/debug-info`.
3. **Сохранение истории** — передайте `saveResponse: true`, чтобы сервер автоматически добавил запись в `/api/responses`.
4. **Обновление профилей** — после `POST /api/default-models` значения синхронизируются в `props.env`, и UI начнёт использовать новую конфигурацию.
5. **OpenAI SDK / LangChain** — используйте `/v1/chat/completions` как `base_url` для полной совместимости. Поддерживаются алиасы моделей (`CHEAP/FAST/RICH`).

## 10. Конфигурация `.env`

```env
# Провайдеры
OPENROUTER_API_KEY=sk-or-v1-xxxxx
GROQ_API_KEY=gsk_xxxxx
ZAI_API_KEY=xxxxx
GIGACHAT_AUTH_DATA=base64_строка

# OpenAI-совместимый API (опционально)
# Если задан — требуется Bearer Token аутентификация
# Если пустой — доступ без аутентификации
OPENAI_COMPAT_API_KEY=your-secret-key
```

---

Файл актуален для спецификации `swagger.yaml` (версия 1.0.0). При добавлении новых маршрутов сначала обновляйте swagger, затем синхронизируйте README_REST.md.

