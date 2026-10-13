import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

interface VsCodeBridge {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeBridge;

function FlowApp() {
  const [status, setStatus] = useState('Select a function to view its flow.');

  useEffect(() => {
    const bridge = acquireVsCodeApi();
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === 'object' && data !== null
        && 'type' in data && data.type === 'status'
        && 'message' in data && typeof data.message === 'string') {
        setStatus(data.message);
      }
    };
    window.addEventListener('message', onMessage);
    bridge.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <section style={{ fontFamily: 'var(--vscode-font-family)', padding: 16 }}>
      <h2>Visual Code Flow</h2>
      <p role="status">{status}</p>
    </section>
  );
}

const root = document.getElementById('app');
if (root) createRoot(root).render(<FlowApp />);
