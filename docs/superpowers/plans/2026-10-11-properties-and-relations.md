# Properties and Relations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец вручную управляет аспектами, значениями и рёбрами существующей записи через доступную из любого шаблона панель «Свойства и связи», с сохранением черновика, атомарной записью и Undo.

**Architecture:** Панель — ленивый потребитель эффективного реестра и существующего графа. Управляемые редакторы отдают локальный черновик пяти типизированным командам; команды используют существующие tRPC/execute, общий механизм отмены и свежести. Хранение, бизнес-правила, вычисления и данные не дублируются; граница команд и общие контролы обеспечивают последующий перенос в формы и именованные действия среза 2.

**Tech Stack:** TypeScript, React 19, tRPC 11, TanStack Query 5, Radix Dialog, Zustand, Bun, Vitest/Testing Library, PostgreSQL/Drizzle. Новых зависимостей нет.

**Spec:** `docs/superpowers/specs/2026-10-10-properties-and-relations-design.md`, ревизия 2 от 2026-10-11. Читать вместе с этим планом.

## Global Constraints

Ниже — дословные требования спецификации; они действуют во всех задачах.

- «Нового хранения свойств, аспектов или связей нет.»
- «Работа интерфейса не требует вызова модели.»
- «Этот экран работает с **данными конкретной записи**.»
- «Одновременно активен один редактор: добавление аспекта, правка значений или создание связи.»
- «Открытие панели, выбор свойства или роли и переключение направления ничего не записывают.»
- «Ошибка не закрывает форму и не очищает ввод.»
- «Клиент не копирует серверные defaults и условные правила.»
- «Пустая строка, `false`, `0`, пустой массив и JSON `null` не приравниваются к отсутствию.»
- «Текущая запись исключена как второй конец **для всех ролей**: это отражение действующего запрета самосвязей, независимо от `acyclic`.»
- «Срез не расширяет `entity.updateBatch` до произвольного публичного исполнителя MCP-тулов.»
- «Панель не заводит собственный таймер опроса или второй постоянный кеш.»
- «Фикстуры создаются на тестовом стенде через штатный путь; личный граф владельца не используется для автоматических записей.»
- «Новая UI-функция не требует пересоздания графа, новой таблицы или пересева реестров.»
- «Выполненные спеки страниц не переписываются.»

## Review Focus

Пять пограничных классов имеют отдельные проверки в указанных задачах:

1. Сервер закоммитил мутацию, ответ потерялся: только сверка чтением, никакого автоматического повторения и выдуманного Undo (задача 6).
2. Последнее поле ещё в фокусе или содержит неполное число/дату: родитель знает сырой ввод; Save не теряет его и не превращает ошибку в очистку (задачи 3, 7).
3. Архивный/недоступный элемент старого ref-many и новая допустимая ссылка: старый элемент виден, весь патч отвергается без потери ввода; чужое название не раскрывается (задачи 1, 4, 7).
4. Смена записи/реестра и поздний ответ: старый черновик не попадает в новую запись, старый тип не применяется молча (задачи 5, 9).
5. Два свойства делят одно зеркало; две ручные роли и текстовый чип связывают ту же пару: источники не склеиваются и не удаляют друг друга (задачи 1, 8).

---

## 0. Проверенная база и решения до реализации

План написан по `154a5877688f55381776049038153b3c568fe0ed` (2026-10-11). Это документационные коммиты поверх `87a8729f`; скорость А и последующий план Б в этом checkout **ещё не реализованы**. Их описание в `docs/superpowers/plans/2026-09-30-speed-plan-a.md` и `docs/superpowers/specs/2026-09-29-speed-stages-0-1-design.md` не является свидетельством существования соответствующего API.

Подтверждённые опоры:

| Область | Сейчас | Следствие |
|---|---|---|
| Атомарность | `apps/server/src/executor/executor.ts:execute/executeBatch` выполняет запись, follow-ups, зеркала, пересчёты и journal внутри `withIdentity`; `apps/server/src/db/with-identity.ts` открывает настоящую `db.transaction`. Ошибка выходит из callback до преобразования в `{ok:false}` | Не добавлять savepoint или второй исполнитель. Проверить rollback настоящей БД и боевым journal sink |
| Пять команд | `entity.updateBatch` принимает `entity_update`; `relation.create/delete` вызывают `execute` с owner/ui | Составные значения+attach — одна операция. Серверная добавка — аддитивный `actionId` рёбер |
| Нет «пустого успешного удаления» | `prepareRelationDelete` отвергает отсутствующее ребро `NOT_FOUND`; успешные create/delete пишут журнал | Не изобретать no-op marker. Не возвращать id при replay без записи; тестировать текущие фактические ветки |
| Самосвязи | `prepareRelationCreate` проверяет все роли; БД содержит `rel_no_self` | Только регрессия, новый серверный запрет не нужен |
| Общее зеркало | `changedRefProps` собирает все отражаемые свойства при касании любого; `syncRefMirror` имеет две фазы и одну связь по source/target/ref | Не переписывать механизм; закрепить удаление одной из двух ссылок и Undo |
| Чтение detail | `detailGetInput(id)` в `features/entity-detail/useEntityDetail.ts` уже включает relations, body, bodyDoc, backlinks, thread | Панель подписывается на тот же ключ с общим staleTime; не делает `relation.listFor` и второй `entity.get` с иным include |
| Свежесть | `lib/invalidate.ts:invalidateGraph` гасит query/get/count/agenda/blocks/supply; `invalidateBudget` отдельно. resolveRefs и relation.listFor пока не входят | Расширить существующую инвалидацию на новых общих читателей; не заводить таймер |
| Undo | `features/page/useUpdateBatch.ts` вызывает `ai.undo`; ошибки превращаются в boolean+общий тост | Сохранить старый wrapper, выделить подробный исход для панели и общее уведомление об Undo |
| Контролы | `PropertyControl` для текста хранит локальную строку и отдаёт по blur; parseControlValue считает пустую строку unset | Добавить явный opt-in controlled draft; прежнее автосохранение сохранить |
| Ref | `RefField:refQueryAst(undefined, ...)` возвращает null; APP_NAV имеет специальный RefListControl | Исправить поиск только у действительного ref без target; общий список не наследует очистку архива из APP_NAV |
| Меню | `DetailMenu` ленивое; `DetailScreen` передаёт данные; чужая настройка — `view.kind:'configuring'`; `TemplatePreview` выбирает отдельный this | Лениво открывать панель из хоста, явно передавать id и preview-readonly |
| Навигация | `registerLeaveGuard` синхронный, блокирует Zustand-переходы и browser back | Использовать его без глобальной перестройки навигации: отказ открывает подтверждение; после discard пользователь повторяет внешний переход |
| Назначение | `AssignmentCard` согласованно пишет executor/grant/may_close+attach, но сама мутирует | Извлечь поля и сборку патча; в панели мутация только через общий адаптер |

Родительская концепция `docs/superpowers/specs/2026-09-11-pages-and-apps-concept.md`, §4.3/§5.3/§11/§13: доступ из хоста не зависит от карточек шаблона; формы и именованные действия принадлежат срезу 2. Их имена и схемы здесь не проектируются.

### Предусловие исполнения и защита чужой работы

- [ ] Снять `git rev-parse HEAD`, `git status --short`, `git log -8 --oneline` перед созданием изолированной ветки `codex/properties-and-relations`. Использовать managed worktree или существующий подходящий worktree; не переносить посторонние изменения и не сбрасывать основное дерево.
- [ ] Если база отличается, переснять **эти шесть контрактов**: тип ответа `relation.create/delete`; public Undo-процедура; detailed runner `useUpdateBatch`; механизм mutation freshness; `detailGetInput`; расположение журнала. Обновить этот раздел и команды тестов, прежде чем выполнять затронутую задачу. После скорости А не возвращать `chat_messages` как журнал; после Б не дублировать ленту глобальной ручной инвалидацией. Остальные задачи не блокировать ожиданием будущей скорости.
- [ ] Не включать исходные посторонние изменения `03-pending.md`, концепции страниц, market-scan-index, обзора pkm-five и `.codex/` в коммит. Задача 10 меняет pending **только в изолированном дереве**; перенос её двух точечных записей при интеграции сверяется с уже существующим содержимым.

