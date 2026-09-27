import { PlannedToFactCard } from '../../features/budget/PlannedToFactCard';
import { AspectSection } from '../../features/entity-detail/AspectSection';
import { useRecordHost } from '../../features/entity-detail/record-host';

/**
 * Своя карточка финансов (расширение «Финансы», спека 1б §4.1): секция полей аспекта и карточка
 * «план → факт». Каталог расширения импортирует ТОЛЬКО реестр карточек (`app/extension-registry.tsx`,
 * РП-23) — ядро знает карточку по объявлению, а не по имени файла.
 */

const FINANCIAL = 'orbis/financial';

/**
 * Карточка «план → факт» (§2.7) — по состоянию ХОСТА: поднимает его чекбокс `{{title}}`, где бы
 * тот ни стоял (Ф-1а-18).
 */
function PlanToFactSlot() {
  const { planToFact } = useRecordHost();
  if (planToFact.prompt === null) return null;
  return <PlannedToFactCard prompt={planToFact.prompt} onClose={planToFact.dismiss} />;
}

export function FinancialCard() {
  const { entity } = useRecordHost();
  return (
    <div className="flex flex-col gap-6">
      <AspectSection entity={entity} aspectId={FINANCIAL} />
      <PlanToFactSlot />
    </div>
  );
}
