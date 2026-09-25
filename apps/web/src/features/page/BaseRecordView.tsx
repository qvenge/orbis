import { Card } from '../../ui/Card';
import { RestCards } from '../entity-detail/own-cards';
import { BodyBlock, TitleBlock } from '../entity-detail/record-blocks';

const NOTHING_PLACED: ReadonlySet<string> = new Set();

/**
 * Базовый вид записи (спека страниц 1а §8.3, концепция §3.2; §4.2 шаг 8) — заголовок, тело,
 * карточки, зашитые в код. Не шаблон, а последний резерв: сюда экран приходит, только когда не
 * отрисовался даже шаблон хоста. Ни вкладок, ни контейнеров, ни блоков данных — чем меньше частей,
 * тем меньше того, что может упасть второй раз.
 *
 * Плашка — потому что пустоты вместо ошибки не бывает (§6.5): человек должен знать, что видит не
 * свой экран записи, а аварийный.
 */
export function BaseRecordView() {
  return (
    <div data-testid="base-record-view" className="flex flex-col gap-6">
      <Card role="alert" className="border-danger">
        <p className="text-danger text-sm">
          Экран записи не отрисовался — показан базовый вид: заголовок, тело и карточки.
        </p>
      </Card>
      <TitleBlock />
      <BodyBlock />
      <RestCards placed={NOTHING_PLACED} />
    </div>
  );
}
