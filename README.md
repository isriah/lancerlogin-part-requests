# LancerLogin Part Requests plugin

Students click a browser extension on a vendor's product page, review the details and create a request in the team's Notion ordering database. LancerLogin holds the Notion key. See [SPEC.md](SPEC.md).

**Status: Phase 0.** Only pairing exists: the `/ordering-pin` Discord command, the PIN exchange and one authenticated test route. There are no Notion calls and no dashboard pages.

| Plugin | LancerLogin Core | Module SDK | Module contract |
| --- | --- | --- | --- |
| 0.1.x | `>=2.1.0-beta.7 <3.0.0` | `^1.6.0` | 1 |

## Routes

- `POST /public/part-requests/pair` with `{ "pin": "K7M2-9QXP" }` returns `{ deviceKey, memberName }`.
- `POST /public/part-requests/ping` with `Authorization: Bearer <deviceKey>` and a JSON body returns `{ ok, memberName, pairedDevices, echo }`. This is the test route.

## Tests

- `npm test` runs the unit tests with no Core checkout.
- `npm run verify:core -- <Core checkout>` composes the committed plugin into Core, then typechecks and builds it.
- `spikes/mv3-pairing` holds the browser test of a Manifest V3 extension against a local preview. See its README.
