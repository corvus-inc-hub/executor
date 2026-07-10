import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "@executor-js/react/globals.css";

import { getRouter } from "./router";

// The shell and WorkOS-gated multiplayer surface are wired in routes/__root.tsx.
const router = getRouter();
const rootElement = document.getElementById("root");

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<RouterProvider router={router} />);
}
