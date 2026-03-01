# Brothers Protocol — Сценарии и алгоритмы работы

> Версия 0.6.0 · CLI для безопасной передачи задач между AI-агентами

---

## Что это такое?

Лёгкий CLI для оркестрации AI-агентов. Главная идея: **один агент завершает работу → проверяет результат → выдаёт подписанный токен (Baton) → следующий агент стартует с доказательством, что предыдущий этап выполнен, протестирован и артефакты существуют.**

Без Brothers Protocol агенты начинают задачи не зная, реально ли выполнены зависимости. С ним — Relay Baton это гарантия: "всё до тебя сделано, проверено, файлы существуют."

---

## Сценарий 1 — Разработчик с ручным AI

**Кто:** Разработчик, который вставляет промпты в ChatGPT/Claude вручную.

**Проблема:** Теряет контекст между сессиями. Забывает что было сделано, какие файлы изменились, что дальше.

**Решение:**

```bash
brothers init мой-проект
brothers ai setup --provider manual
brothers task "Сделать эндпоинт авторизации" --priority high --files "src/auth.ts,tests/auth.test.ts"
brothers start TASK-001
# → генерирует структурированный промпт, сохраняет в coordination/prompts/TASK-001-prompt.txt
# → копируешь в Claude/ChatGPT
# ... делаешь работу ...
brothers report TASK-001 \
  --done "JWT middleware;эндпоинт login;refresh token" \
  --files "src/auth.ts,tests/auth.test.ts" \
  --tests "PASS 12/12" \
  --next "Добавить rate limiting;Написать API-документацию"
brothers status
# → COMPLETED: 1, Reports: 1
brothers next --create 1
# → автоматически создаёт TASK-002: Добавить rate limiting
```

**Алгоритм:**
```
init   → создаёт coordination/ с tasks/, reports/, batons/, templates/
task   → TASK-XXX.md со статусом CREATED (атомарный захват файла, нет race condition)
start  → собирает промпт из: AI_RULES + CONVENTIONS + задача + последние 3 репорта
         → удаляет секреты (API-ключи, токены) из промпта
         → сохраняет в prompts/TASK-001-prompt.txt
         → ставит статус: IN_PROGRESS
report → создаёт REPORT-XXX.md со структурированными секциями
         → ставит статус задачи: COMPLETED
next   → парсит NEXT STEPS из последнего репорта → предлагает или авто-создаёт задачу
```

---

## Сценарий 2 — Два AI-агента последовательно (цепочка зависимостей)

**Кто:** Разработчик оркестрирует Claude (архитектор) → GPT (разработчик).

**Проблема:** GPT начинает имплементацию до того, как Claude реально закончил дизайн. Результат: потраченные токены и сломанный код.

**Решение: Relay Baton**

```bash
# Агент А: Claude проектирует архитектуру
brothers task "Спроектировать схему API" --assignee claude
brothers start TASK-001 --auto --ai anthropic --model claude-sonnet-4-6
# Claude завершает, авто-репорт создан

# Перед стартом агента Б — проверяем результат агента А
brothers relay-check TASK-002  # TASK-002 зависит от TASK-001
# → проверяет: статус TASK-001 = COMPLETED
# → проверяет: REPORT-001 существует со всеми обязательными секциями
# → проверяет: все файлы из FILES CHANGED существуют на диске
# → проверяет: секция TESTS не говорит "not run"
# → выдаёт BATON-001.json

# Агент Б: GPT имплементирует
brothers start TASK-002 --auto --ai openai --model gpt-4o --with-baton BATON-001
# → проверяет baton совпадает с зависимостями задачи
# → проверяет baton не просрочен (TTL по умолчанию: 72 часа)
# → продолжает только если все проверки прошли
```

**Алгоритм relay-check:**
```
для каждой зависимости TASK-002:
  1. файл зависимости существует?               → ошибка если нет
  2. статус зависимости = COMPLETED?            → ошибка если нет
  3. репорт для зависимости существует?         → ошибка если нет
  4. репорт содержит все 5 секций?              → ошибка если нет
     (WORK DONE, FILES CHANGED, TESTS, RESULT, NEXT STEPS)
  5. все файлы из FILES CHANGED существуют?     → ошибка если нет
  6. TESTS ≠ "not run / not executed"?          → предупреждение (--strict → ошибка)
  7. проверка циклических зависимостей (DFS)?  → ошибка если цикл найден

если всё прошло:
  → записывает BATON-XXX.json с expiresAt = сейчас + 72ч
  → возвращает batonId
```

