import { useEffect, useRef, useState } from 'react';
import { applyChartAction, initialChart, type ChartAction } from '../demoChart';
import { DemoChartPanel } from './DemoChartPanel';
import { Voice, initial } from '../voice';

export function Dashboard() {
  const [chart, setChart] = useState(initialChart);
  const chartRef = useRef(chart);
  const act = (action: ChartAction | 'cancel') => {
    const next = applyChartAction(chartRef.current, action);
    chartRef.current = next;
    setChart(next);
    return next;
  };
  const [view, setView] = useState(initial);
  const [voice] = useState(
    () => new Voice((patch) => setView((previous) => ({ ...previous, ...patch })), act),
  );
  useEffect(() => {
    const close = () => {
      void voice.stop();
    };
    window.addEventListener('pagehide', close);
    return () => {
      window.removeEventListener('pagehide', close);
      close();
    };
  }, [voice]);
  return (
    <main>
      <header>
        <h1>Call-to-Predict</h1>
        <p>Prepare YES or NO prediction contracts by voice. Market data is simulated.</p>
      </header>
      <section aria-label="Voice controls" className="controls">
        <button disabled={view.status !== 'Idle'} onClick={() => void voice.start()}>
          Start Voice
        </button>
        <button
          className="secondary"
          disabled={['Idle', 'Ending session'].includes(view.status)}
          onClick={() => void voice.stop()}
        >
          End Session
        </button>
        <span role="status">Microphone · {view.status}</span>
        {view.error && <p role="alert">{view.error}</p>}
      </section>
      <div className="panels">
        <DemoChartPanel chart={chart} act={act} />
        <div className="history-panels">
          <section>
            <h2>Live transcript</h2>
            {!view.entries.length && !view.draft && <p>Your conversation will appear here.</p>}
            <ol>
              {view.entries.map((entry) => (
                <li key={entry.seq}>
                  <div>
                    <strong>
                      {entry.tool_name ?? (entry.role === 'agent' ? 'Assistant' : 'You')}
                    </strong>
                    <time dateTime={entry.timestamp}>
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </time>
                  </div>
                  {entry.role === 'tool' ? (
                    <details>
                      <summary>Simulated tool result</summary>
                      <pre>{entry.text}</pre>
                    </details>
                  ) : (
                    <p>
                      {entry.text}
                      {entry.interrupted && <em> (interrupted)</em>}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            {view.draft && (
              <p>
                <strong>Assistant</strong> {view.draft}
              </p>
            )}
          </section>
          <section>
            <h2>Captured intents</h2>
            {!view.intents.length && <p>No intents captured this session.</p>}
            <ol>
              {view.intents.map((intent) => (
                <li key={intent.id}>
                  <div>
                    <strong>{intent.intent.replace('_', ' ')}</strong>
                    <time dateTime={intent.created_at}>
                      {new Date(intent.created_at).toLocaleTimeString()}
                    </time>
                  </div>
                  <p>
                    {intent.venue.replace('_', ' ')} · {intent.instrument || intent.order_id}
                  </p>
                  {intent.quantity !== null && intent.limit_price !== null && (
                    <p>
                      {intent.quantity} {intent.side?.toUpperCase()}{' '}
                      {intent.quantity === 1 ? 'contract' : 'contracts'} at{' '}
                      {Math.round(intent.limit_price * 100)}¢ each
                    </p>
                  )}
                  {intent.order_id && intent.instrument && <p>Order {intent.order_id}</p>}
                  <q>{intent.utterance}</q>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
