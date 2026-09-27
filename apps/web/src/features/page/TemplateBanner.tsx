import { SUPPLY_KEY, TEMPLATE_FOR_PROPERTY } from '@orbis/shared';
import { aspectLabel } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
import { Card } from '../../ui/Card';

/** Значение «Шаблон для» — список id аспектов; иное (не массив, не строки) — пусто. */
export function templateForOf(props: Readonly<Record<string, unknown>>): string[] {
  const value = props[TEMPLATE_FOR_PROPERTY];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** Запись поставки «Шаблон хоста» (срез 1б §9.2) — по ключу эталона, как её род тела. */
export function isHostTemplate(props: Readonly<Record<string, unknown>>): boolean {
  return props[SUPPLY_KEY] === 'host-template';
}

/** Подписи аспектов набора в кавычках: «„Проект“», «„Проект“ и „Задача“», «„A“, „B“ и „C“». */
export function quotedAspects(labels: readonly string[]): string {
  const quoted = labels.map((l) => `„${l}“`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} и ${quoted.at(-1)}`;
}

/**
 * Баннер настройки шаблона (спека страниц 1а §9.2): правка шаблона меняет вид ВСЕХ записей
 * набора, а не одной страницы, — и человек, открывший «Настроить», обязан это видеть до первой
 * буквы. Список аспектов — из «Шаблон для» самого шаблона; подписи — по реестру, без запроса
 * (id, если реестр ещё едет).
 *
 * Шаблон хоста (срез 1б §9.2) набора не имеет: он вид всех записей, для которых своего шаблона нет, —
 * так баннер и говорит.
 */
export function TemplateBanner({
  forAspects,
  host = false,
}: {
  forAspects: readonly string[];
  host?: boolean;
}) {
  const reg = useRegistry();
  if (host) {
    return (
      <Card role="note" data-testid="template-banner" className="border-alert/40 bg-alert/10">
        <p className="text-sm text-text">
          Вы правите шаблон хоста — изменится вид всех записей, для которых нет своего шаблона
        </p>
      </Card>
    );
  }
  const labels = forAspects.map((id) => aspectLabel(reg, id));
  const noun = labels.length > 1 ? 'аспектами' : 'аспектом';
  return (
    <Card role="note" data-testid="template-banner" className="border-alert/40 bg-alert/10">
      <p className="text-sm text-text">
        Вы правите шаблон — изменится вид всех записей с {noun} {quotedAspects(labels)}
      </p>
    </Card>
  );
}
