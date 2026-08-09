import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("找不到 Meet 应用挂载节点。");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
