import { ClientOnly, createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '../pages/Dashboard';

// Kept for existing links: the voice workspace is now also the home view.
export const Route = createFileRoute('/voice')({
  head: () => ({ meta: [{ title: 'Voice workspace · Voice-to-Predict' }] }),
  component: () => <ClientOnly><Dashboard /></ClientOnly>,
});