### Порядок зависимостей

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10` — последовательное исполнение. Задачи 3/4 технически независимы от серверного DTO задачи 1, но общий последовательный порядок упрощает типы и ревью. Каждая задача заканчивается своим проверяемым результатом и отдельным коммитом. Текущий автономный цикл заканчивается **планом**, ни один из шагов реализации здесь ещё не выполнен.

### Карта новых файлов и ответственности

Пути далее относительны корню репозитория.

| Новый файл | Единственная ответственность |
|---|---|
| `packages/shared/src/registry/ref-metadata.ts` | Ключ и подпись зеркала из действующей декларации mirror_relation |
| `apps/server/src/routers/properties-relations.test.ts` | Живые API/execute/Undo/RLS сценарии панели |
| `apps/web/src/features/entity-detail/properties-relations/types.ts` | Пять команд, результат, контекст хоста |
| `apps/web/src/features/entity-detail/properties-relations/metadata.ts` | Строки аспектов/свойств, доступность, специальные маршруты |
| `apps/web/src/lib/registry/draft-value.ts` | Представление сырого ввода и его разбор |
| `apps/web/src/lib/registry/ScalarListControl.tsx` | Управляемый список text/number/decimal |
| `apps/web/src/lib/registry/RefManyControl.tsx` | Общий список ref, без политики APP_NAV |
| `apps/web/src/lib/entity-ref/useEntityOptions.ts` | Дебаунс, Q-AST целей, лимит, исключения |
| `apps/web/src/lib/entity-ref/useResolvedRefs.ts` | Пакетные названия и архивность по общим query keys |
| `apps/web/src/features/entity-detail/properties-relations/draft.ts` | Чистое состояние редактирования, конфликт и patch |
| `apps/web/src/lib/graph-command.ts` | Подтверждённый/отклонённый/неизвестный исход транспорта |
| `apps/web/src/lib/useGraphUndo.ts` | Подтверждённый actionId, тост и общая свежесть после Undo |
| `apps/web/src/features/entity-detail/properties-relations/useCommands.ts` | Привязка пяти команд к существующим API, сверка неизвестного исхода |
| `apps/web/src/features/entity-detail/properties-relations/AspectsTab.tsx` | Просмотр/выбор аспекта и его форма |
| `apps/web/src/features/entity-detail/properties-relations/PropertiesTab.tsx` | Полный словарь и многополевая форма |
| `apps/web/src/features/entity-detail/assignment-form.tsx` | Общие поля назначения и чистая сборка согласованного патча |
| `apps/web/src/features/entity-detail/properties-relations/RelationsTab.tsx` | Рёбра, направление, формы создания/снятия |
| `apps/web/src/features/entity-detail/properties-relations/PropertiesRelationsPanel.tsx` | Sheet, раздел, единственный редактор, guards, фокус |
| `apps/web/src/features/entity-detail/PropertiesRelationsSlot.tsx` | Лёгкая точка dynamic import по явному открытию |

Тестовые файлы перечислены в задачах рядом с владельцами кода. Не создавать параллельный реестр, таблицы, миграцию данных, endpoint произвольных операций или сохранение формы в props.

## Task 1: Закрепить серверный контракт записи, Undo и общего зеркала

**Files:**
- Modify: `apps/server/src/routers/relation.ts`
- Create: `apps/server/src/routers/properties-relations.test.ts`
- Modify tests: `apps/server/src/routers/entity-update-batch.test.ts`, `apps/server/src/registry/ref.test.ts`, `apps/server/src/executor/relations.test.ts`
- Create: `packages/shared/src/registry/ref-metadata.ts`, `packages/shared/src/registry/ref-metadata.test.ts`
- Modify: `packages/shared/src/registry/index.ts`, `apps/server/src/registry/ref.ts`, `apps/server/src/entity-read.ts`

**Interfaces:**
- Consumes: `execute(db, req, deps)`, `makeChatJournalSink()`, `mirrorRuleOf(reg)`, `ai.undo({actionId})` как в проверенной базе.
- Produces: `relation.create → WireRelation & {actionId?: string}`; `relation.delete → {ok:true; actionId?:string}`. Старые поля/ошибки сохраняются.
- Produces: `mirrorMetaKey(rules: readonly RuleDefinition[]): string | undefined`; `mirrorPropertyId(rules: readonly RuleDefinition[], meta: Readonly<Record<string, unknown>>): string | undefined` — листовой shared helper без импорта серверного реестра.

- [ ] **1.1. Добавить тесты через настоящий router caller.** В новом файле использовать `requireEnv`, `appDb`, `freshGraph`, `personal`, `truncateAll` из `apps/server/test/helpers.ts`, `createCallerFactory(appRouter)`. `beforeAll(truncateAll)` и `afterAll(client.end)` повторяют соседний `entity-update-batch.test.ts`; запускать только против выделенной локальной тестовой БД. Основной исполнимый тест:

```ts
test('ПС-18: delete с исходной тройкой возвращает реальный Undo', async () => {
  const graph = await freshGraph();
  const api = createCaller({ identity: personal(graph), actorKind: 'owner', db, clientVersion: null });
  const source = await api.entity.create({ input: { title: 'Проект', tags: [] }, source: 'ui' });
  const target = await api.entity.create({ input: { title: 'Задача', tags: [] }, source: 'ui' });
  const key = { source_id: source.id, target_id: target.id, role: 'subitem' };
  const made = await api.relation.create(key);
  expect(made.actionId).toEqual(expect.any(String));
  const removed = await api.relation.delete(key);
  expect(removed.actionId).toEqual(expect.any(String));
  await api.ai.undo({ actionId: removed.actionId! });
  const got = await api.entity.get({ id: target.id, include: ['relations'] });
  expect(got.relations?.filter(r => r.sourceId === source.id && r.role === 'subitem')).toHaveLength(1);
  await expect(api.relation.create(key)).rejects.toThrow();
  await api.relation.delete(key);
  await expect(api.relation.delete(key)).rejects.toThrow('связь не найдена');
});
```

Для пользовательских свойств/аспектов в том же test file добавить конкретную fixture-функцию (возвращаемые id читать из результата операции):

```ts
async function customFields(api: ReturnType<typeof createCaller>) {
  const raw = await api.registry.createProperty({
    key:'user/shared_title',label:{ru:'Общий текст'},description:{ru:'Общее поле двух аспектов'},
    type:{kind:'text'},status:'active',
  });
  const propertyId = (raw as {property:string}).property;
  await api.registry.createAspect({
    key:'user/first',label:{ru:'Первый'},description:{ru:'Первый носитель'},
    properties:[{propertyId,required:true}],
  });
  await api.registry.createAspect({
    key:'user/second',label:{ru:'Второй'},description:{ru:'Второй носитель'},
    properties:[{propertyId,required:false}],
  });
  const reg = await api.registry.effective();
  const first = reg.aspects.find(a => a.key === 'user/first')!;
  const second = reg.aspects.find(a => a.key === 'user/second')!;
  return {propertyId,first:first.id,second:second.id};
}
```

Required-тест: attach first без property → rejection и прежние данные; attach с `{[propertyId]:'готово'}` → один action, Undo возвращает отсутствие аспекта и значения. У task required/default тест отличается: незатронутый task_status не отправляется и сервер сам применяет `RULE_TASK_STATUS_DEFAULT`; ожидаемое значение тест читает из `params.value.const` этой встроенной default rule после проверки `template === 'default'`, не из собственного fallback.

- [ ] **1.2. Прогнать красный тест.** `cd apps/server && bun test src/routers/properties-relations.test.ts`; ожидаем отсутствие actionId. Следующие существующие механизмы могут быть зелёными сразу — их не надо ломать ради TDD.
- [ ] **1.3. Добавить поля ответа, не меняя исполнитель.** В `relation.ts` аннотировать возвращаемые типы и добавить:

```ts
const relation = r.results[0] as WireRelation;
return r.idempotentReplay ? relation : { ...relation, actionId: r.actionId };
// delete, после успешного execute:
return r.idempotentReplay ? { ok: true as const } : { ok: true as const, actionId: r.actionId };
```

В этом checkout успешная relation-операция не имеет no-op ветки: duplicate create и missing delete — ошибки. Не делать запрос наличия action после каждой мутации; реальный sink и проверка Undo доказывают соответствие. Если на новой базе появится no-op receipt, использовать его фактический признак записи.

- [ ] **1.4. Закрепить атомарность и правила с настоящими фикстурами.** В существующие файлы с готовыми registry/role fixtures добавить эти именованные тесты. Пользовательские свойства и аспекты создавать через `caller.registry.createProperty/createAspect`; концы и рёбра — через entity/relation API. Пользовательская роль для тестового ограничения создаётся существующим `seedCustomRole` из test/helpers.ts: публичного создания роли пока нет, это разрешённый seed только реестровой фикстуры изолированной тестовой БД, а не пользовательская операция. Продуктовую функцию создания ролей не добавлять:

| Имя теста | Действия и точные утверждения |
|---|---|
| `ПС-03/04: attach и поля одной операцией` | Создать заметку с body `Текст остаётся`; одним updateBatch attach task + срок. После чтения id/body прежние, task есть, task_status совпадает с серверным результатом; Undo возвращает исходные aspects/props. Вторая попытка с неверным due_date `2026-13-40` отвергнута; entity, relations и число journal actions равны снимку до вызова |
| `ПС-04: rollback после apply` | В `ref.test.ts` вызвать execute c sink-обёрткой над `makeChatJournalSink`, чей write сначала вызывает настоящий sink.write, затем бросает `Error('journal failure')`. Патч attach+props+ref уже применён до sink. После rejection отдельным чтением проверить прежние entity/relations и отсутствие journal action. InMemoryJournalSink для доказательства rollback не использовать |
| `ПС-05/06: пользовательские общие и свободные поля` | Два пользовательских аспекта объявляют одно text property; attach обоих одним batch. Detach одного не удаляет значение; unset свободного поля не удаляет его registry definition и не меняет aspects |
| `ПС-11: полная валидация изменённого массива` | Два пользовательских ref-many значения с target task; заархивировать одну цель. Правка только text проходит. Патч с новым text и массивом `[oldArchived, validNew]` отвергнут целиком; text/list равны старым. Удалить явно oldArchived из массива — успех; Undo возвращает прежнее значение по внутреннему механизму |
| `ПС-16/27: отказы рёбер` | Прямые API: self для mention без acyclic, duplicate той же тройки, цикл dependency, неподходящая цель ticket, второй вход при role.target_max_incoming=1. Ни запись концов, ни список рёбер, ни journal не меняются. Другой graph не видит/не меняет концы; caller actorKind='agent' отвергается ownerOnlyProcedure |
| `ПС-17/19: зеркало одно и системное` | Через два пользовательских отражаемых ref свойства записать одну допустимую цель. Ровно один ref; после unset первого второе и ref остаются; Undo возвращает первое. Прямые relation.create/delete с ref и run отвергнуты именно FORBIDDEN/ROLE_SYSTEM_ONLY. Ref создать через значение свойства, run для delete подготовить штатной test seed-операцией execute с mechanism seed (как AS_SYSTEM в relations.test.ts), чтобы тест не зеленел из-за отсутствующего ребра |
| `ПС-20: два независимых источника` | Текст `[[entity:ID|Цель]]` плюс mention на тот же target: delete mention сохраняет body/body_refs; правка body, убирающая чип, сохраняет отдельное mention |

Измерять journal на этой базе тем же способом, что `auditTitle` в `entity-update-batch.test.ts`, отбирая action id/число в собственном freshGraph; на базе скорости заменить тестовым reader нового журнала. Для target_max использовать конкретную штатную test fixture:

```ts
await seedCustomRole(graph, {
  key:'user/one-parent',label:{ru:'Один родитель'},
  sourceLabel:{ru:'Родитель'},targetLabel:{ru:'Ребёнок'},
  constraints:{created_by:'any',target_max_incoming:1},
});
```

Для других отказов достаточно реальных builtin dependency/ticket/mention. Seed не является тестируемой записью: все утверждения о доступе, откате и журнале относятся к публичным mutation calls.

Проверка позднего rollback использует транзакционную обёртку, а не отдельно накопленный массив entries:

```ts
const realSink = makeChatJournalSink();
const failingSink: JournalSink = {
  findByAuditId: (tx,id) => realSink.findByAuditId(tx,id),
  write: async (tx,entry) => { await realSink.write(tx,entry); throw new Error('journal failure'); },
};
await expect(execute(db, {
  identity:personal(graph),actorKind:'owner',source:'ui',batchId:newId(),
  operations:[{tool:'entity_update',input:{id:source.id,
    aspects:{attach:[first]},props:{[propertyId]:'новое'}}}],
}, {sink:failingSink})).rejects.toThrow('journal failure');
```

`graph/source/first/propertyId` получены `freshGraph`, `entity.create`, `customFields` в том же тесте. Для зеркала в этот patch добавить ref property из registry.createProperty и допустимый target из entity.create; после отказа читать graph новым tx. До вызова сохранить полный snapshot и число actions, после сравнить оба.

- [ ] **1.5. Вынести чтение метки зеркала из декларации.** shared helper выбирает **ровно одну** включённую rule `template === 'mirror_relation'`; при 0/2 возвращает undefined для безопасного UI. `mirrorPropertyId` возвращает только непустую строку из meta[key]. Сервер продолжает строго проверять каталог `mirrorRuleOf`; его `params.meta_key` получает через helper из `[mirrorRuleOf(reg)]` и при undefined бросает ошибку конфигурации. SQL backlinks в `entity-read.ts` заменить с `meta->>'property'` на параметризованное `meta->>${metaKey}::text`, где metaKey получен из того же helper. Новая панель получает `rules` из определения роли effective registry. Тесты:

```ts
const mirror = ruleDefinitionSchema.parse(RULE_MIRROR_REF);
expect(mirrorMetaKey([mirror])).toBe('property');
expect(mirrorPropertyId([mirror], { property: 'user/owner' })).toBe('user/owner');
expect(mirrorPropertyId([mirror], { property: 1 })).toBeUndefined();
expect(mirrorMetaKey([])).toBeUndefined();
```

`RuleDefinition` строго парсится тестом через существующую `ruleDefinitionSchema` прежде вызова; типы не обходить `as any`. Существующий import review/merge не затрагивается: этот срез меняет writer и backlinks reader, которые читают тот же ключ, и добавляет UI-reader.

- [ ] **1.6. Проверить и закоммитить.** `cd apps/server && bun test src/routers/properties-relations.test.ts src/routers/entity-update-batch.test.ts src/executor/relations.test.ts src/registry/ref.test.ts`; `bun test packages/shared/src/registry/ref-metadata.test.ts` из корня. Ожидается PASS, включая живое Undo и rollback. `git add` только Files этой задачи; `git commit -m "feat: expose relation action ids and pin graph mutation guarantees"`.

## Task 2: Определить метаданные, права UI и границу пяти команд

**Files:**
- Create: `apps/web/src/features/entity-detail/properties-relations/types.ts`, `metadata.ts`, `metadata.test.ts`
- Modify: `apps/web/src/lib/registry/useRegistry.ts`, `useRegistry.test.tsx`
- Read: `apps/web/src/lib/registry/controls.ts`, `labels.ts`, `apps/web/src/features/settings/extension-mask.ts`, `packages/shared/src/registry/extensions.ts`

**Interfaces:**
- Consumes: `RouterInputs`, `RouterOutputs`, `EffectiveRegistry`, `writeModeOf`, `controlKindOf`, `isExtensionEnabled`.
- Produces: типы ниже и `propertyRows(entity, registry): PropertyRow[]`, `propertyAccess(def, context): FieldAccess`, `aspectAccess(def, context): AspectAccess`, `roleAccess(def, context): {canCreate:boolean; canDelete:boolean; reason?:string}`.

- [ ] **2.1. Написать тесты модели отображения.** Фикстура берёт реальные определения `BUILTIN_REGISTRY` из `apps/web/src/test/registry.ts`, затем два пользовательских аспекта с общим property. Проверить ровно одну строку общего id, два carrierIds, пустые объявленные поля, неизвестный сохранённый id, сохранённый free property, сортировку rank/id. Отдельная таблица: flags system_writable/model_writable/writer, module off, deprecated, unknown, unsupported json, proposed.

```ts
expect(propertyAccess(undefined, context)).toMatchObject({ canSet: false, canUnset: false });
expect(propertyAccess({ ...textDef, status: 'deprecated' }, context))
  .toMatchObject({ canSet: false, canUnset: true });
