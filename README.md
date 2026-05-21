# CCTP Recovery Console

A web UI to recover USDC sent via CCTP (v2) to a Solana **wallet address**
instead of a USDC **token account** — the funds are burned on the source
chain but the relay reverts on Solana because the recipient isn't a token
account.

The tool walks through four steps: **convert** the recipient wallet into a
USDC token account, **relay** the attested CCTP message to mint the USDC into
it, **transfer** the USDC to a second wallet you control, and **close** the
converted account to reclaim its SOL rent.

## Setup

```
npm install
npm run dev
```

Open the printed localhost URL in a browser with a Solana wallet extension
(Phantom, Solflare, etc.). `npm run build` produces a static `dist/` for
deployment.

## Network

`src/App.tsx` has a `CLUSTER` constant at the top — `devnet` by default. The
full flow was validated on devnet. For a real recovery, set it to
`mainnet-beta` and supply a mainnet RPC URL (the public endpoint is rate
limited; use a paid RPC for anything real).

## The flow — one wallet at a time, three stages

This tool uses **one wallet connection at a time**, switching between three
stages. Sequential (rather than two wallets at once) is deliberate: browser
wallet extensions surface one account to a dApp at a time.

The ordering is important for safety: **the authority wallet is proven
first**, before anything irreversible. The conversion writes the authority
address permanently into the token account, so the tool never lets you type
that address — you must connect the real wallet and sign. A mistyped or
unowned authority therefore cannot reach the conversion.

1. **Prove authority.** Connect your *authority wallet* — the second wallet
   that will permanently control the recovered USDC — and sign an ownership
   challenge. Nothing else unlocks until this succeeds.

2. **Convert.** Disconnect, connect the *recipient wallet* (the address that
   received the CCTP transfer). Convert it into a USDC token account
   controlled by the proven authority. The recipient wallet signs and pays;
   it needs ~0.0021 SOL for rent plus a small fee.

3. **Relay & recover.** Disconnect, reconnect the *authority wallet*. Paste
   the CCTP `message`, `attestation`, and source-chain USDC token address,
   and relay — minting the USDC into the converted account. Then transfer &
   close: the USDC moves to the authority wallet's USDC account and the
   converted account is closed, returning its SOL rent to the authority
   wallet.

After recovery, the recipient address is a closed account — it can be used
as a normal wallet again if SOL is sent to it.

## Verification status — read before mainnet use

- **Conversion** (allocate + assign + initializeAccount3 on a pre-existing
  wallet) — validated end to end on devnet.
- **Relay** — the `receiveMessage` builder is ported from Circle's official
  example (`circlefin/solana-cctp-contracts`, `examples/v2/solana.ts`) and a
  full burn→convert→relay cycle succeeded on devnet.
- The relay may need a higher compute-unit limit on mainnet; `buildRelayTx`
  sets 400k, adjust in `src/cctp.ts` if a relay hits a CU error.
- The victim-pays-its-own-conversion-fee model relies on the fee payer being
  validated while the account is still System-owned (before the in-tx
  `assign`). This held on devnet; confirm on your first mainnet conversion.

## Files

- `src/cctp.ts` — transaction builders (convert, relay, transfer+close) and
  PDA derivation. Network-agnostic; mint is chosen by `NetworkConfig`.
- `src/App.tsx` — the four-step UI and wallet flow.
- `src/styles.css` — styling.

## Not included

No burn script — this tool recovers an *existing* CCTP transfer, so it starts
from a `message` + `attestation` you already have. If you need to reproduce a
transfer for testing, that's a separate source-chain script.
