import { aspectLabel, fieldLabel } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
import { Card } from '../../ui/Card';

/**
 * Список аспектов, видимых владельцу.
 *
 * Источник — ЭФФЕКТИВНЫЙ реестр (`registry.effective`, §А9-2), а не `aspect.list`: та
 * процедура отдаёт СТРОКУ таблицы, включая колонку `schema` старой формы (Р-24), и по ней
 * состав аспекта пришлось бы восстанавливать из JSON-схемы — то есть догадкой о том, что
 * уже объявлено рядом. Здесь состав приходит ссылками `properties[]`, а подписи — те же,
 * что на карточках записи: один снимок, один ответ на вопрос «как это поле зовётся».
 *
 * Подпись берётся `effectiveLabel`'ом (локаль читателя → en → любая), а не полем `label.ru`
 * напрямую, как было раньше: правило fallback одно на приложение и на сервер, и второй его
 * копии здесь не заводится. Наблюдаемая разница появляется у аспекта БЕЗ русской подписи —
 * прежний код показал бы пустоту, этот покажет английскую.
 *
 * Экран «Свойства» §С4-1 (словарь целиком, сироты, `proposed`, слияние) — срез Б-3; здесь
 * его нет намеренно, и список аспектов остаётся ровно списком.
 */
export function AspectsList() {
  const registry = useRegistry();
  return (
    <div className="flex flex-col gap-2 p-3">
      {(registry.data?.aspects ?? []).map((a) => (
        <Card key={a.id} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            {a.viewConfig.icon && <span aria-hidden>{a.viewConfig.icon}</span>}
            <span className="flex-1">{aspectLabel(registry, a.id)}</span>
            <span className="text-xs text-text-muted">{a.key}</span>
          </div>
          {/* Состав — по `properties[]` в объявленном порядке (`rank`, тот же тие-брейк, что
              у выдачи реестра и у карточек записи): владелец видит поля аспекта тем же
              списком и в том же порядке, что и на самой записи. */}
          {a.properties.length > 0 && (
            <p data-testid={`aspect-props-${a.id}`} className="text-xs text-text-muted">
              {[...a.properties]
                .sort((x, y) => x.rank - y.rank || x.propertyId.localeCompare(y.propertyId))
                .map((ref) => fieldLabel(registry, ref.propertyId))
                .join(', ')}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
