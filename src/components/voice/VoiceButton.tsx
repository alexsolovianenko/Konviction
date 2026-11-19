import { Mic, Square } from 'lucide-react';
import { useVoice } from './VoiceProvider';

export function VoiceButton() {
  const { view, voice } = useVoice();
  const idle = view.status === 'Idle';
  const ending = view.status === 'Ending session';
  const Icon = idle ? Mic : Square;
  return (
    <button
      type="button"
      className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      disabled={ending}
      onClick={() => void (idle ? voice.start() : voice.stop())}
    >
      <Icon size={16} aria-hidden />
      {idle ? 'Start Voice' : ending ? 'Ending session…' : 'End Session'}
    </button>
  );
}
