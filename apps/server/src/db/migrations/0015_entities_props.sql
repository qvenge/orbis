-- 0015_entities_props.sql — expand-половина реформы свойств (§А1-1 спеки, РП-2).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0015_snapshot.json — сгенерированный. Так пришлось потому,
-- что drizzle-kit видит расхождение схем как «у колонки aspects сменился тип jsonb → text[]
-- плюс появились три новые» и пишет `ALTER COLUMN aspects SET DATA TYPE text[]`. Это не тот
-- же смысл: переименование СОХРАНЯЕТ старую карту в `aspects_legacy` (её ещё читают
-- компилятор запросов, доменные модули и web), а смена типа уничтожила бы её вместе со
-- строками — на непустой базе такой ALTER просто падает. Снимок при этом верен (в нём
-- четыре колонки в нужных типах) и нужен: без него следующая генерация не увидит их как
-- существующие.
--
-- РАЗРУШАЮЩИХ шагов нет: старые данные переезжают вместе с колонкой, новые три колонки
-- получают дефолты. Данные из старой формы в новую НЕ конвертируются — писатель `props`
-- появляется следующей задачей, а база пересевается (локально truncateAll/db:prepare,
-- на проде — по чек-листу «Пересева мира»); до тех пор новые колонки пусты.
--
-- Ни RLS-политик, ни грантов здесь нет намеренно: новых таблиц не появилось, а политики и
-- гранты 0001 выданы на таблицу целиком и на колонки не смотрят.
ALTER TABLE entities RENAME COLUMN aspects TO aspects_legacy;--> statement-breakpoint

-- Индекс переезжает ЗА своей колонкой: имя `entities_aspects_gin` освобождается под индекс
-- новой колонки, а старый остаётся под запросами `aspects_legacy @> …`, которых до
-- «Пересева мира» ещё много (agent-loop, budget, import, компилятор §6).
ALTER INDEX entities_aspects_gin RENAME TO entities_aspects_legacy_gin;--> statement-breakpoint

ALTER TABLE entities
  ADD COLUMN props jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN aspects text[] NOT NULL DEFAULT '{}',
  ADD COLUMN query_refs text[] NOT NULL DEFAULT '{}';--> statement-breakpoint

-- Три GIN'а того же класса, что и снятые ими с работы: containment по значению (`props @>`),
-- вхождение элемента в массив (`'orbis/task' = ANY(aspects)` / `aspects && …`), обратные
-- ссылки. Судьба каждого — приёмка EXPLAIN на живой базе (она же решает, какие индексы
-- дожили до contract-миграции 0017): неподтверждённый снимается там же. Исключение —
-- `entities_query_refs_gin`: его писатель появляется только в задаче ссылочных свойств,
-- измерять сейчас нечего, и вердикт по нему выносится в «Пересеве мира».
CREATE INDEX entities_props_gin ON entities USING gin (props);--> statement-breakpoint
CREATE INDEX entities_aspects_gin ON entities USING gin (aspects);--> statement-breakpoint
CREATE INDEX entities_query_refs_gin ON entities USING gin (query_refs);
