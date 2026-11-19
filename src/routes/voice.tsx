import { ClientOnly, createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '../pages/Dashboard';

export const Route = createFileRoute('/voice')({
  head: () => ({ meta: [{ title: 'Voice workspace · Voice-to-Predict' }] }),
  component: () => <main className="voice-workspace"><ClientOnly><Dashboard focused /></ClientOnly></main>,
});
