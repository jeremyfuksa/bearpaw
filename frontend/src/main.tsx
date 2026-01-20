import { createRoot } from "react-dom/client";
import { WebSocketProvider } from "./websocket/useWebSocket";
import App from "./app/App.tsx";
import "./styles/index.css";

document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(
  <WebSocketProvider>
    <App />
  </WebSocketProvider>
);
  
