// Module definition. It imports nothing, so the plugin's own unit tests can read it without a Core checkout.
// Phase 0: pairing only. There are no dashboard pages, Notion calls or Admin routes yet.
const manifest = {
  id: "part-requests",
  label: "Part Requests",
  description: "Students pair a browser extension through Discord and send part requests to the team's ordering database.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [],
  navigation: [],
  settings: [],
  // Public routes and the Discord command stay down until the site address is saved and this step is recorded.
  setup: { version: 1, steps: [{ id: "site-address", label: "Site address", required: true }] },
  jobs: [],
  discordCommands: [{ name: "ordering-pin", type: 1, description: "Get a private PIN to pair the part request browser extension" }],
  apiRoutes: [{ path: "/public/part-requests", match: "prefix", access: "service" }],
  tablePrefix: "part_requests_",
  persistence: {
    tables: ["part_requests_settings", "part_requests_pairing_pins", "part_requests_devices", "part_requests_pairing_limits"],
    sharedFields: [],
    transientAuthority: [],
  },
  // PINs, device keys and the guess counter never travel in a backup, so every device pairs again after a restore.
  backup: {
    version: 1,
    tables: ["part_requests_settings"],
    nonPortableTables: ["part_requests_pairing_pins", "part_requests_devices", "part_requests_pairing_limits"],
  },
  lifecycle: {
    cleanupTargets: [
      "part_requests_pairing_pins", "part_requests_devices", "part_requests_pairing_limits", "part_requests_settings",
      "platform_module_setup_progress:part-requests", "platform_module_assignments:part-requests",
    ],
  },
  deletedData: ["Part Requests settings, pairing PINs and paired devices"],
} as const;

export default manifest;
