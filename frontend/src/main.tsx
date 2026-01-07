import { createRoot } from "react-dom/client";
import "@jeremyfuksa/campfire/styles.css";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <App />
);
