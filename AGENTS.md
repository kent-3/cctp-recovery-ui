# CCTP Recovery UI

Single-package Vite React app. No tests, no lint/typecheck scripts.

## Commands

```sh
npm run dev      # dev server with HMR
npm run build    # production build to dist/
npm run preview  # preview the production build
```

## Key files

- `src/App.tsx` — `cluster` state (devnet default). Toggle via the UI badge in the header. Supply a paid mainnet RPC for real recovery.
- `src/cctp.ts` — transaction builders. `buildRelayTx` sets compute unit limit to 400k; adjust in that file if relay hits CU errors on mainnet.
- `src/arb.ts` — Arbitrum tx lookup utility (`lookupFromTx`). Queries the MessageTransmitter for the `MessageSent` event, fetches attestation from Circle's API, and decodes the message body. Handles all major error cases (pending attestation, ambiguous tx, no event found).

## Architecture

- Sequential wallet connection flow (one wallet at a time: authority → recipient → authority again)
- Authority wallet is proven via message signing before anything irreversible
- Victim pays its own conversion fee while still System-owned (validated on devnet; confirm on first mainnet conversion)
- Anchor provider fetches CCTP IDLs from chain at runtime (`src/cctp.ts:198-202`)
- Arbitrum burn tx hash → Lookup button auto-fills `messageHex`, `attestationHex`, and `remoteTokenHex` via `src/arb.ts`; attestation API (`iris-api.circle.com`) requires no auth.

## Browser compatibility shims

Vite config (`vite.config.ts`) includes Buffer/global shims required by Solana deps. Do not remove.

## Deployment

- `vite.config.ts` has `base: "/cctp-recovery-ui/"` because the site is hosted at a repo subdirectory on GitHub Pages.
- Workflow `.github/workflows/deploy.yml` deploys `dist/` on every push to master.
- If the repo is renamed or moved, update `base` in `vite.config.ts` and the workflow accordingly.