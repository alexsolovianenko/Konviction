import { Power } from 'lucide-react';
import { useVoice } from './VoiceProvider';

// One large press-to-connect control. Its label is always the action a press will take.
export function VoiceButton() {
  const { view, voice, status } = useVoice();
  const off = view.status === 'Idle' || view.status === 'Ending session';
  return (
    <div className="orb-well" data-phase={status.phase}>
      <button
        type="button"
        className="orb"
        data-on={!off}
        disabled={view.status === 'Ending session'}
        onClick={() => void (off ? voice.start() : voice.stop())}
      >
        <Power strokeWidth={2.4} aria-hidden />
        {off ? 'Start Voice' : 'End Session'}
      </button>
    </div>
  );
}