**Алгоритм start --with-baton:**
```
1. загружает baton из coordination/batons/BATON-XXX.json
2. baton.passed = true?                          → ошибка если нет
3. baton.expiresAt > сейчас?                     → ошибка если истёк (перезапусти relay-check)
4. baton.toTask = текущий taskId?                → ошибка если не совпадает
5. зависимости baton совпадают с задачей?        → ошибка если не совпадают
→ продолжает выполнение задачи
```

---

## Сценарий 3 — CI/CD пайплайн (полная автоматизация)

**Кто:** Команда запускает автоматизированный AI-пайплайн на каждый PR.

**Проблема:** Нужны автоматические проверки качества между стадиями.

**Решение:**

```yaml
# .github/workflows/ai-pipeline.yml

- name: Стадия дизайна
  run: |
    brothers start TASK-001 --auto --ai anthropic \
      --model claude-sonnet-4-6 --sanitize on

- name: Шлюз качества (relay gate)
  run: |
    brothers relay-check TASK-002 --strict --json > baton.json
    cat baton.json | jq '.passed' | grep true  # падает CI если false

- name: Стадия имплементации
  run: |
    BATON_ID=$(cat baton.json | jq -r '.batonId')
    brothers start TASK-002 --auto --ai openai \
      --model gpt-4o --with-baton $BATON_ID
```

**Алгоритм strict-режима:**
```
relay-check TASK-002 --strict --json:
  → все стандартные проверки (как в Сценарии 2)
  → дополнительно: предупреждения → ошибки (например "тесты не запускались" блокирует CI)
  → вывод только JSON в stdout (без декоративного текста)
  → exit code 1 при ошибке (CI-дружелюбно)
```

---

## Сценарий 4 — Повтор при сбое AI

**Кто:** Любой пользователь с реальными AI API (rate limits, таймауты, ошибки сервера).

**Проблема:** API-вызов падает в середине пайплайна. Весь прогон провален.

**Решение:**

```bash
brothers ai setup --provider openai --model gpt-4o --retries 3 --retry-delay-ms 1000
brothers start TASK-001 --auto
# → попытка 1 падает (429 rate limit)  → ждём 1000мс
# → попытка 2 падает (503 таймаут)     → ждём 2000мс
# → попытка 3 успешна                  → репорт создан
```

**Алгоритм — экспоненциальный backoff:**
```
retries = 3, delay = 1000мс

попытка 1: вызов API → ошибка → sleep(1000мс × 1)
попытка 2: вызов API → ошибка → sleep(1000мс × 2)
попытка 3: вызов API → успех  → парсим ответ → создаём репорт

если все попытки провалились → бросаем ошибку с последним сообщением
```

---

## Сценарий 5 — Защита секретов

**Кто:** Разработчик, у которого в деталях задач есть пароли БД, API-ключи, токены.

**Проблема:** Вставляешь промпт в Claude → случайно утекают sk-xxx ключи в контекст.

**Решение:**

```bash
brothers ai setup --sanitize on  # по умолчанию: включено

brothers task "Обновить платёжный сервис" \
  --details "Ключ Stripe: sk-live-abc123, БД: postgres://admin:secret@prod/db"

brothers prompt TASK-001 --sanitize-preview
# → RAW: "Ключ Stripe: sk-live-abc123..."
# → SANITIZED: "Ключ Stripe: [REDACTED_API_KEY]..."

brothers start TASK-001  # отправляет очищенный промпт в AI
```

**Алгоритм — паттерны очистки:**
```
Обнаруживает и заменяет:
  sk-[A-Za-z0-9]{20,}       → [REDACTED_API_KEY]
  ghp_[A-Za-z0-9]{36}       → [REDACTED_GITHUB_TOKEN]
  AKIA[A-Z0-9]{16}           → [REDACTED_AWS_KEY]
  AIza[0-9A-Za-z-_]{20,}    → [REDACTED_GOOGLE_KEY]
  password: xxx              → [REDACTED_PASSWORD]
  token: xxx                 → [REDACTED_TOKEN]
  Authorization: Bearer xxx  → [REDACTED_BEARER]
```

---

## Сценарий 6 — Защита от циклических зависимостей

**Кто:** Любой пользователь, который случайно создал зависимость A→B→A.

