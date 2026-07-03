import { Button } from './ui/Button';
import { Card } from './ui/Card';

export function App() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Orbis</h1>
        <p className="text-sm text-text-secondary">Личная операционная система</p>
      </header>
      <Card className="flex flex-col gap-4">
        <p className="text-sm text-text-secondary">
          Веха 0: каркас на месте, дизайн-токены подключены.
        </p>
        <div className="flex gap-2">
          <Button variant="primary">Начать</Button>
          <Button variant="ghost">Позже</Button>
        </div>
      </Card>
    </main>
  );
}
