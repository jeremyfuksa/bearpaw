import { createRoot } from 'react-dom/client';
import { WebSocketProvider } from './websocket/useWebSocket';
import App from './app/App.tsx';
import './styles/index.css';

document.documentElement.classList.add('dark');

// REGRESSION GUARD (#679): an uncaught render error unmounts the whole tree,
// which leaves a blank window. Report it through the startup-failure screen
// defined inline in index.html instead. See src/__tests__/startupFailure.test.ts.
function reportUncaught(error: unknown) {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  window.__bearpawShowStartupFailure?.(detail);
}

createRoot(document.getElementById('root')!, { onUncaughtError: reportUncaught }).render(
  <WebSocketProvider>
    <App />
  </WebSocketProvider>,
);
window.__bearpawStarted = true;
