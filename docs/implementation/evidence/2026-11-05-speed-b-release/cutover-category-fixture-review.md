# Сверка фикстуры после первого N

**Точный пакет одобрен по исходникам для согласованного единственного повтора N.** SHA-256 манифеста `bc53016432fe897aeb6d9edeb9e067563bfc130ed8f10e8c8ba8e793dca7e5e3`, объединённая дельта `5819caab9a878d7e0621c2c35727ed60d3d2c348676237e670660e7df828d6aa`. Шесть хешей совпали. `artifacts.py`, `launcher.ts`, `identity.ts` неизменны. [Пакет](cutover-runner/source.sha256), [дельта](cutover-runner.category-fixture.diff).

- Первый N на настоящем b5 остановился до Chrome. Onboarding и три заметки прошли, лишний create категории получил 403. Причина конкретного 403 остаётся неустановленной. В новой N ветке нет категории и P preflight. Email однозначно привязан к новому synthetic owner UUID, прежний partial seed сохраняется без очистки. Пакет сохраняет pinned N и прежний migration guard. [Первый результат](cutover-first-result.md).
- В P перед чтением категорий реальный b5 `user.setModuleEnabled({module:'finance', enabled:true})` подтверждается отдельным `getSettings`. Предварительно доказывается штатная маска Finance OFF. b5 `entity.query` возвращает flat array с id/title/props, включая обычную проекцию без `fields`. Это тот же query, который использует fast-path. Фикстура требует одну штатную запись «Транспорт» с алиасом «такси».
- Финансовая выборка учитывает только движения с `orbis/financial`, без конвертов `orbis/budget` с тем же category reference. Исходный UUID, canonical payload всех forwarded попыток, точный ACK, полная смысловая выборка и ровно одно реальное fast-path действие по графу остаются отдельными барьерами.
- `run-lane.sh` пишет фактический exit через `run_exit` и отказывается перезаписывать прежний output. Сохранённый первый RED не получил синтетический child exit. Проверка source не включает успешность UI, D2, browser process, worker, Auth или транспортных контрольных точек.

Собственных запусков не было. Повтор N требует отдельной выдачи окна. Исполнение P остаётся отдельной передачей.
