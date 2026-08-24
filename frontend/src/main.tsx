import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ArcShotEvaluatorApp } from "./app/ArcShotEvaluatorApp";
import "./styles/arc.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ArcShotEvaluatorApp />
  </StrictMode>,
);
