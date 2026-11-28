// Module definition. It imports nothing, so the plugin's own unit tests can read it without a Core checkout.
const manifest = {
  id: "part-requests",
  label: "Part Requests",
  description: "Students pair a browser extension through Discord and send part requests to the team's ordering database.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  // Core answers 500 on /admin/<module> routes unless a capability is marked for Operators. Every handler still requires an Admin.
  // Notion through Core's one connection (SDK 1.8.0). Core refuses anything not declared here. On `orders`: `retrieve` reads
  // the layout, `query` reads open orders, the people named on requests and stale requests, `pages.create` adds a request,
  // `comments.create` posts a stale-request reminder and `pages.update` sets its "Reminder sent" date (nothing else is ever
  // updated). There is no People binding: reminders find the member behind each Notion person through Core's people
  // matching (SDK 1.10.0), which reads Core's own copy and makes no Notion request. Users are listed and read one at a time
  // for the recipient list; their email addresses are not needed, so `email` is not declared.
  notion: {
    users: ["list", "retrieve"],
    bindings: [
      { id: "orders", label: "Ordering database", reason: "Part requests from the browser extension are added here, Carts and the recipient list read it, and stale-request reminders comment on requests and set their Reminder sent date.", required: true, kind: "data_source", operations: ["retrieve", "query", "pages.create", "comments.create", "pages.update"] },
    ],
  },
  capabilities: [{ id: "part-requests.admin", label: "Part Requests administration (Admins only)", operator: true }],
  navigation: [],
  // Admin only: Core shows a module settings page to Operators only when its dashboard page is marked for them, and this one is not.
  settings: [{ label: "Part Requests", path: "/settings/part-requests" }],
  // Public routes and the Discord command stay down until the ordering database's layout is verified through Core's Notion
  // connection and this step is recorded.
  // Leave the version at 1: Core does not update an installed module's setup version, so raising it would lock setup.
  setup: { version: 1, steps: [{ id: "notion-connection", label: "Verified Notion connection", required: true }] },
  jobs: [
    { id: "part-requests.recipients", interval: 21_600_000, label: "Part Requests recipient refresh" },
    { id: "part-requests.reminders", interval: 300_000, label: "Part Requests stale-request reminders" },
  ],
  discordCommands: [{ name: "ordering-pin", type: 1, description: "Get a private PIN to pair the part request browser extension" }],
  apiRoutes: [
    { path: "/public/part-requests", match: "prefix", access: "service" },
    { path: "/admin/part-requests", match: "prefix", access: "workspace" },
    { path: "/module-setup/part-requests", match: "prefix", access: "setup" },
  ],
  tablePrefix: "part_requests_",
  persistence: {
    tables: [
      "part_requests_settings", "part_requests_pairing_pins", "part_requests_devices", "part_requests_pairing_limits",
      "part_requests_notion", "part_requests_submissions", "part_requests_device_limits", "part_requests_pairing_address_limits",
      "part_requests_recipients", "part_requests_recipient_refresh", "part_requests_member_recipients",
      "part_requests_orders_state", "part_requests_orders_cache", "part_requests_cart_marks",
      "part_requests_reminder_settings", "part_requests_reminder_runs", "part_requests_reminder_items",
    ],
    sharedFields: [],
    transientAuthority: [],
  },
  // Only the site address travels in a backup; Core's Notion connection and the `orders` binding travel in Core's part of an
  // entire-installation backup. After a restore every device pairs again and an Admin verifies the connection again, and the
  // request log, recipients and each member's chosen person start empty. The orders copy and cart marks don't
  // travel either: the copy is rebuilt from Notion in a minute, and a mark names a device that has to pair again and expires anyway.
  // carts_enabled is deliberately not among the settings columns in api.ts, so the Carts switch returns to on after a restore.
  // Reminder settings and runs do not travel either, so a restore turns reminders off until an Admin checks them again.
  backup: {
    version: 1,
    tables: ["part_requests_settings"],
    nonPortableTables: [
      "part_requests_pairing_pins", "part_requests_devices", "part_requests_pairing_limits",
      "part_requests_notion", "part_requests_submissions", "part_requests_device_limits", "part_requests_pairing_address_limits",
      "part_requests_recipients", "part_requests_recipient_refresh", "part_requests_member_recipients",
      "part_requests_orders_state", "part_requests_orders_cache", "part_requests_cart_marks",
      "part_requests_reminder_settings", "part_requests_reminder_runs", "part_requests_reminder_items",
    ],
  },
  lifecycle: {
    cleanupTargets: [
      "part_requests_pairing_pins", "part_requests_devices", "part_requests_pairing_limits", "part_requests_settings",
      "platform_module_setup_progress:part-requests", "platform_module_assignments:part-requests",
      "part_requests_notion", "part_requests_submissions", "part_requests_device_limits", "part_requests_pairing_address_limits",
      "part_requests_recipients", "part_requests_recipient_refresh", "part_requests_member_recipients",
      "part_requests_cart_marks", "part_requests_orders_cache", "part_requests_orders_state",
      "part_requests_reminder_items", "part_requests_reminder_runs", "part_requests_reminder_settings",
    ],
  },
  deletedData: ["Part Requests settings, pairing PINs and paired devices, the checked layout of the ordering database (and a Notion token saved by version 1.1 that was never moved to Core), the request log, recipients, each member's chosen person, the copy of open orders and cart marks, and reminder settings and run history"],
} as const;

export default manifest;
