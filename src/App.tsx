import { useState, useEffect, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  buildConvertTx,
  buildRelayTx,
  buildTransferAndCloseTx,
  readVictimBalance,
  USDC_DEVNET,
  USDC_MAINNET,
  type NetworkConfig,
} from "./cctp";
import { lookupFromTx, type LookupResult } from "./arb";

/* ----------------------------------------------------------------------
 * CONFIG. Devnet is the validated default; switch to mainnet for a real
 * recovery and supply a mainnet RPC.
 * -------------------------------------------------------------------- */
const EXPLORER = (sig: string, cluster: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;

type LogEntry = { kind: "info" | "ok" | "err"; text: string; sig?: string };

/* ----------------------------------------------------------------------
 * Three sequential phases, each with one wallet connected:
 *   "prove"   — connect the AUTHORITY wallet, sign an ownership challenge.
 *               This happens FIRST and is a hard gate: the authority
 *               address is only ever a key that has proven control. There
 *               is no typed-address path — a mistyped or unowned authority
 *               can never reach the irreversible conversion.
 *   "convert" — connect the RECIPIENT wallet, convert it to a token
 *               account controlled by the proven authority.
 *   "recover" — reconnect the AUTHORITY wallet, relay + transfer + close.
 * -------------------------------------------------------------------- */
type Phase = "prove" | "convert" | "recover";

export function App() {
  const [cluster, setCluster] = useState<"devnet" | "mainnet-beta">("devnet");
  const RPC_URL =
    cluster === "devnet"
      ? "https://api.devnet.solana.com"
      : "https://api.mainnet-beta.solana.com";

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[]} autoConnect={false}>
        <WalletModalProvider>
          <RecoveryConsole
            cluster={cluster}
            setCluster={setCluster}
          />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function RecoveryConsole({
  cluster,
  setCluster,
}: {
  cluster: "devnet" | "mainnet-beta";
  setCluster: (c: "devnet" | "mainnet-beta") => void;
}) {
  const wallet = useWallet();
  const { connection } = useConnection();

  const [phase, setPhase] = useState<Phase>("prove");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // Values captured across wallet switches.
  const [authorityAddr, setAuthorityAddr] = useState<PublicKey | null>(null);
  const [victimAddr, setVictimAddr] = useState<PublicKey | null>(null);
  const [converted, setConverted] = useState(false);
  const [relayed, setRelayed] = useState(false);
  const [victimBalance, setVictimBalance] = useState<bigint | null>(null);

  // Relay inputs.
  const [messageHex, setMessageHex] = useState("");
  const [attestationHex, setAttestationHex] = useState("");
  const [remoteTokenHex, setRemoteTokenHex] = useState("");
  const [srcTxHash, setSrcTxHash] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<LookupResult["decoded"] | null>(null);

  const NET = useMemo(() => ({
    cluster,
    usdcMint: cluster === "devnet" ? USDC_DEVNET : USDC_MAINNET,
  }), [cluster]);

  const pushLog = (e: LogEntry) => setLog((p) => [...p, e]);
  const info = (t: string) => pushLog({ kind: "info", text: t });
  const ok = (t: string, sig?: string) => pushLog({ kind: "ok", text: t, sig });
  const err = (t: string) => pushLog({ kind: "err", text: t });

  const connected = wallet.publicKey;

  /* In the convert phase, the connected wallet is the recipient. Capture it. */
  useEffect(() => {
    if (!connected) return;
    if (phase === "convert" && !victimAddr) {
      setVictimAddr(connected);
      info(`Recipient wallet connected: ${connected.toBase58()}`);
    }
  }, [connected, phase, victimAddr]);

  /* ---- send helper: the connected wallet signs + sends ---- */
  const send = async (tx: Transaction): Promise<string> => {
    if (!wallet.sendTransaction) throw new Error("wallet cannot send");
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const sig = await wallet.sendTransaction(tx, connection);
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  };

  /* ===================================================================
   * PHASE 1 — PROVE: the authority wallet signs an ownership challenge.
   * This gates everything. Conversion cannot run until this succeeds.
   * ================================================================= */
  const proveAuthority = async () => {
    if (!connected) return err("Connect the authority wallet first.");
    if (!wallet.signMessage)
      return err("This wallet does not support message signing.");
    try {
      setBusy("prove");
      const nonce = `CCTP-Recovery :: authority ownership proof :: ${connected.toBase58()} :: ${Date.now()}`;
      const sig = await wallet.signMessage(new TextEncoder().encode(nonce));
      // A 64-byte signature returned by the wallet's signMessage is proof of
      // control: a wallet only signs for a key it holds. (Stricter local
      // verification with tweetnacl can be layered on if desired.)
      if (sig.length !== 64) throw new Error("unexpected signature length");
      setAuthorityAddr(connected);
      ok(`Authority wallet ownership proven: ${connected.toBase58()}`);
    } catch (e: any) {
      err(`Authority proof failed: ${e.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const goToConvertPhase = () => {
    info(
      "Now disconnect the authority wallet and connect the RECIPIENT wallet.",
    );
    setPhase("convert");
  };

  /* ===================================================================
   * PHASE 2 — CONVERT: the recipient wallet becomes a USDC token account
   * controlled by the (already-proven) authority. Recipient signs + pays.
   * ================================================================= */
  const doConvert = async () => {
    if (!connected) return err("Connect the recipient wallet first.");
    if (!authorityAddr)
      return err("Authority not proven — cannot convert. Restart the flow.");
    if (connected.equals(authorityAddr))
      return err(
        "The recipient wallet and the authority wallet must be different.",
      );
    try {
      setBusy("convert");
      info("Building conversion transaction…");
      const tx = await buildConvertTx(
        connection,
        NET,
        connected,
        authorityAddr,
      );
      const sig = await send(tx);
      ok("Recipient wallet converted to a USDC token account.", sig);
      setVictimAddr(connected);
      setConverted(true);
    } catch (e: any) {
      err(`Convert failed: ${e.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const goToRecoverPhase = () => {
    info(
      "Now disconnect the recipient wallet and reconnect the AUTHORITY wallet.",
    );
    setPhase("recover");
  };

  /* ===================================================================
   * PHASE 3 — RECOVER: relay the CCTP message, then transfer + close.
   * The authority wallet (reconnected) signs + pays.
   * ================================================================= */
  const doRelay = async () => {
    if (!connected || !victimAddr || !authorityAddr)
      return err("Missing wallet or captured address.");
    if (!connected.equals(authorityAddr))
      return err(
        "Connected wallet is not the proven authority wallet. Connect that wallet.",
      );
    if (!messageHex || !attestationHex || !remoteTokenHex)
      return err(
        "Message, attestation, and source-token address are required.",
      );
    try {
      setBusy("relay");
      info("Building relay transaction (receiveMessage)…");
      const tx = await buildRelayTx(connection, NET, {
        messageHex: messageHex.trim(),
        attestationHex: attestationHex.trim(),
        victim: victimAddr,
        remoteTokenHex: remoteTokenHex.trim(),
        caller: connected,
      });
      const sig = await send(tx);
      ok("Relay submitted — USDC minted into the recipient account.", sig);
      setRelayed(true);
      setVictimBalance(await readVictimBalance(connection, victimAddr));
    } catch (e: any) {
      err(`Relay failed: ${e.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const doRecover = async () => {
    if (!connected || !victimAddr || !authorityAddr)
      return err("Missing wallet or captured address.");
    if (!connected.equals(authorityAddr))
      return err(
        "Connected wallet is not the proven authority wallet. Connect that wallet.",
      );
    try {
      setBusy("recover");
      info("Building transfer + close transaction…");
      const { tx, destinationAta, amount } = await buildTransferAndCloseTx(
        connection,
        NET,
        victimAddr,
        connected,
      );
      const sig = await send(tx);
      ok(
        `Recovered ${Number(amount) / 1e6} USDC to ${destinationAta.toBase58()}; account closed.`,
        sig,
      );
      setVictimBalance(0n);
    } catch (e: any) {
      err(`Recovery failed: ${e.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const refreshBalance = async () => {
    if (!victimAddr) return;
    const bal = await readVictimBalance(connection, victimAddr);
    setVictimBalance(bal);
    info(
      bal === null
        ? "Recipient is not a token account yet."
        : `Recipient token account balance: ${Number(bal) / 1e6} USDC`,
    );
  };

  const handleLookup = async () => {
    const txHash = srcTxHash.trim();
    if (!txHash) return;
    setLookupError(null);
    setDecoded(null);
    setLookingUp(true);
    try {
      const result = await lookupFromTx(txHash, cluster);
      setMessageHex(result.messageHex);
      setAttestationHex(result.attestationHex);
      setRemoteTokenHex(result.remoteTokenHex);
      setDecoded(result.decoded ?? null);
      setVictimAddr(new PublicKey(result.decoded.recipient));
      setConverted(false);
      setRelayed(false);
      setVictimBalance(null);
      info(
        `Auto-filled from Arbitrum tx. Source domain: ${result.sourceDomain}. ` +
          "Verify the values before relaying.",
      );
    } catch (e: any) {
      setLookupError(e.message ?? String(e));
    } finally {
      setLookingUp(false);
    }
  };

  const toggleCluster = () => {
    setCluster((c) => (c === "devnet" ? "mainnet-beta" : "devnet"));
    setSrcTxHash("");
    setMessageHex("");
    setAttestationHex("");
    setRemoteTokenHex("");
    setDecoded(null);
    setVictimAddr(null);
    setConverted(false);
    setRelayed(false);
    setVictimBalance(null);
    setAuthorityAddr(null);
  };

  /* ---- gating ---- */
  const proven = !!authorityAddr;
  const wrongWalletForRecover =
    phase === "recover" &&
    !!connected &&
    !!authorityAddr &&
    !connected.equals(authorityAddr);

  const canProve = phase === "prove" && !!connected && !proven && !busy;
  const canConvert =
    phase === "convert" &&
    !!connected &&
    proven &&
    !converted &&
    !busy &&
    (!authorityAddr || !connected.equals(authorityAddr));
  const canRelay = !busy && !relayed;
  const canRecover =
    phase === "recover" &&
    proven &&
    !busy &&
    !wrongWalletForRecover &&
    !!victimBalance &&
    victimBalance > 0n;

  const phaseLabel =
    phase === "prove"
      ? "authority"
      : phase === "convert"
        ? "recipient"
        : "authority";

  return (
    <div className="shell">
      <header className="masthead">
        <div className="netbadge" onClick={toggleCluster} style={{ cursor: "pointer" }} title="Click to switch network">{cluster}</div>
        <h1>CCTP Recovery Console</h1>
        <div className="sub">
          Recover USDC sent via CCTP to a wallet address instead of a token
          account.
        </div>
      </header>

      <div className="callout">
        <strong>This flow uses one wallet at a time, in three stages.</strong>{" "}
        First connect your <em>authority wallet</em> and prove you control it.
        Then connect the <em>recipient wallet</em> (the address that received
        the CCTP transfer) and convert it. Finally, reconnect the authority
        wallet to relay and collect the funds.
      </div>

      {/* ---- PHASE 1: prove ---- */}
      <div className={`step ${phase === "prove" ? "" : ""}`}>
        <div className="step-head">
          <span className="step-num">01</span>
          <span className="step-title">Prove Authority Wallet</span>
          {proven && <span className="step-tag ok">proven</span>}
          {!proven && <span className="step-tag">phase: {phaseLabel}</span>}
        </div>
        <div className="step-body">
          <div className="danger">
            <strong>This wallet will control the recovered USDC.</strong> The
            conversion in the next step writes this exact address into the token
            account as its controller, and that cannot be changed afterwards.
            You must connect the wallet here and sign to prove ownership. There
            is no way to type an address, precisely so a wrong or unowned
            address can never be used.
          </div>
          {phase === "prove" ? (
            <>
              <div className="wallet-row">
                <span className="wallet-label">Authority</span>
                <WalletMultiButton />
                {connected && (
                  <span className="addr">{connected.toBase58()}</span>
                )}
              </div>
              {!proven && (
                <button
                  className="act"
                  onClick={proveAuthority}
                  disabled={!canProve}
                  style={{ marginTop: 12 }}
                >
                  {busy === "prove"
                    ? "Awaiting signature…"
                    : "Sign to prove ownership"}
                </button>
              )}
              {proven && (
                <button
                  className="act ghost"
                  onClick={goToConvertPhase}
                  style={{ marginTop: 12 }}
                >
                  Continue → connect recipient wallet
                </button>
              )}
            </>
          ) : (
            <div className="confirmed">
              <span className="confirmed-label">Authority (proven)</span>
              <span className="addr">{authorityAddr?.toBase58()}</span>
            </div>
          )}
        </div>
      </div>

      {/* ---- PHASE 2: convert ---- */}
      <div className="step">
        <div className="step-head">
          <span className="step-num">02</span>
          <span className="step-title">Convert Recipient → Token Account</span>
          {converted && <span className="step-tag ok">done</span>}
        </div>
        <div className="step-body">
          {phase === "convert" && proven && (
            <div className="confirmed">
              <span className="confirmed-label">
                Funds will be controlled by
              </span>
              <span className="addr">{authorityAddr?.toBase58()}</span>
              <span className="confirmed-check">✓ ownership proven</span>
            </div>
          )}
          <p>
            Converts the recipient wallet into a USDC token account controlled
            by the proven authority wallet. The recipient wallet signs and pays
            — it needs ~0.0021 SOL for rent plus a small fee.
          </p>
          {phase === "convert" && (
            <div className="wallet-row">
              <span className="wallet-label">Recipient</span>
              <WalletMultiButton />
              {connected && (
                <span className="addr">{connected.toBase58()}</span>
              )}
            </div>
          )}
          {phase === "convert" &&
            connected &&
            authorityAddr &&
            connected.equals(authorityAddr) && (
              <div className="log-line err" style={{ marginTop: 8 }}>
                ⚠ this is the authority wallet — connect the RECIPIENT wallet
                instead
              </div>
            )}
          <div style={{ marginTop: 12 }}>
            <button className="act" onClick={doConvert} disabled={!canConvert}>
              {busy === "convert" ? "Converting…" : "Convert account"}
            </button>
            {converted && (
              <button
                className="act ghost"
                onClick={goToRecoverPhase}
                style={{ marginLeft: 12 }}
              >
                Continue → reconnect authority wallet
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ---- PHASE 3: recover (relay + transfer/close) ---- */}
      <div className="step">
        <div className="step-head">
          <span className="step-num">03</span>
          <span className="step-title">Relay &amp; Recover</span>
          {victimBalance === 0n && relayed && (
            <span className="step-tag ok">done</span>
          )}
        </div>
        <div className="step-body">
          {phase === "recover" && (
            <div className="wallet-row">
              <span className="wallet-label">Authority</span>
              <WalletMultiButton />
              {connected && (
                <span className="addr">{connected.toBase58()}</span>
              )}
            </div>
          )}
          {wrongWalletForRecover && (
            <div className="log-line err" style={{ marginTop: 8 }}>
              ⚠ connected wallet is not the proven authority wallet (
              {authorityAddr?.toBase58()})
            </div>
          )}

          <p style={{ marginTop: 14 }}>
            <strong>Relay.</strong> Submits the attested CCTP message, minting
            the USDC into the recipient token account.
          </p>
          <label>Arbitrum burn tx hash</label>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input
              value={srcTxHash}
              onChange={(e) => setSrcTxHash(e.target.value)}
              placeholder="0x…"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              className="act ghost"
              onClick={handleLookup}
              disabled={!srcTxHash.trim() || lookingUp}
              style={{ whiteSpace: "nowrap" }}
            >
              {lookingUp ? "Looking up…" : "Lookup"}
            </button>
          </div>
          {lookupError && (
            <div className="log-line err" style={{ marginTop: 6 }}>
              Lookup failed: {lookupError}
            </div>
          )}
          {decoded && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 14px",
                border: "1px solid var(--panel-line)",
                background: "var(--panel)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: 6,
                  color: "var(--text)",
                }}
              >
                Decoded from chain
              </div>
              <div>
                <span style={{ color: "var(--text-dim)" }}>Amount: </span>
                <strong>{decoded.amount}</strong>
              </div>
              <div>
                <span style={{ color: "var(--text-dim)" }}>
                  Message Sender:{" "}
                </span>
                {decoded.sender}
              </div>
              <div>
                <span style={{ color: "var(--text-dim)" }}>
                  Mint Recipient:{" "}
                </span>
                {decoded.recipient}
              </div>
              <div>
                <span style={{ color: "var(--text-dim)" }}>Burn token: </span>
                {decoded.burnToken}
              </div>
              <div>
                <span style={{ color: "var(--text-dim)" }}>Route: </span>
                {decoded.sourceDomainName} → {decoded.destinationDomainName}
              </div>
              {decoded.nonce && (
                <div>
                  <span style={{ color: "var(--text-dim)" }}>Nonce: </span>
                  {decoded.nonce}
                </div>
              )}
            </div>
          )}
          <label style={{ marginTop: 14 }}>Message (hex)</label>
          <textarea
            value={messageHex}
            onChange={(e) => setMessageHex(e.target.value)}
            placeholder="0x… — auto-filled by Lookup"
          />
          <label>Attestation (hex)</label>
          <textarea
            value={attestationHex}
            onChange={(e) => setAttestationHex(e.target.value)}
            placeholder="0x… — auto-filled by Lookup"
          />
          <button className="act" onClick={doRelay} disabled={!canRelay}>
            {busy === "relay" ? "Relaying…" : "Relay message"}
          </button>

          <hr
            style={{
              border: "none",
              borderTop: "1px solid var(--panel-line)",
              margin: "20px 0",
            }}
          />

          <p>
            <strong>Recover.</strong> Transfers the USDC to the authority
            wallet&apos;s USDC account and closes the converted account,
            returning its SOL rent to the authority wallet — one transaction.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button
              className="act ghost"
              onClick={refreshBalance}
              disabled={!victimAddr}
            >
              Check balance
            </button>
            {victimBalance !== null && (
              <span className="balance-big">
                {Number(victimBalance) / 1e6} USDC
              </span>
            )}
          </div>
          <button
            className="act"
            onClick={doRecover}
            disabled={!canRecover}
            style={{ marginTop: 14 }}
          >
            {busy === "recover" ? "Recovering…" : "Transfer & close"}
          </button>
        </div>
      </div>

      {/* log */}
      <div className="log">
        {log.length === 0 && (
          <div className="log-line info">
            <span className="ts">--:--:--</span> awaiting action…
          </div>
        )}
        {log.map((e, i) => (
          <div key={i} className={`log-line ${e.kind}`}>
            <span className="ts">{new Date().toLocaleTimeString()}</span>
            {e.text}
            {e.sig && (
              <>
                {" "}
                <a href={EXPLORER(e.sig, cluster)} target="_blank" rel="noreferrer">
                  [view tx]
                </a>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