expect(propertyAccess({ ...textDef, flags: { system_writable: true } }, context))
  .toMatchObject({ canSet: false, canUnset: false });
expect(propertyAccess({ ...textDef, type: { kind: 'json' } }, context))
  .toMatchObject({ canSet: false, canUnset: true, editor: 'unavailable' });
```

В `metadata.test.ts` до тестов объявить реальные локальные значения:

```ts
const context = {readOnly:false,archived:false,disabledExtensions:[]} as const;
const textDef = {...BUILTIN_REGISTRY.properties.find(p => p.type.kind === 'text' && p.storage === 'props')!,
  id:'user/title',key:'user/title',status:'active' as const,mergedInto:null,module:null,flags:{}};
```


- [ ] **2.2. Прогнать красный тест.** `cd apps/web && bun run test src/features/entity-detail/properties-relations/metadata.test.ts`; ожидается отсутствующий модуль.
- [ ] **2.3. Реализовать типизированные границы.**

```ts
export type Entity = RouterOutputs['entity']['get']['entity'];
export type Relation = NonNullable<RouterOutputs['entity']['get']['relations']>[number];
export type ValuesPatch = { props?: Record<string, unknown>; unset?: string[] };
export type RelationKey = RouterInputs['relation']['delete'];
export type PanelCommand =
  | { kind: 'attach'; entityId: string; aspectId: string; patch: ValuesPatch }
  | { kind: 'detach'; entityId: string; aspectId: string }
  | { kind: 'values'; entityId: string; patch: ValuesPatch }
  | { kind: 'createRelation'; entityId: string; key: RelationKey }
  | { kind: 'deleteRelation'; entityId: string; key: RelationKey };
export type CommandOutcome =
  | { kind: 'confirmed'; actionId?: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; message: string };
export type RunPanelCommand = (command: PanelCommand) => Promise<CommandOutcome>;
export type FieldAccess = {
  canSet: boolean; canUnset: boolean;
  editor: 'generic' | 'assignment' | 'navigation' | 'unavailable';
  reason?: string;
};
export type PropertyRow = {
  id: string; def?: PropertyDefinition; value: unknown; present: boolean;
  carrierIds: string[]; rank: number;
};
```

`Context` определить как `{readOnly:boolean; archived:boolean; disabledExtensions: readonly ExtensionId[]}`; `AspectAccess` — `{canAttach:boolean; canDetach:boolean; route:'generic'|'assignment'|'page'|'app'|'readonly';reason?:string}`. Проверять mask/flags до типа: отсутствие контрола само по себе не запрещает unset, service/unknown/core/mask запрещают. Слитое определение определяется `def.mergedInto !== null` и не предлагается для новых значений; старое сохранённое поле показывается только для чтения с причиной и ссылкой на определение-преемник. Не вводить несуществующий status `merged`.

- [ ] **2.4. Реализовать список и специальные маршруты.** `propertyRows` объединяет `entity.props` и `properties[].propertyId` текущих аспектов, carries считать только по текущим аспектам. Выбор свободного property — все storage props, вне уже показанных строк; scope не вычислять. Для assignment направлять executor/grant/may_close/assignee к одной форме; для APP_NAV — к существующему контролу навигации. Page/app/supply/service не дают generic attach/detach. Общие пользовательские аспекты не попадают в список специальных id. Рутина остаётся серверной проверкой конкретного объекта, без обещания снять защищённую рутину.

- [ ] **2.5. Сделать отказ перечитывания реестра наблюдаемым.** У `RegistryView` добавить `refreshFailed:boolean`, `refreshing:boolean`, `versionStale:boolean`, `retry:()=>void` без изменения смысла старого `failed`. `refreshFailed=query.isError`, `refreshing=query.isFetching`, `versionStale=observedVersion !== undefined && data?.version !== observedVersion`; retry вызывает `query.refetch`. При known observedVersion !== data.version панель блокирует начало/сохранение новых изменений до завершения чтения, старые данные и raw показывает. При rejected refetch с существующим data тоже блокирует изменения и предлагает retry. Добавить `useRegistry.test.tsx`: cached registry+новая версия+отказ сети оставляют старые labels, выставляют refreshFailed и не запускают бесконечный refetch; явный retry получает новый snapshot.
- [ ] **2.6. Прогнать тесты и commit.** Проверить также proposed (метка, без активации), deprecated с readonly flags (очистка запрещена), unsupported с действующим разрешением очистки. `git commit -m "feat: model properties panel metadata and command boundary"` после адресного `git add`.

### Общая web-фикстура значений для задач 3–8

Создать `apps/web/src/features/entity-detail/properties-relations/test-fixtures.ts` как часть задачи 3; это **тестовый** модуль, продукт его не импортирует. Он устраняет неоговорённые `textDef/context/entity` в примерах следующих задач:

```ts
import type { PropertyDefinition, PropertyType } from '@orbis/shared';
import type { Entity } from './types';
import { BUILTIN_REGISTRY } from '../../../test/registry';
import { wireEntity } from '../../../test/harness';
export const context = {readOnly:false,archived:false,disabledExtensions:[]} as const;
export function field(type: PropertyType, id='user/title'): PropertyDefinition {
  const base = BUILTIN_REGISTRY.properties.find(p => p.type.kind === 'text' && p.storage === 'props')!;
  return {...base,id,key:id,graphId:null,label:{ru:id},description:{ru:'Поле теста'},type,
    status:'active',storage:'props',scope:null,mergedInto:null,module:null,rank:100,flags:{},rules:[]};
}
export const textDef = field({kind:'text'});
export const numberDef = field({kind:'number'});
export const decimalDef = field({kind:'decimal'});
export const timestampDef = field({kind:'timestamp'});
export const textManyDef = field({kind:'text',cardinality:'many'});
export const entity: Entity = wireEntity({
  id:'00000000-0000-4000-8000-000000000010',title:'Заметка',body:'Текст остаётся',
  tags:[],props:{'user/title':'Было'},aspects:[],archived:false,
  createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z',
});
export const registry = {...BUILTIN_REGISTRY,properties:[...BUILTIN_REGISTRY.properties,textDef]};
```

Существующий `wireEntity` добавляет graphId, emoji, bodyRefs и queryRefs. Это та же фикстура, которой пользуется structure-fixtures.ts, без приведения неполного object к Entity. Тесты изменяют фактические fields через spread и handlers.

## Task 3: Управляемый сырой ввод и списки скаляров

**Files:**
- Create: `apps/web/src/features/entity-detail/properties-relations/test-fixtures.ts`
- Create: `apps/web/src/lib/registry/draft-value.ts`, `draft-value.test.ts`, `ScalarListControl.tsx`, `ScalarListControl.test.tsx`
- Modify: `apps/web/src/lib/registry/PropertyControl.tsx`, `PropertyControl.test.tsx`, `controls.ts`

**Interfaces:**
- Produces: `DraftValue = {kind:'value'; value:unknown} | {kind:'raw';raw:string} | {kind:'list';items:readonly string[]} | {kind:'unset'}`.
- Produces: `parseDraftValue(def:PropertyDefinition, draft:DraftValue): {ok:true; value:unknown}|{ok:true;unset:true}|{ok:false;message:string}`.
- Produces: optional `PropertyControl` prop `draft?: {state: DraftValue; onChange:(next:DraftValue)=>void}`; legacy `value/onChange` остаются обязательными для обратной совместимости. В draft mode legacy onChange не вызывается.

- [ ] **3.1. Написать тест последнего фокуса и пустых значений.** В wrapper держать draft в useState, Save выводит результат parser; user.type без blur, pointerDown Save должен видеть последнюю строку. Табличные тесты проверяют `''` text, `false`, `0`, `[]`, JSON null readonly, explicit unset. `parseDraftValue` не обрезает пробелы у текста; число/decimal могут trim для разбора.

```ts
expect(parseDraftValue(textDef, {kind:'raw',raw:''})).toEqual({ok:true,value:''});
expect(parseDraftValue(numberDef, {kind:'raw',raw:'1e'}).ok).toBe(false);
expect(parseDraftValue(numberDef, {kind:'raw',raw:''}).ok).toBe(false);
expect(parseDraftValue(decimalDef, {kind:'raw',raw:'12345678901234567890,1234'}))
  .toEqual({ok:true,value:'12345678901234567890.1234'});
