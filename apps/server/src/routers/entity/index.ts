import { router } from '../../trpc.ts';
import { entityCrudRouter } from './crud.ts';
import { financialRouter } from './financial.ts';
import { fitnessRouter } from './fitness.ts';
import { nutritionRouter } from './nutrition.ts';
import { habitsRouter } from './habits.ts';

export const entityRouter = router({
  ...entityCrudRouter._def.procedures,
  ...financialRouter._def.procedures,
  ...fitnessRouter._def.procedures,
  ...nutritionRouter._def.procedures,
  ...habitsRouter._def.procedures,
});
