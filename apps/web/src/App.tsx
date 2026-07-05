import { ActiveScreen, TabBar } from './app/router';

export function App() {
  return (
    <div className="flex h-full flex-col">
      <ActiveScreen />
      <TabBar />
    </div>
  );
}
