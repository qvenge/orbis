import { Link2 } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';

interface EntityRefChipProps {
  entityId: string;
  displayText: string;
}

export function EntityRefChip({ entityId, displayText }: EntityRefChipProps) {
  const { openEntity } = useNavigationStore();

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openEntity(entityId);
      }}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary transition-colors duration-150 hover:bg-primary/20"
    >
      <Link2 className="h-3 w-3" />
      {displayText}
    </button>
  );
}
