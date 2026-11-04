import { useNav } from './state/navigation';

export function BypassRecordLink() {
  const { openRecord: jump } = useNav.getState();
  return <button type="button" onClick={() => jump('018cd857-511b-7f25-870e-377777ceca00')}>Открыть</button>;
}
