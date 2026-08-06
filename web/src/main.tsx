import { createRoot } from "react-dom/client";
import { CladdProvider } from "@cladd-ui/react";
import { App } from "@/app";
import "@/styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Pixel Market root element is missing");

createRoot(root).render(
  <CladdProvider
    theme="light"
    accentColor="brand"
    overlaysRoot="#root"
    defaults={{
      Button: { size: "md", variant: "gradient", outline: true },
      Input: { size: "md" },
      NumberScrubber: { size: "md", variant: "gradient", outline: true },
      Select: { size: "md", outline: true },
      Tooltip: { position: "top" },
    }}
  >
    <div className="app-container">
      <App />
    </div>
  </CladdProvider>,
);