expect(parseDraftValue(textManyDef, {kind:'list',items:['Дом, работа','Второе']}))
  .toEqual({ok:true,value:['Дом, работа','Второе']});
expect(parseDraftValue(timestampDef, {kind:'raw',raw:'2026-10-11T13:05:00+07:00'}))
  .toEqual({ok:true,value:'2026-10-11T13:05:00+07:00'});
```

Фикстуры — копии реального text definition с явно заданным `type`; все типы брать из shared.

- [ ] **3.2. Запустить тесты красными.** `cd apps/web && bun run test src/lib/registry/draft-value.test.ts src/lib/registry/ScalarListControl.test.tsx src/lib/registry/PropertyControl.test.tsx`.
- [ ] **3.3. Добавить чистый parser и opt-in режим.** Текстовые input в draft mode controlled `value=raw`, `onChange` немедленно сообщает raw. Дата — YYYY-MM-DD с проверкой существования дня через `hasValidCalendar`, time — HH:MM с границами 00–23/00–59, timestamp — полный ISO с зоной и `hasValidCalendar`; временную зону не менять через Date.toISOString. Для numeric raw использовать input type text/inputMode decimal, чтобы браузер не превращал неполное число в пустую строку. Decimal оставлять строкой. Клиент проверяет только читаемость, не required/min/max/conditional defaults. Invalid остаётся в state и отключает Save с объяснением. Explicit clear создаёт `{kind:'unset'}`. Исходный `parseControlValue`/blur-путь остальных карточек не менять.

```tsx
<input value={raw} onChange={e => draft.onChange({kind:'raw',raw:e.target.value})}
  aria-label={label} inputMode={kind === 'number' || kind === 'decimal' ? 'decimal' : undefined} />
```

- [ ] **3.4. Реализовать ScalarListControl.** Prop contract: `{def:PropertyDefinition; value:readonly string[]; onChange:(items:string[])=>void; disabled?:boolean}`. Каждая строка — отдельный input, add добавляет `''`, remove удаляет по индексу; не split(','). Родитель сохраняет raw list целиком, parser разбирает каждый элемент; числовая пустая строка — ошибка, text пустая строка — значение. Удаление последнего элемента даёт `[]`, очистка всего свойства — отдельный unset. `controlKindOf` расширить `text-list|number-list|decimal-list`, новые компоненты импортировать лениво, чтобы не попасть в первый кадр detail; generic draft формы используют их. Legacy-поведение других видов сохраняется.
- [ ] **3.5. Проверить регрессии и commit.** Все новые тесты и существующий `PropertyControl.test.tsx` зелёные; отдельно проверить legacy blur ещё отправляет ровно один onChange и текст не перепрыгивает при отказе родителя в draft mode. `git commit -m "feat: add controlled property drafts and scalar list editors"`.

## Task 4: Поиск целей, общие ref-many и пакетные названия

**Files:**
- Create: `apps/web/src/lib/entity-ref/useEntityOptions.ts`, `useEntityOptions.test.tsx`, `useResolvedRefs.ts`, `useResolvedRefs.test.tsx`
- Create: `apps/web/src/lib/registry/RefManyControl.tsx`, `RefManyControl.test.tsx`
- Modify: `apps/web/src/lib/entity-ref/RefField.tsx`, `RefField.test.tsx`, `apps/web/src/lib/registry/PropertyControl.tsx`, `controls.ts`
- Modify: `apps/web/src/features/entity-editor/nodes/RefTitlesContext.tsx` (переиспользование одного batch helper)

**Interfaces:**
- Consumes: `PropertyDefinition.type.target`, `QueryAst`, `bindingIndexOf` из shared, `ENTITY_RESOLVE_REFS_MAX`.
- Produces: `useEntityOptions({target,term,exclude,enabled,limit}: {target?:QueryAst|QueryAst[];term:string;exclude?:readonly string[];enabled:boolean;limit?:number})` с `{rows,isPending,isError,mayHaveMore,retry}`; default limit 20, delay 200 ms. target undefined означает все записи **только при enabled:true**.
- Produces: `contractTarget(registry:EffectiveRegistry, contractId:string): QueryAst | null` и `implementsContract(registry, aspects:readonly string[], contractId:string): boolean` — через существующий `bindingIndexOf`, без собственного исполнения Q/E. `RoleAccess` учитывает readOnly/archive/известность/created_by. Проверенный assertRoleConstraints не проверяет mask по module роли; не вводить новое ограничение на клиенте и не переносить маску аспектов концов на роли ядра. Пин: разрешённая роль ядра доступна при выключенном расширении аспекта конца.
- Produces: `useResolvedRefs(ids:readonly string[]) → {byId:ReadonlyMap<string,RefTitle>;pendingIds:ReadonlySet<string>;failedIds:ReadonlySet<string>;retry:()=>void}`.
- Produces: `RefManyControl({def,value,onChange,disabled})`, где value — readonly string[], onChange — один полный массив; запросы только при монтировании контрола.

- [ ] **4.1. Тестировать Q-AST и сетевой бюджет.** Реальный mockLink из `test/harness.tsx` записывает inputs. Ref without target делает enabled query с filter null; undefined definition и non-ref не делают запрос. Альтернативы target соединяются or, search добавляется and, исходное дерево не мутирует. Fake timers: первые 199 ms нет запроса нового term, на 200 ms один; старый ответ не подменяет актуальный ключ. 20 сырых результатов → «Возможно, есть ещё — уточните поиск», даже если исключения оставили 18. Ошибка и пустой список различаются.

```ts
expect(refQueryAst(undefined, 'проект', 20)).toEqual({
  filter: {search:'проект'}, sortBy:[{field:'orbis/title',dir:'asc'}], limit:20,
});
expect(contractTarget(registry, 'orbis/completable')?.filter)
  .toEqual({or: expectedImplementingAspects.map(aspect => ({aspect}))});
```

`expectedImplementingAspects` в fixture содержит ровно `['orbis/task','user/complete']`; registry fixture для этого теста содержит только эти два реализующих аспекта. Для контракта без реализаций `contractTarget` возвращает null: hook не запускает запрос и показывает «Нет подходящих типов записей». Этот sentinel не передавать как undefined, означающий «все».


- [ ] **4.2. Запустить красные тесты.** `cd apps/web && bun run test src/lib/entity-ref/useEntityOptions.test.tsx src/lib/entity-ref/useResolvedRefs.test.tsx src/lib/registry/RefManyControl.test.tsx`.
- [ ] **4.3. Собрать запрос штатным AST.** `refQueryAst` расширить третьим параметром limit с legacy default 200, при target undefined строить scope null. `useRefOptions` включать только при `def?.type.kind === 'ref'`, а не при наличии target. UI новой панели пользуется общим hook с limit20 и delay200. Передавать `trpc:{abortOnUnmount:true}` на запросы поиска, если это поддержано текущим клиентом; ключ содержит target+term+limit, поэтому старый ответ в любом случае остаётся под старым ключом. Серверный query по умолчанию исключает архив; не строить фильтр `{archived:false}`, которого нет в каноне. contractTarget берёт `bindingIndexOf({aspects:new Map(registry.aspects.map(a => [a.id,a])),contracts:new Map(registry.contracts.map(c => [c.id,c]))})` и OR его byContract().aspectId; это тот же индекс, которым сервер проверяет принадлежность, а не проверка values/classes на клиенте. Маска расширений не отбрасывает реализацию ядрового контракта сама собой.

- [ ] **4.4. Реализовать пакетные названия.** Уникальные ids лексикографически отсортировать для стабильного query key и разбить по `ENTITY_RESOLVE_REFS_MAX` (200); один вызов `trpc.useQueries(t => batches.map(ids => t.entity.resolveRefs({ids},{staleTime:30_000})), {combine})`, без N `entity.get`. Стабильный combine сохраняет равенство map между неизменившимися ответами, чтобы не регрессировал ввод тела существующего RefTitlesProvider. Вынести существующий батчинг из RefTitlesContext в этот hook и сохранить публичный provider. Отсутствующий id после успешной пачки — недоступен; пока pending/error, не объявлять его отсутствующим. Не удалять старое название при неуспешном refetch. Тест 401 id → 3 запроса максимум200; 51-е ребро не исчезает из данных; rejected в одной пачке не обнуляет другие.

- [ ] **4.5. Реализовать общий ref-many.** Все выбранные ids отображаются через resolver, включая архив/недоступные; порядок сохраняется, remove только явным нажатием. Новые доступные цели исключают выбранные ids. Достижение `def.type.max` запрещает add и объясняет предел; сервер остаётся окончательной проверкой. При отказе чтения существующее значение не меняется; при отказе сохранения значение+новые ссылки остаются. Самоссылку generic ref не запрещать по правилам APP_NAV: допустимость решает конкретное property/mirror; редактор ручных рёбер исключает self обязательно. APP_NAV остаётся RefListControl со своей текущей очисткой/порядком.

```ts
const old = ['00000000-0000-4000-8000-000000000001'];
// Resolver отвечает archived:true; пользователь выбирает новый допустимый id.
expect(onChange).toHaveBeenLastCalledWith([...old, '00000000-0000-4000-8000-000000000002']);
// Ни mount, ни отказ resolver, ни новая выдача поиска сами onChange не вызывают.
```

- [ ] **4.6. Проверить и commit.** Все названные тесты плюс `RefField.test.tsx`, `ref-list-control.test.tsx` и chip tests из `features/entity-editor/nodes/chip.test.tsx`. `git commit -m "feat: share reference search and preserve saved reference lists"`.

## Task 5: Черновик, конфликты и проверяемая смена реестра

**Files:**
- Create: `apps/web/src/features/entity-detail/properties-relations/draft.ts`, `draft.test.ts`

**Interfaces:**
- Consumes: `DraftValue`, `parseDraftValue`, metadata access, `Entity`, `EffectiveRegistry`, актуальный `Context` из задачи 2 (маска приходит из `user.getSettings`, отдельно от реестра).
- Produces: `PanelDraft`, `startDraft(entity:Entity,registry:EffectiveRegistry,editor:PanelDraft['editor'],context:Context):PanelDraft`, `editField(draft,id,value)`, `observeDraft(draft:PanelDraft,entity:Entity,registry:EffectiveRegistry,context:Context):PanelDraft`, `acceptRemote(draft,id)`, `keepLocal(draft,id)`, `buildPatch(draft:PanelDraft,registry:EffectiveRegistry,context:Context)`.
- `editor` — `{kind:'values'} | {kind:'attach';aspectId:string} | {kind:'assignment'} | {kind:'relation';roleId:string;side:'source'|'target';otherId?:string}`; только одно значение editor, не набор параллельных форм.

- [ ] **5.1. Тестировать поведение, а не детали reducer.** Два поля из снапшота: изменить только одно → patch содержит только его. Изменить последнее raw → parse учитывает его; invalid не создаёт unset. При remote change нетронутое поле обновляется, тронутое сохраняет raw и получает conflict. Принять remote убирает локальную правку; keepLocal обновляет baseline и сохраняет raw. Другой entityId оставляет draft без изменений (observeDraft возвращает прежний объект); сменой target занимается оболочка задачи 9.

```ts
const d1 = editField(startDraft(entity, registry, {kind:'values'}, context), 'user/title', {kind:'raw',raw:'Моё'});
const d2 = observeDraft(d1, {...entity,props:{...entity.props,'user/title':'Чужое'}}, registry, context);
expect(d2.fields['user/title'].input).toEqual({kind:'raw',raw:'Моё'});
expect(d2.fields['user/title'].conflict).toBe(true);
expect(buildPatch(d2,registry,context).ok).toBe(false);
expect(buildPatch(keepLocal(d2,'user/title'),registry,context))
  .toEqual({ok:true,patch:{props:{'user/title':'Моё'}}});
