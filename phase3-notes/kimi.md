# Phase 3 task B: Kimi Code usage provider — research notes

All citations are in the read-only clone `/home/godfrey/ovis-agents/upstream/kimi-code`
(paths below are relative to it).

## Step 1: the usage source the CLI itself uses

Yes, there is one. The CLI's `/usage` and `/status` commands show a "Plan usage" section:

- `apps/kimi-code/src/tui/commands/info.ts:236-250` — `loadManagedUsageReport` calls
  `harness.auth.getManagedUsage(providerKey)` for managed providers and renders
  `quotaUsageRows(res.quota)`.
- `apps/kimi-code/src/tui/components/messages/usage-panel.ts:110-228` — the panel: 5h/weekly/
  monthly bars, the monthly kimi/code breakdown, and the "Extra Usage" booster wallet.
- `apps/kimi-code/src/utils/usage/usage-format.ts:55-77` — the rows: `limit5h`, `limit7d`,
  `monthTotal`, with `monthCode` shown as the monthly breakdown (`kimiRatio = total - code`).

The endpoint (packages/oauth):

- `packages/oauth/src/managed-usage.ts:8-9` — base URLs: `https://api.kimi.com/coding/v1`
  (default), `https://api.kimi.ai/coding/v1` (global region); `KIMI_CODE_BASE_URL` env overrides
  (`kimiCodeBaseUrl`, :17-19).
- `packages/oauth/src/managed-usage.ts:21-23` — the usage URL is `<base>/usages`;
  `packages/oauth/src/toolkit.ts:403-406` confirms the same for a configured base URL.
- `packages/oauth/src/managed-usage.ts:218-256` — `fetchManagedUsage`: `GET` with
  `Authorization: Bearer <access token>`, `Accept: application/json`.
- `packages/oauth/src/managed-usage.ts:118-137` — payload shape:
  `usages.limit_5h / limit_7d / limit_month_total / limit_month_code`, each
  `{ used_ratio, reset_time }` (ratio 0–1, `reset_time` optional).
- `packages/oauth/src/managed-usage.ts:155-185` — `boosterWallet`: `balance.type === "BOOSTER"`
  with fixed-point `amount`/`amountLeft` (1e6 = 1 cent), `monthlyChargeLimitEnabled`,
  `monthlyChargeLimit.priceInCents/currency`, `monthlyUsed.priceInCents/currency`.

Account/profile endpoint (used for the account label, best-effort):

- `packages/oauth/src/managed-userinfo.ts:7-9` — `<base>/me`; `:55-78` parses `user_id`,
  `nickname`, `email`, `username`; :116-158 fetches it with the same Bearer header. Exposed to the
  CLI as `getManagedUserInfo` (`packages/oauth/src/toolkit.ts:290-311`).

The `/usages` payload carries no plan name, and the CLI's Plan usage section shows none, so the
provider reports `plan: null`.

## Sign-in on disk

- OAuth sign-in exists (`kimi login`, `apps/kimi-code/src/cli/sub/login.ts:5-7`); API-key
  sign-ins (`[providers.*] api_key` in config.toml) get no Plan usage section in the CLI
  (info.ts:239 only queries managed providers), so they are not read here.
- `packages/oauth/src/toolkit.ts:112` — credentials live in `<kimi home>/credentials/`;
  `toolkit.ts:397-401` — the home is `KIMI_CODE_HOME` or `~/.kimi-code`.
- `packages/oauth/src/storage.ts:41-47` — each token is `credentials/<storage name>.json`.
- `packages/oauth/src/toolkit.ts:381-395` — storage name strips the `oauth/` prefix of the key:
  the default key `oauth/kimi-code` (`managed-kimi-code.ts:13`) is `credentials/kimi-code.json`.
- `packages/oauth/src/managed-kimi-code.ts:308-325` — a non-default host pair gets the scoped key
  `oauth/kimi-code-env-<sha256(JSON.stringify({oauthHost, baseUrl})).slice(0,16)>`; normalization
  at :243-253 (trim, strip trailing slashes). Default pair = `https://auth.kimi.com` +
  `https://api.kimi.com/coding/v1` (`constants.ts:3`, `managed-usage.ts:8`) stays unscoped.
- `packages/oauth/src/region.ts:29-46` — the global region's pair is `https://auth.kimi.ai` +
  `https://api.kimi.ai/coding/v1`, so a global login is a scoped `kimi-code-env-*.json` file.
- Token file wire format (`packages/oauth/src/types.ts:38-45`):
  `{ access_token, refresh_token, expires_at, scope, token_type, expires_in }`;
  `expires_at` is epoch **seconds** (`oauth.ts:34`: `floor(Date.now()/1000) + expires_in`).
- Env overrides that change the scoped key: `KIMI_CODE_BASE_URL`
  (`managed-kimi-code.ts:296-298`), `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` (:300-302).

## What the provider does (server/usage-kimi.ts)

- Reads `credentials/kimi-code.json` (default region), the scoped file of the global region, and
  the scoped file of the pair `KIMI_CODE_BASE_URL`/`KIMI_CODE_OAUTH_HOST` currently name — in
  `~/.kimi-code` and in `KIMI_CODE_HOME` when set. A scoped file whose pair is no longer named in
  the environment cannot be queried: its base URL is hashed into the file name, not stored, so it
  is skipped rather than guessed.
- Never refreshes a token (server/AGENTS.md): expiry is reported from `expires_at`, and a 401/403
  is reported as `expired` by the shared usage loop; the CLI renews its own file.
- Maps `limit_5h/limit_7d/limit_month_total` to session/week/month windows and
  `limit_month_code` to a month window scoped "Code" (the CLI's monthly breakdown);
  `boosterWallet` to spend credits (monthly used against the charge limit), matching the CLI's
  Extra Usage rows. The account label comes from `<base>/me`, best-effort.
- The token is only ever sent in the `Authorization` header; errors carry HTTP statuses, never
  the token.