**Проблема:** Без обнаружения relay-check уходит в бесконечный цикл.

**Решение:**

```bash
brothers task "Фича А"
brothers task "Фича Б" --depends-on TASK-001
brothers link TASK-001 --depends-on TASK-002
# → ОШИБКА: Circular dependency detected: TASK-001 → TASK-002 → TASK-001
# → операция прервана, файлы не изменены
```

**Алгоритм — обход в глубину (DFS):**
```
detectCycles(startId, tasksDir, visited=Set(), recStack=[]):

  если startId в recStack:
    вернуть recStack[от первого вхождения..] + [startId]  ← путь цикла

  если startId в visited:
    вернуть null  ← уже исследован, безопасно

  visited.add(startId)
  deps = parseDependencies(tasksDir/startId.md)

  для каждого dep в deps:
    cycle = detectCycles(dep, tasksDir, visited, recStack + [startId])
    если cycle: вернуть cycle

  вернуть null  ← цикла нет

Вызывается в:
  - createTask()    — при создании задачи с зависимостями
  - link команда    — перед записью обновлённых зависимостей
  - relay-check()   — как страховка от ручных правок
```

---

## Схема потока данных

```
brothers init
    │
    └── coordination/
        ├── tasks/       TASK-XXX.md   (статус: CREATED → IN_PROGRESS → COMPLETED)
        ├── reports/     REPORT-XXX.md (WORK DONE, FILES CHANGED, TESTS, RESULT, NEXT STEPS)
        ├── batons/      BATON-XXX.json (доказательство выполнения зависимостей, TTL 72ч)
        ├── prompts/     TASK-XXX-prompt.txt, TASK-XXX-response.txt
        └── templates/   task.md, report.md


brothers task ──────────────────────────────→ TASK-XXX.md [CREATED]
brothers start ─────────────────────────────→ TASK-XXX.md [IN_PROGRESS]
                                              prompts/TASK-XXX-prompt.txt
brothers report ────────────────────────────→ TASK-XXX.md [COMPLETED]
                                              REPORT-XXX.md
brothers relay-check ───────────────────────→ BATON-XXX.json [TTL 72ч]
brothers start --with-baton ────────────────→ проверяет baton → продолжает
```

---

## Форматы файлов

### TASK-XXX.md
```markdown
# TASK-001: Название задачи

## Description
## Created
## Assignee
## Priority
## Dependencies
- TASK-000 (или None)
## Done Criteria
## Files
## Status
*Status: CREATED*
```

### REPORT-XXX.md
```markdown
# REPORT-001: Название задачи

## DATE
## EXECUTOR
## STATUS
## TASK
TASK-001
## WORK DONE
- ✅ Выполненный пункт
## FILES CHANGED
- src/file.ts
## TESTS
PASS 5/5
## RESULT
Итоговая сводка
## NEXT STEPS
- [ ] Следующий шаг
```

### BATON-XXX.json
```json
{
  "id": "BATON-001",
  "createdAt": "2026-03-01 14:00:00",
  "expiresAt": "2026-03-04 14:00:00",
  "toTask": "TASK-002",
  "dependencies": [
    {
      "taskId": "TASK-001",
      "reportId": "REPORT-001",
      "artifactsChecked": ["src/auth.ts"],
      "warnings": []
    }
  ],
  "checks": ["dependencies_completed", "reports_exist", "report_sections_valid", "artifacts_exist"],
  "passed": true
}
```

---

## Справочник команд (v0.6.0)

| Команда | Описание |
|---------|----------|
| `brothers init [name]` | Инициализация проекта |
| `brothers ai setup` | Настройка AI-провайдера |
| `brothers ai test [--live]` | Проверка подключения к AI |
| `brothers task <title>` | Создать задачу |
| `brothers link <id> --depends-on` | Добавить зависимости (с защитой от циклов) |
| `brothers start <id> [--auto] [--dry-run]` | Запустить задачу, опционально вызвать AI |
| `brothers prompt <id> [--save]` | Предпросмотр промпта без старта |
| `brothers report <id>` | Создать репорт задачи |
| `brothers relay-check <id> [--strict] [--json]` | Проверить зависимости, выдать baton |
| `brothers baton-info <id> [--json]` | Информация о baton (показывает TTL) |
| `brothers status` | Обзор проекта |
| `brothers next [--create N]` | Предложить или создать следующую задачу |