```

- [ ] **5.2. Запустить красный draft.test.ts.** `cd apps/web && bun run test src/features/entity-detail/properties-relations/draft.test.ts`.
- [ ] **5.3. Реализовать draft с точным baseline.** `PanelDraft` содержит entityId, registryVersion, editor, `observedContext:Context` (копия для отображения последнего наблюдённого ограничения, не источник разрешения записи), `fields:Record<string,{input:DraftValue; baseline:{present:boolean;value:unknown};definitionFingerprint:string;conflict:boolean;metadataChanged:boolean;accessReason?:string}>`. Только затронутые поля входят в fields; остальные читаются из последнего entity. `present` отделён от value, чтобы absence не равнялся null. Equality для JSON plain values — рекурсивная, массивы упорядочены; не сравнивать raw с типизированным сохранённым значением. `definitionFingerprint` охватывает type/status/flags/module; смена только label/rank обновляет подпись без блокирования. Для attach/role фиксировать fingerprint выбранного определения и проверять его доступность при observe.

`buildPatch(draft,registry,context)` при каждом вызове заново проверяет актуальный context, а не только сохранённый observedContext. Для каждого unset требуется `propertyAccess(def,context).canUnset`, для set — разрешение записи соответствующим редактором; readOnly/archive запрещают оба. `observeDraft` вызывается и при изменении disabledExtensions/readOnly/archived без смены entity или registryVersion, обновляет observedContext/accessReason и сохраняет input/baseline. `buildPatch` возвращает `{ok:true;patch:ValuesPatch}` либо `{ok:false;errors:Record<string,string>}`; не кидает и не отправляет invalid/conflict/metadataChanged. При смене type/flags/status предложить «Перечитать определение» и «Отменить правку поля». Смена только mask/readOnly/archive показывает причину accessReason без сброса ввода и без притворного перечитывания неизменившегося определения; возврат разрешения снимает accessReason, но не снимает отдельные type/conflict ограничения. Перечитывание **не переинтерпретирует raw**: сохранить его видимым в предупреждении до явного сброса и нового ввода с новым контролом. Неизменённый version с изменённой маской тоже проверять. В версии реестра меняется selected role/aspect → запрет Save до повторного явного выбора.

- [ ] **5.4. Пиннуть дополнительные тесты и commit.** Registry number→date: raw `12` остаётся виден, Save запрещён; same label rename не теряет ввод; conflict по отсутствию/пустой строке обнаруживается. Маска меняется отдельно от entity и registry (оба сохраняют те же ссылки и version), и запрет действует даже до observeDraft:

```ts
const maskedDef = {...textDef,module:'finance'};
const maskedRegistry = {...registry,properties:[...registry.properties.filter(p => p.id !== textDef.id),maskedDef]};
const beforeMask = startDraft(entity,maskedRegistry,{kind:'values'},context);
const typed = editField(beforeMask,textDef.id,{kind:'raw',raw:'Сохранить мой ввод'});
const offContext: Context = {...context,disabledExtensions:['finance']};
const observed = observeDraft(typed,entity,maskedRegistry,offContext);
expect(observed.fields[textDef.id].input).toEqual({kind:'raw',raw:'Сохранить мой ввод'});
expect(buildPatch(observed,maskedRegistry,offContext).ok).toBe(false);
const cleared = editField(beforeMask,textDef.id,{kind:'unset'});
expect(buildPatch(cleared,maskedRegistry,offContext).ok).toBe(false);
```

Компонентная проверка в forms.test.tsx: начать unset при включённом finance; обновить только `user.getSettings.disabledModules`; нажать Save. Ни `onSubmit`, ни `entity.updateBatch` не вызваны, draft unset сохраняется и видна причина. Повторить для raw и перехода архив/readOnly. `git commit -m "feat: preserve property drafts across remote changes"`.

## Task 6: Единый подробный исход записи, Undo, свежесть и неизвестный исход

**Files:**
- Create: `apps/web/src/lib/graph-command.ts`, `graph-command.test.ts`, `useGraphUndo.ts`, `useGraphUndo.test.tsx`
- Modify: `apps/web/src/features/page/useUpdateBatch.ts`, `apps/web/src/lib/invalidate.ts`
- Create: `apps/web/src/features/entity-detail/properties-relations/useCommands.ts`, `useCommands.test.tsx`

**Interfaces:**
- Produces: `runGraphCommand(write:()=>Promise<{actionId?:string}>): Promise<CommandOutcome>` — единственная попытка, без retry.
- Produces: `useDetailedUpdateBatch(): (operations:UpdateBatchOperation[],options?:UpdateBatchOptions)=>Promise<CommandOutcome>`; старый `useUpdateBatch():RunUpdateBatch` остаётся boolean-wrapper с прежними тостами.
- Produces: `useGraphUndo(): (actionId:string,doneTitle:string)=>void` для тоста и отмены; использует текущее `ai.undo` и общий refresh.
- Produces: `usePanelCommands(): {run:RunPanelCommand; reconcile:(command:PanelCommand)=>Promise<'matches'|'differs'|'unavailable'>}`.

- [ ] **6.1. Написать транспортные тесты и повтор клика.** HTTP TRPC BAD_REQUEST/UNPROCESSABLE_CONTENT/NOT_FOUND/FORBIDDEN/CONFLICT → rejected с безопасным message; сеть, отсутствие data, timeout, INTERNAL_SERVER_ERROR/SERVICE_UNAVAILABLE → unknown. In-flight флаг выставляется синхронно ref до await: два клика дают один вызов. Независимо от размонтирования завершение обновляет кеш/тост исходного command.entityId, но не состояние другой формы.

```ts
const write = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
expect(await runGraphCommand(write)).toEqual({kind:'unknown',message:'Не удалось подтвердить сохранение'});
expect(write).toHaveBeenCalledTimes(1);
```

- [ ] **6.2. Прогнать красные tests из Files.** `cd apps/web && bun run test src/lib/graph-command.test.ts src/lib/useGraphUndo.test.tsx src/features/entity-detail/properties-relations/useCommands.test.tsx`.
- [ ] **6.3. Выделить detailed runner без второй реализации отправки.** Старый boolean wrapper зовёт detailed runner, отображает прежний generic toast при отказе и на confirmed вызывает общий useGraphUndo. Панель вызывает detailed runner напрямую, сама показывает ошибку формы. `useGraphUndo` принимает только подтверждённый id; async Undo отрабатывает vanilla client даже после закрытия панели. При отказе Undo показывает причину и перечитывает данные; при неизвестном исходе Undo сообщает о неподтверждённой отмене, не повторяет её автоматически. Не показывать «Отменить» после unknown или при отсутствии actionId.

Пять команд переводятся так:

```ts
// attach:
[{tool:'entity_update',input:{id:command.entityId,aspects:{attach:[command.aspectId]},...command.patch}}]
// detach:
[{tool:'entity_update',input:{id:command.entityId,aspects:{detach:[command.aspectId]}}}]
// values:
[{tool:'entity_update',input:{id:command.entityId,...command.patch}}]
// create/delete используют command.key БЕЗ перестановки концов:
utils.client.relation.create.mutate(command.key);
utils.client.relation.delete.mutate(command.key);
```

В реальном switch каждая ветка вызывает **один** соответствующий путь. label берётся из metadata: «Добавлен аспект „…“», «Снят аспект „…“», «Сохранены свойства», «Добавлена связь „…“», «Снята связь „…“». Empty values patch не отправлять, вернуть confirmed без actionId с сообщением «Нет изменений».

- [ ] **6.4. Подключить свежесть к существующему механизму.** На этой базе после confirmed/Undo/отказа с возможным устареванием вызвать invalidateGraph, invalidateBudget, `entity.resolveRefs.invalidate` и `relation.listFor.invalidate` через общий helper в invalidate.ts. Новые общие query keys из useResolvedRefs должны попадать под тот же prefix. Не обновлять отношения/props оптимистично вручную. Тест с одновременно подписанными current get, other get, entity.query/count, page query-block, resolveRefs и budget выдаёт изменённые серверные данные после create и Undo. Закрытые запросы помечаются stale без дополнительной сети. На новой базе скорости адаптировать один helper, а не каждую форму.

- [ ] **6.5. Реализовать сверку неизвестного исхода.** `reconcile` делает принудительное чтение `utils.entity.get.fetch(detailGetInput(command.entityId))` после invalidate этого ключа, а не возвращает stale cache. Для values/attach сравнивает только затронутые значения+unset и присутствие аспекта; для detach отсутствие аспекта; для relation наличие/отсутствие исходной тройки. После matches показать «Сейчас запись содержит эти изменения. Не удалось подтвердить, какой запрос их сохранил»; дать «Принять текущее состояние» для завершения формы, не объявлять наш success/Undo. После differs показать фактические данные рядом с сохранённым draft; «Повторить сохранение» доступно только новым явным жестом после успешной сверки. После unavailable повтор записи заблокирован, доступно «Проверить состояние»; draft остаётся. Никакой mutation queue/local saved/offline retry.

- [ ] **6.6. Тестировать все три сверки и commit.** Mock mutation изменяет backing fixture и затем бросает network error: get возвращает matches; create called once, Undo нет. Неизменённая fixture → differs и только явный click делает второй mutation. Ошибка reread → unavailable и кнопки Save нет. Test refusal retains raw draft интегрируется в задаче 7. `git commit -m "feat: unify panel mutation outcomes undo and reconciliation"`.

## Task 7: Формы аспектов, свойств и согласованное назначение

**Files:**
- Create: `apps/web/src/features/entity-detail/properties-relations/AspectsTab.tsx`, `PropertiesTab.tsx`, `forms.test.tsx`
- Create: `apps/web/src/features/entity-detail/assignment-form.tsx`, `assignment-form.test.tsx`
- Modify: `apps/web/src/features/entity-detail/AssignmentCard.tsx`

**Interfaces:**
- Consumes: metadata/draft/PropertyControl/RunPanelCommand. Внутри редакторов нет tRPC mutations. Каждое построение patch использует `buildPatch(draft,registry,context)` с актуальными props; контекст не захватывается один раз при startDraft.
- Produces: `AspectsTab` и `PropertiesTab` с `{entity,registry,context,draft,onDraftChange,onSubmit,onCancel,onSpecial}`; onSubmit получает один PanelCommand, onSpecial — `'assignment'|'page'|'app'|'navigation'`.
- Produces: `AssignmentDraft = {executor:'human'|'agent';grantId:string;mayClose:boolean}`; `assignmentDraftOf(entity)`; `assignmentPatch(entityId:string,draft:AssignmentDraft): Extract<PanelCommand,{kind:'attach'}>`; `AssignmentFields({draft,onChange,disabled})`.

- [ ] **7.1. Написать компонентные тесты ПС-03…13.** RenderWithProviders с real BUILTIN_REGISTRY и пользовательскими definitions. Запросы mutating handler считают вызовы; Save вызывается без blur последнего input. Покрыть task attach без присланного task_status, required-but-defaultable не блокирует Add, неподдержанное required поле даёт warning и всё же разрешает пробную отправку, два зависимых поля одним патчем, detach без props/unset, free property без attach.

```ts
expect(sent).toEqual({
  kind:'attach', entityId:entity.id, aspectId:'orbis/task',
  patch:{props:{'orbis/due_date':'2026-10-12'}},
});
expect(sent.patch.props).not.toHaveProperty('orbis/task_status');
```

Встроенный срок — `orbis/due_date` (`builtin-properties.ts`), key и id совпадают. Пользовательский срок фикстуры имеет id/key `user/due`; тест отдельно проверяет его отображение и запись.

- [ ] **7.2. Прогнать красные forms/assignment tests.** `cd apps/web && bun run test src/features/entity-detail/properties-relations/forms.test.tsx src/features/entity-detail/assignment-form.test.tsx`.
- [ ] **7.3. Собрать формы.** Aspects: список rank/id, неизвестные id видны readonly, service скрыт из добавления, disabled помечен именем расширения. Add выбирает registry definition, показывая поля по property-rank аспекта; значения подставляются, но untouched не включаются в patch. Сохранение — один attach command после текущих `aspectAccess(def,context).canAttach` и `buildPatch(draft,registry,context)`. Перед каждым onSubmit оболочка заново проверяет latest context: readOnly/archive блокируют все пять PanelCommand; attach/detach требуют aspectAccess, values/assignment — доступность всех затронутых полей своим редактором, ручные рёбра — roleAccess. Для состояния из hook использовать текущий render/ref, не snapshot начала редактирования. Изменения маски обязательно входят в dependencies наблюдения draft и не зависят от registryVersion. Detach подтверждается inline текстом спецификации. Properties: union rows, search label/key, метки carriers/free/proposed/deprecated, один общий draft values, выбор нового свободного поля не пишет. Unsupported тип объясняет ограничение; разрешённый clear доступен отдельно. JSON null безопасно показывается как `null`, не как absence; сырой JSON не редактируется.

Ошибки rejected остаются role=alert в форме с фокусом; известные id в безопасном сообщении заменять на подписи словаря как точные токены, без извлечения адреса поля из текста. Неизвестное сообщение INTERNAL_SERVER_ERROR пользователю не выводить — generic unknown. Server details/cause/SQL в DOM не попадают.

- [ ] **7.4. Извлечь назначение с двумя реальными потребителями.** AssignmentFields содержит существующие radio/select/checkbox и ленивое `oauth.listGrants` только для agent. Draft хранится у родителя, field queries не мутируют. Из AssignmentCard вынести draftOf и патч, после чего карточка сохраняет старый внешний useEntityUpdate, а панель передаёт тот же patch в attach command с обычными отказом/Undo. Никакой проверки «есть task» перед открытием панели назначения.

```ts
export function assignmentPatch(entityId: string, d: AssignmentDraft): Extract<PanelCommand,{kind:'attach'}> {
  return {kind:'attach',entityId,aspectId:'orbis/assignment',patch:d.executor === 'agent'
    ? {props:{'orbis/executor':'agent','orbis/grant':d.grantId,'orbis/may_close':d.mayClose}}
    : {props:{'orbis/executor':'human'},unset:['orbis/grant','orbis/may_close']}};
}
```

Card адаптирует результат к старому input `{id,props,unset,aspects:{attach:[...]}}`; снять назначение — только detach без стирания значений. Assignee отображается и ведёт к этому редактору; если существующий редактор не поддерживает изменение имени человека, явно оставить его readonly с объяснением, а не предлагать независимую несогласованную запись.

- [ ] **7.5. Пиннуть отказ и архивную ссылку.** Mock отклоняет patch text+ref-many с архивной целью. Проверить оба raw значения и старый id остаются, patch не повторяется; явное удаление архивной цели позволяет отправить исправленный полный массив. Cancel конкретной правки списка возвращает untouched baseline, затем patch другого поля не содержит ref. Все flags запрещают обход через Clear; preview/archive запрещают запуск редакторов.
- [ ] **7.6. Прогнать регрессии и commit.** Новый набор плюс `features/entity-detail/detail.test.tsx` и `features/page/preview-readonly.test.tsx` сохраняют прежнее назначение. `git commit -m "feat: add aspect property and assignment forms"`.

## Task 8: Все рёбра, направление и ручные операции

**Files:**
- Create: `apps/web/src/features/entity-detail/properties-relations/RelationsTab.tsx`, `relations.test.tsx`
- Consume: `metadata.ts`, `useEntityOptions.ts`, `useResolvedRefs.ts`, shared `ref-metadata.ts`

**Interfaces:**
- `RelationsTab({entity,relations,registry,context,draft,onDraftChange,onSubmit,onCancel,onNavigate,onShowProperties,onOpenBody})`.
- `onNavigate(id:string):void` проходит общий guard; `onShowProperties(propertyId?:string):void` работает только для текущего источника; onOpenBody передаётся хостом.

- [ ] **8.1. Написать тест направления с обеих сторон.** Данные source A/target B не переворачивать при incoming-показе. Для двух ролей одной пары показать два DOM-row по edge.id. При текущем B: delete отправляет source A target B. Create side target тоже отправляет other→self. Таблица subitem и dependency проверяет стрелку, sourceLabel/targetLabel из изменённого registry (переименовать labels в fixture, чтобы поймать литералы).

```ts
expect(onSubmit).toHaveBeenCalledWith({
  kind:'deleteRelation',entityId:B,key:{source_id:A,target_id:B,role:'subitem'},
});
expect(screen.getByText('Родитель — Проект → Подпункт — Задача')).toBeVisible();
```

- [ ] **8.2. Запустить красный relations.test.tsx.** `cd apps/web && bun run test src/features/entity-detail/properties-relations/relations.test.tsx`.
- [ ] **8.3. Реализовать полный read-only список.** Relations приходят из полного detail response, rows key=id. Группы outgoing/incoming, sort role.rank/createdAt/id. Сначала 50 рёбер **всего**, затем +50 по «Показать ещё»; заголовок «Показано 50 из 123», число из полного массива, не из backlinks. Названия всех уникальных соседей через batches; ошибка названий не обнуляет список рёбер. Archive badge, надпись «Запись недоступна», отдельный retry.

Ref row — одна, даже если несколько свойств; `mirrorPropertyId(role.rules,relation.meta)` показывает «Свойство из метаданных: …». Исходящая кнопка переводит к property источника (или просто Properties если метка не разрешается). Incoming кнопка открывает source с guard. Системные роли без remove. Unknown role видна по id с причиной, без create/delete. Text links объяснить и кнопкой «Открыть текст записи» передать хосту; не подмешивать backlinks как рёбра.

- [ ] **8.4. Реализовать редактор ребра.** Role picker только известные разрешённые роли; side selector словами роли. `contractTarget` применяется к выбираемой стороне; `implementsContract` даёт причину для очевидно неподходящего текущего конца тем же shared binding index. При смене role/side очистить только выбранный otherId и обновить область поиска, ничего не записывать. Current id исключить для всех ролей. Duplicate исключать по source/target/role после ориентации; обратная пара и другая роль остаются. Preview показывает обе стороны и стрелку, Save ровно createRelation command. Нет создания entity, автоматического снятия старого родителя, расчёта цикла/лимитов на клиенте.

```ts
const key = side === 'source'
  ? {source_id:entity.id,target_id:otherId,role:roleId}
  : {source_id:otherId,target_id:entity.id,role:roleId};
