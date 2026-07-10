import { physical, rootRoute } from "@tanstack/virtual-file-routes";
import { consoleRoutes } from "@executor-js/react/console-routes";

// The self-host console route tree — ONE definition read by vite.config.ts
// (dev/build) and packages/react's routes:gen (the committed routeTree.gen.ts).
//
// Shared console routes come from @executor-js/react. WorkOS-specific account
// pages under web/routes/app mount inside the optional organization slug.
export const routes = rootRoute("__root.tsx", [
  ...consoleRoutes({
    dir: "../../../../packages/react/src/routes",
    orgScoped: [physical("", "app")],
  }),
]);
