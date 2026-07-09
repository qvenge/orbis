-- 0003_chat_messages_ms_precision.sql
-- Миллисекундная точность created_at (находка ревью 1c-2).
-- Дыра: колонка была timestamptz без precision, поэтому defaultNow() писал микросекунды,
-- а wire отдаёт ISO с миллисекундами (JS Date). Составной курсор пагинации
-- (routers/chat.ts) сравнивает eq(created_at, <мс-Date>) — при ненулевых микросекундах
-- равенство не выполнялось НИКОГДА, ветка tie-break по id была мертва, и сообщения одной
-- миллисекунды (ровно тот случай, ради которого курсор вводили: записи одного tx получают
-- одинаковый now()) пропадали на границе страниц.
-- Приведение округляет существующие значения до мс; порядок держит tie-break по id.
ALTER TABLE "chat_messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "created_at" SET DEFAULT now();