const duplicate = relations.some(r => r.sourceId === key.source_id && r.targetId === key.target_id && r.role === key.role);
```

- [ ] **8.5. Пиннуть пограничные случаи и commit.** System remove отсутствует с обеих сторон; self отсутствует у mention; duplicate filtered только одна тройка; errors cycle/max/contract сохраняют выбор; ref общая строка остаётся после refresh с одним property; incoming ref никогда не открывает property у target. 123 рёбра → 50/100/123; 401 сосед → batches ≤200. `git commit -m "feat: add directional relation browsing and editing"`.

## Task 9: Ленивый вход, оболочка, специальные страницы и доступность

**Files:**
- Create: `apps/web/src/features/entity-detail/PropertiesRelationsSlot.tsx`
- Create: `apps/web/src/features/entity-detail/properties-relations/PropertiesRelationsPanel.tsx`, `panel.test.tsx`, `entry.test.tsx`
- Modify: `apps/web/src/features/entity-detail/DetailMenu.tsx`, `DetailScreen.tsx`, `apps/web/src/features/page/TemplatePreview.tsx`, `apps/web/src/ui/Sheet.tsx`
- Modify tests: `apps/web/src/features/entity-detail/detail-menu.test.tsx`, `apps/web/src/features/page/preview-readonly.test.tsx`, `apps/web/src/ui/primitives.test.tsx`
- Modify: `scripts/check-lazy-chunks.ts`

**Interfaces:**
- `PanelTarget = {entityId:string;readOnly:boolean}`.
- `PropertiesRelationsSlot({target:PanelTarget|null,onClose:()=>void,host:PanelHostActions})`.
- `PanelHostAction = 'openBody'|'restore'|'makePage'|'stopPage'|'configureApp'`.
- `PanelHostActions = {screenEntityId:string; available:ReadonlySet<PanelHostAction>; run:(action:PanelHostAction,target:PanelTarget)=>void}`. Это адресные маршруты хоста: каждый вызов передаёт frozen target явно. available описывает существующие команды текущего хоста; UI дополнительно сравнивает target.entityId и screenEntityId. Отсутствующая или неприменимая команда показывает причину.
- Для `restore/makePage/stopPage/configureApp` обязательны `target.entityId === latestHost.entity.id`, `!target.readOnly` и текущий разрешённый режим хоста (не preview/configuring, не readOnly); иначе dispatcher отказывает без мутации/смены вида. У `openBody` другая допустимая ветка: несовпадающий id открывается адресно навигацией. Dispatcher читает latest host entity/bodyGate/handlers из ref, обновлённого текущим render; callback, отложенный dirty-confirm, не удерживает обработчик прежней записи.
- `PropertiesRelationsPanel({target,host,onClose})` подписывается на `detailGetInput(target.entityId)` и useRegistry; не принимает меняющийся «текущий id» вместо frozen target.
- `TemplatePreview` добавляет `onPreviewTarget?:(pageId:string,target:PanelTarget|null)=>void` и сообщает chosen id после выбора/эффекта; пока waiting/ошибка чтения target — null. Для чужой записи readOnly:true; для «сама страница» действуют её обычные права.

- [ ] **9.1. Написать entry/lazy tests.** Обычная запись, page, app, custom template без cards имеют пункт. configuring чужого шаблона — пункта нет. Preview target в шапке панели и readonly, ни одна mutation не вызывается. Закрытый slot возвращает null: нет импорта panel module, entity options, resolver и дополнительных registry requests. Открытие одного меню ещё не грузит панель.

- [ ] **9.2. Запустить красные entry/panel tests.** `cd apps/web && bun run test src/features/entity-detail/properties-relations/entry.test.tsx src/features/entity-detail/properties-relations/panel.test.tsx`.
- [ ] **9.3. Встроить независимый от шаблона slot в DetailScreen.** `DetailMenuProps` получает `onOpenProperties?:()=>void`; пункт в commonItems. Slot размещается рядом с ScreenMenuProvider над ветками page/record, поэтому смена projection после attach не обрывает панель. Хранить frozen target по жесту; при изменении route/entity контекста не заменять target в уже открытой панели. Preview callback сообщает реальный chosen this, при waiting пункт disabled с объяснением; при configuring пункт отсутствует. Cleanup preview callback не должен обнулить более новый target другого pageId: передавать вместе с ним pageId и сравнивать в DetailScreen. После выбора меню фокус перемещается в panel, закрытие возвращает на кнопку меню хоста.

```tsx
const Panel = lazy(() => import('./properties-relations/PropertiesRelationsPanel')
  .then(m => ({default:m.PropertiesRelationsPanel})));
