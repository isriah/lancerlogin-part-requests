// Dashboard contribution. It imports only the module SDK, React and the plugin's own files; the composed dashboard provides
// one shared copy of each. Core renders the settings page and the setup screen inside the module root that scopes the stylesheet.
import { defineDashboardModule } from "@lancerlogin/module-sdk/dashboard";
import { PartRequestsSetup } from "./dashboard/part-requests-connection";
import { PartRequestsSettings } from "./dashboard/part-requests-settings";
// Imported after the components so these rules follow the Core stylesheets those components load.
import "./part-requests.css";

const dashboard = defineDashboardModule({
  moduleId: "part-requests",
  // Not marked `operator`, so Core shows it only to Admins. The routes behind it also require an Admin.
  settingsPages: [{ path: "/settings/part-requests", render: ({ openSetup }) => <PartRequestsSettings openSetup={openSetup} /> }],
  setup: PartRequestsSetup,
});

export default dashboard;
