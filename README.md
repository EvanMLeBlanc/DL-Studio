# DL Studio

A browser app for creating and managing **Exchange Online distribution lists**. The supplied design references informed the guided creation flow and dashboard. The Slalom brand guide supplies the core palette and typography; attached documents are design references, not runtime code or tenant policy.

## Try the sample app

1. Run `python3 server.py`.
2. Open `http://127.0.0.1:8787/` in a modern browser.
3. Choose **Explore sample studio**.

Sample mode uses in-memory lists and people. Changes disappear when the server restarts and do not touch Microsoft 365. It includes an example join request for an owned list so the owner inbox can be tried.

Run the backend rule tests with `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v`. The live Exchange path needs tenant configuration and has not been exercised against a tenant.

## What the app does

- Signs in work users with Microsoft Entra ID authorization code + PKCE in live mode.
- Guides creation through name and address, sending and joining rules, members, and review.
- Checks alias availability; searches the Exchange directory; accepts pasted email addresses or a CSV with an Email column.
- Automatically lists every group a user owns. Owners can add or remove members, export membership, update settings, and add multiple additional owners.
- Separates joining from leaving. Join shows eligible lists the user is not in; Leave shows every distribution list the user belongs to, including owned and hidden lists, with departure controls where Exchange allows them.
- Gives owners a request inbox. Activity shows only changes made by the signed-in user in DL Studio.
- Keeps Exchange administrator access on the server. Every mutation rechecks ownership or self-service group rules.

Microsoft Graph's groups API currently lists distribution groups as **read-only** for management. Live mutations therefore use [Exchange Online PowerShell](https://learn.microsoft.com/en-us/exchange/recipients-in-exchange-online/manage-distribution-groups/manage-distribution-groups) in a warm server-side process. [Graph group types](https://learn.microsoft.com/en-us/graph/api/resources/groups-overview?view=graph-rest-1.0) explain the distinction.

The UI uses Slalom Blue and Dark Blue throughout, with the guide’s secondary colors as accents. It uses Slalom Sans when installed on the device and falls back to Arial. For consistent typography on unmanaged devices, supply a licensed web font and update `styles.css`.

## Live tenant setup

1. Install Python 3.10+, PowerShell 7, and the ExchangeOnlineManagement module. Install the Python dependency with `python3 -m pip install -r requirements.txt`.
2. Register a **single-tenant SPA** in Entra ID. Add an SPA redirect URI matching the app origin plus `/` (for example, `https://dl.slalom.com/`).
3. Register a **single-tenant web API** app. Expose a delegated scope named `DLStudio.Access` with an application ID URI such as `api://API_CLIENT_ID`. Authorize the SPA for that scope. Set the API app's requested access token version to **2**.
4. Give the server an Exchange Online service identity. On a supported Azure host, use a [managed identity](https://learn.microsoft.com/en-us/powershell/exchange/connect-exo-powershell-managed-identity). Else use [app-only certificate authentication](https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2). Grant `Exchange.ManageAsApp` and only the Exchange RBAC roles/cmdlets needed for distribution group and recipient operations. Tenant administrators must review and grant these permissions.
5. Copy `.env.example` to `.env`. Set `DL_MODE=live`, `TENANT_ID`, `SPA_CLIENT_ID`, `API_CLIENT_ID`, `API_SCOPE`, `MAIL_DOMAIN` (an accepted SMTP domain), and `EXO_ORGANIZATION` (the tenant's primary `.onmicrosoft.com` domain). Set `EXO_AUTH=managed_identity` or `EXO_AUTH=certificate` and the certificate variables.
6. Serve the app behind HTTPS on the same origin as its API. Set `FRAME_ANCESTORS` to the exact allowed embedding site(s), such as `'self' https://help.slalom.com`. Microsoft sign-in opens in a new tab when embedded.
7. Put `DB_PATH` on a persistent, backed-up volume. The SQLite database stores join requests and app activity. Use a shared database and coordinated worker deployment before running multiple server replicas.

The browser only receives its own API access token. The server verifies its signature, tenant, audience, scope, and authorized SPA client before calling Exchange. Microsoft [access-token validation guidance](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens) describes these checks.

## Operational notes

- The default bind address is `127.0.0.1`. Set `HOST` only when hosting behind an HTTPS reverse proxy.
- Certificate files, passwords, and `.env` stay out of the repository. Keep the certificate in a secret store or use managed identity.
- Exchange Online directory and distribution group changes are subject to tenant policies and service timing. The app does not guarantee a specific Outlook address book propagation time.
- The Leave view uses the [Exchange distribution-group `Members` recipient filter](https://learn.microsoft.com/en-us/powershell/exchange/filter-properties?view=exchange-ps) for direct membership; nested and dynamic group membership is outside this view. The live connector is tenant-dependent. Before a pilot, validate accepted domains, Exchange RBAC, naming policy, directory-synced groups, and the organization's embedding policy with its administrators.
- The app serves a single origin and does not enable cross-origin API calls.