return target === null ? null : <Suspense fallback={<p role="status">Загрузка панели…</p>}>
  <Panel key={target.entityId} target={target} host={host} onClose={onClose} />
</Suspense>;
```

Lazy error boundary предлагает повторить загрузку чанка, а не вечный rejected React.lazy promise: использовать уже существующий образец retry loader из DetailMenuSlot и LazyMenuSlot. Типы импортировать type-only. Добавить `PropertiesRelationsPanel`, `ScalarListControl`, `RefManyControl` в `LAZY_DETAIL_MODULES` (сторож проверяет static closure, не только entry chunk).

- [ ] **9.4. Собрать оболочку и guard.** Sheet side=right. Добавить opt-in `size?:'default'|'wide'`, `contentClassName` и `onCloseAutoFocus` в Sheet, прежний default размер не менять. Выбор size выбирает **один** набор width-классов: default `w-[min(85vw,20rem)]`, wide `w-full sm:w-[min(36rem,100vw)]`; не складывать конфликтующие w-классы. Панель использует wide и `h-dvh flex flex-col overflow-hidden`, scroll content `min-h-0 flex-1 overflow-y-auto`, footer shrink-0 с safe-area padding. Заголовок содержит имя+id fallback. Tabs «Аспекты/Свойства/Связи», по новому открытию Aspects. Раздел переключается, активный draft не теряется; начало другого editor вызывает confirm.

Единая функция `requestPanelAction(action:()=>void)` выполняет сразу если clean, иначе сохраняет локальный callback и открывает «Продолжить редактирование / Отбросить изменения». Cancel формы явно сбрасывает её draft. При pending close/editor-switch disabled; внешний leave guard возвращает false с «Дождитесь окончания сохранения». После unmount ответ всё равно обновляет исходные данные, состояние другого id не трогает.

Для global navigation зарегистрировать `registerLeaveGuard`: при dirty открыть то же подтверждение и вернуть false. При discard очистить draft и показать «Изменения отброшены — повторите переход»; не пытаться угадать потерянный nav callback. Для переходов самой панели сохранить точное действие и frozen target, после discard синхронно очистить draft-ref стража и выполнить callback с вызовом текущего host.run(action,target). Dispatcher повторно проверяет id/доступность в момент выполнения, а не при открытии подтверждения. `beforeunload` при dirty ставит стандартный browser guard; обещания сохранять draft после закрытия приложения нет. При вынужденной смене props id guard может не вызываться: хранить panel target отдельно, показывать прежнюю запись до явного закрытия; поздний read/submit не заменяет новый экран.

- [ ] **9.5. Подключить специальные маршруты с адресной проверкой.** Assignment использует форму задачи 7. Для page извлечь из DetailMenu существующие make/stop обработчики в небольшой hook **`apps/web/src/features/entity-detail/usePageIdentityActions.ts`**, потребляемый меню и panel host; добавить этот файл и `usePageIdentityActions.test.tsx` к Files задачи. Hook `usePageIdentityActions(entity:WireEntity,bodyGate:BodyGateRef):{makePage:()=>void;stopPage:()=>void}` импортирует BodyGateRef type-only из EntityBody.tsx и settleBody из body-gate.ts. Перенести точные существующие makePageItem/stopPageItem операции и `settleBody` gate, а обработчики change-view/TemplateForDialog и закрепления тела оставить в меню; оба места используют useUpdateBatch с единым Undo и существующей блокировкой несохранённого тела.

У панели нет прямого доступа к этим безаргументным handlers: она вызывает только `host.run('makePage',target)`/`host.run('stopPage',target)` через requestPanelAction. Dispatcher сравнивает target.entityId с **текущим** latestHost.entity.id, отвергает preview/readOnly/mismatch; только совпавший id получает текущие page handlers и bodyGate этой же записи. Если target заморожен на A, а хост уже показывает B, page/app/restore disabled с текстом «Откройте эту запись, чтобы выполнить действие». Прямой вызов dispatcher при mismatch тоже должен отказать, а не только скрывать кнопку.

App — через `host.run('configureApp',target)` после guard; при совпадении id и разрешённом контексте вызвать `setOpenVia(HOST_VIEW)` текущей записи приложения. Существующий шаблон хоста показывает карточку приложения и её специальный APP_NAV editor. Preview/mismatch этот путь не получают; никакого attach/detach app. Supply/service только объяснение. Archive — readonly **для записи значений**, Restore доступен владельцу только при совпадении id, target.readOnly=false и текущем latestHost.entity.archived=true. Dispatcher использует существующий `setArchived(false)` из useEntityDetail текущего id, а не toggle `onArchive` из меню; после ответа панель ждёт entity.archived=false по собственному ключу target. При mismatch restore не выполняется.

`host.run('openBody',target)` доступен и для чужой записи preview, поскольку это явная навигация к ней. Перед любым изменением mode/view выполнить `mayLeave()`; при false выйти без перехода, setMode, setOpenVia и setView. Затем развести **две ветки по id**, а не по режиму preview:

- target.entityId совпадает с текущим latestHost.entity.id: в этом же хосте выполнить `setMode(null)` **и** `setOpenVia(HOST_VIEW)`, затем закрыть панель. Это относится и к preview «сама страница», и к настройке этой страницы, и к обычному показу. Повторный openRecord того же адреса не нужен. Локальный openVia — источник зеркала history: существующий эффект DetailScreen сам запишет `view.via='host'`; отдельный setView без setOpenVia здесь неверен.
- target.entityId отличается: адресно открыть **target.entityId** через существующий `useNav.getState().openRecord(target.entityId)`. После синхронного перехода проверить `currentEntry(useNav.getState().model).address`: только для record с тем же target id вызвать `setView({via:'host'})` и закрыть панель. Новый id/place инициализирует свой local openVia из этого view. При отказе перехода не менять view остающейся записи.

В dispatcher используются актуальные setters хоста из latest-ref; callback dirty-confirm хранит действие и target, а не старые setters. Полная развилка:

```ts
if (!mayLeave()) return;
const targetId = target.entityId;
if (targetId === latestHost.entity.id) {
  setMode(null);
  setOpenVia(HOST_VIEW);
  onClose();
  return;
}
useNav.getState().openRecord(targetId);
const here = currentEntry(useNav.getState().model).address;
if (here.kind !== 'record' || here.id !== targetId) return;
useNav.getState().setView({via:'host'});
onClose();
```

Основание разделения — проверенный код: `applyOpen` не добавляет новый шаг при том же адресе (`packages/shared/src/nav/history-model.ts`), `placeKeyOf` не включает view, а эффект `DetailScreen.tsx` пишет local openVia обратно в history. Поэтому для совпадающего id недостаточно `setMode(null)` и одного `setView({via:'host'})`: прежний local openVia сотрёт такой view. Контекст прав редактора после открытия тела определяется обычным хостом заново; readonly предпросмотра не становится разрешением записи внутри панели.

- [ ] **9.6. Проверить keyboard/mobile/races и commit.** Tab не выходит за диалог, Escape при dirty открывает confirm, focus возвращается на menu trigger, error summary role=alert получает focus. Тест delayed response A, навигация к B: toast относится к A, ни один input B не заполнен A. Добавить три обязательные регрессии адресации:

1. Экран шаблона A показывает preview записи B; панель сообщает title/id B и readonly. «Открыть текст записи» вызывает openRecord(B), верх навигации — record B с view.via='host'; ни mutation, ни смены body/view записи A нет. При блокирующем leave guard навигация и setView не выполняются.
2. Открыть архивную A и её панель, принудительно rerender DetailScreen на B, минуя guard. Панель сохраняет target A. Restore/page/app disabled; прямой `host.run('restore',targetA)` или отложенный после dirty-confirm `host.run('makePage',targetA)` не вызывает `setArchived`/updateBatch для B и не меняет его view. После явного открытия A её законный restore пишет `{id:A,archived:false}`, без toggle и без обращения к B.

3. Для одной и той же страницы A параметризовать начальный режим: preview с выбором «сама страница» и configure этой же A. Начальный local openVia не равен host. Вызвать «Открыть текст записи» через панель; **после выполнения React-эффектов** проверить: mode закрыт, показано тело A шаблоном хоста, `currentEntry(useNav.getState().model).view?.via === 'host'`, число мутаций 0. Затем сделать независимый rerender/refetch той же A и снова дождаться эффектов: вид остаётся host, preview/configure не возвращается, history.via не очищен. Test должен проверять устойчивое состояние после эффектов, а не единственный вызов setView. В варианте configure открыть панель на своей странице (вход для чужого шаблона по-прежнему отсутствует).

Пользовательский шаблон без body: «Открыть текст» показывает HOST_VIEW **того же target id**, после guard. Viewport 360×640 и открытая экранная клавиатура вручную: Save доступен, нет горизонтального scroll. `git commit -m "feat: expose lazy properties and relations panel in record host"`.

## Task 10: Общая приёмка, выпуск и обязательство среза 2

**Files:**
- Create: `apps/web/src/features/entity-detail/properties-relations/acceptance.test.tsx`
- Create: `docs/implementation/properties-and-relations-acceptance.md`
- Modify: `docs/implementation/03-pending.md` только точечными строками в изолированной ветке
- Read: `.github/workflows/ci.yml`, `scripts/check-lazy-chunks.ts`

**Interfaces:**
- Consumes: пять PanelCommand и те же пользовательские сценарии через публичный UI.
- Produces: именованная acceptance suite и контракт будущего переноса, не выдуманный API именованных действий.

- [ ] **10.1. Добавить сквозной компонентный сценарий.** На mutable server fixture из настоящих registry defs открыть меню, добавить пользовательский аспект с shared property, изменить два значения и clear свободного поля, создать/снять incoming relation, нажать toast Undo. Mock handler обновляет fixture только по присланному patch, отдельный integration suite задачи 1 проверяет настоящие rules/rollback. Это разделение не заменяет сервер собственным клиентским вычислителем правил.

```ts
expect(calls.filter(c => c.path === 'entity.updateBatch')).toHaveLength(1);
expect(batch.operations).toHaveLength(1);
expect(batch.operations[0].tool).toBe('entity_update');
expect(batch.operations[0].input).not.toHaveProperty('body');
expect(calls.some(c => c.path.startsWith('ai.') && c.path !== 'ai.undo')).toBe(false);
```

- [ ] **10.2. Выполнить матрицу ПС-01…28 ниже.** В acceptance doc записать дату, HEAD, реальные команды/итоги и manual observations. Не помечать ПС-28 как выполненный перенос: сегодня проверяется готовность границы и сохранённый контракт, сам parity gate обязателен при срезе 2.
- [ ] **10.3. Прогнать gates текущей базы.** Из изолированного дерева:

```bash
bun run typecheck
bun run test
bun run lint
bun run check:legacy-form
bun run --filter @orbis/web build
bun scripts/check-lazy-chunks.ts --max-gzip DetailScreen=34889 --max-closure-gzip DetailScreen=325238
```

Server integration suite требует локальных `DATABASE_URL` и `DATABASE_URL_ADMIN`; использовать настроенный выделенный test environment, никогда production DSN. Если базы нет, поднять штатный local Supabase и выполнить documented `db:prepare` **на тестовом экземпляре**; не считать skipped suite успешной. Не расширять лимиты чанков ради новой панели. `bun run test:perf` выполнить последовательно после функциональных тестов, как CI, если точечные изменения общего reader/refresh влияют на запросы; не одновременно с полным suite. На новой базе использовать действующие CI thresholds.

- [ ] **10.4. Ручная приёмка на тестовом графе.** Десктоп: note→task, пользовательский аспект с required, два поля, incoming dependency, отказ и Undo. Телефон: keyboard/scroll/Save, длинные подписи, ref-many c архивной целью, dirty close. Панель закрыта — DevTools Network/manifest доказывают отсутствие новых запросов/чанка; меню открыто без выбора панели — её чанк ещё не грузится. Проверить новый endpoint на сервере до либо вместе с новым web.
- [ ] **10.5. Зафиксировать перенос в pending и acceptance doc.** Строка нового среза: «Свойства и связи — общий вход, аспекты/значения/ручные связи; спецификация docs/superpowers/specs/2026-10-10-properties-and-relations-design.md; состояние: реализовано в ветке, выпуск не подтверждён». У среза 2 добавить: «Перевести пять команд панели на формы и именованные действия; ПС-01…27 новым путём, один жест — одна мутация; удалить временный direct adapter и заменённую ручную сборку, без миграции данных». После фактического выпуска обновить статус с датой; этот план сам выпуск не подтверждает.
- [ ] **10.6. Сохранить в acceptance doc точный будущий gate ПС-28.** Новая реализация предоставляет тот же RunPanelCommand для сценариев либо переносит UI suite на новые формы; для каждой операции spy доказывает один вызов записи, старый и новый пути одновременно никогда не исполняются. Снять снимок ids/aspects/props/relations до переключения и после без пользовательских записей — равенство. Прогнать ПС-01…27 включая нестандартный шаблон, assignment/page, отказ и Undo. Удалить `useCommands.ts` с прямыми вызовами, локальные маршруты специальных редакторов и сборку форм там, где заменены декларациями. Общие PropertyControl/search/draft parsing и сервер сохраняются. Пока один сценарий не выражается срезом 2, migration не complete; именованный остаток с причиной в pending. Никаких схем/actions «на будущее» в этом срезе.
- [ ] **10.7. Commit и итоговая проверка diff.** `git diff --check`, `git status --short`; убедиться, что Files задач покрывают весь diff и чужие файлы не затронуты. `git commit -m "test: accept properties and relations and record slice two handoff"`. PR/выпуск — отдельный следующий этап согласно авторизации владельца, завершение текущего плана не означает разрешение начать реализацию.

## Матрица покрытия спецификации

| Сценарий | Задачи / автоматический файл | Проверяемый результат |
|---|---|---|
| ПС-01 | 9 entry.test.tsx | note/page/app/custom без cards, правильный title/id |
| ПС-02 | 9 entry/panel + preview-readonly.test.tsx | preview readonly; openBody A→B адресный, A→A синхронизирует local openVia/history после эффектов; configuring без невидимой записи |
| ПС-03 | 1 properties-relations.test.ts; 7 forms | тот же id/body, серверный default, проекция после refetch |
| ПС-04 | 1 entity-update-batch/ref; 7 forms | attach+fields один action, rollback БД+журнала, draft сохранён |
| ПС-05 | 1 integration; 2 metadata; 7 forms | dedupe по property id, два carriers, detach сохраняет value |
| ПС-06 | 1 integration; 7 forms | free set/unset без attach, definition сохраняется |
| ПС-07 | 3 PropertyControl; 5 draft; 7 forms | active raw, единый patch только touched, один Undo |
| ПС-08 | 3 draft-value/ScalarList | false/0/empty string/list/null отличаются от unset, decimal/zone |
| ПС-09 | 1 ref; 4 useEntityOptions/RefMany | target/undefined/alternatives, full list, серверный доступ |
| ПС-10 | 3 ScalarList | строка с запятой одна, add/remove полный массив |
| ПС-11 | 1 ref; 4 RefMany; 7 forms | архив/недоступность сохраняются, отказ всего patch, явное исправление |
| ПС-12 | 2 metadata; 7 forms | flags/mask/deprecated/unknown, нет обхода Clear |
| ПС-13 | 7 assignment-form/forms; 9 host | unsupported объяснение, assignment без task, согласованный patch/Undo |
| ПС-14 | 8 relations; 1 API | subitem обе стороны, только relation_create |
| ПС-15 | 8 relations; 6 refresh | dependency source/target и списки/блокировки после refresh |
| ПС-16 | 1 relations; 8 relations | self всех ролей, duplicate/cycle/contract/limit, сохранённый draft |
| ПС-17 | 1 ref; 8 relations | две роли, одно ref двух свойств, unset одного сохраняет зеркало |
| ПС-18 | 1 API; 6 commands; 8 relations | исходная тройка на target, actionId и Undo пересчётов |
| ПС-19 | 1 relations; 8 relations | system/ref UI и API отказ, правильный source для свойства |
| ПС-20 | 1 integration; 8 relations | mention и текстовый индекс независимы |
| ПС-21 | 4 resolver/options; 8 relations; 9 panel | ошибка/empty/limit отдельно, max200, честный total/50 |
| ПС-22 | 5 draft; 9 panel | confirm dirty, frozen id, late response; адресные host actions отвергают mismatch |
| ПС-23 | 5 draft; 7 forms; 9 panel | conflict baseline; смена только маски сохраняет raw и блокирует set/unset без мутации |
| ПС-24 | 6 graph-command/useCommands | unknown → reread, без retry/выдуманного actionId |
| ПС-25 | 6 useGraphUndo/useCommands | оба конца, query/count/blocks/ref titles/budget свежие после записи и Undo |
| ПС-26 | 9 entry/panel; 10 build/manual | ленивый чанк и запросы, focus, узкий экран/клавиатура |
| ПС-27 | 1 properties-relations API | ownerOnly/RLS чужого графа не обходятся |
| ПС-28 | 10 acceptance + будущий gate | executable boundary сейчас; полный parity и удаление adapter при срезе 2 |

## Принятые решения и допущения для отчёта

1. Это один срез с последовательными задачами, потому что draft/commands/host имеют общие интерфейсы; отдельные планы для их слоёв оставили бы неработающие части.
2. Текущий исполнитель уже атомарен и корректно поддерживает общее зеркало; нужны доказательные регрессии, не новый серверный механизм.
3. Срез скорости не внедрён в исследованной базе. Его применение при новой базе меняет только реальные интеграционные швы; перенос старого журнала/Undo/invalidation запрещён.
4. Контракт конца разрешается существующим shared binding index в AST аспектов; клиент не вычисляет контрактные выражения и не использует список встроенных аспектов.
5. Для неизвестного исхода нет нового idempotency endpoint: принудительная сверка и явный повтор. Совпадение состояния не доказывает авторство запроса и не создаёт Undo.
6. Локальная конкурентная защита — предупреждение по touched fields и явный выбор пользователя, без обещания CAS для props. Доступность проверяется с актуальным Context на observe и непосредственно перед отправкой; маска расширений не считается частью registryVersion.
7. Host actions адресуются frozen target; локальные restore/page/app работают только при совпадении с текущим хостом, openBody чужого preview-target открывает его адресно через guard. Во внешней навигации текущий синхронный leave-guard не хранит intent; после discard пользователь повторяет переход. Внутри панели callback сохраняется точно. Это сохраняет данные без вторжения в общую историю.
8. Неподдержанный тип разрешает очистку, если flags/server это допускают. Assignment и APP_NAV сохраняют специальные согласованные пути.
9. Общие списки ref сохраняют старые недоступные/архивные ids до явного удаления; изменение массива проверяется сервером целиком.
10. ПС-28 — обязательство будущего среза с точной проверкой паритета; этот выпуск не выдаёт ещё отсутствующие формы/действия за реализованный перенос.

## Самопроверка автора

- [x] Все §§0–11 спецификации сопоставлены задачам и матрице ПС-01…28.
- [x] Проверены существование исходных файлов и реальные имена текущих API; новые API/файлы названы как создаваемые.
- [x] У каждой задачи есть потребители/результаты, конкретные тестовые наблюдения, команды проверки и коммит только её файлов.
- [x] Проверены различия empty/unset, type drift, unknown outcome, shared ref, self всех ролей, special routes, lazy loading, registry/read errors, future migration.
- [x] План не предписывает менять продукт в текущем цикле подготовки/ревью; чужие документы и индекс не затронуты автором.
