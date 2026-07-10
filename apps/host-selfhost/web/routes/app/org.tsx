import { createFileRoute } from "@tanstack/react-router";

import { OrgPage } from "@executor-js/react/pages/org";

export const Route = createFileRoute("/{-$orgSlug}/org")({ component: OrgPage });
