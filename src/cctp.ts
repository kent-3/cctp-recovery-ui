/**
 * cctp.ts — recovery transaction builders.
 *
 * Ported from the validated scripts (convert-victim-to-token-account.ts and
 * cctp-relay-solana.ts). Each builder returns an unsigned Transaction with
 * feePayer pre-set; the caller signs/sends via the wallet adapter.
 *
 * IMPORTANT: the constants below are MAINNET. The validated devnet run used
 * the devnet equivalents — see NETWORK NOTES at the bottom before switching.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";

// --- CCTP v2 program IDs (same string on devnet + mainnet) ----------------
export const MESSAGE_TRANSMITTER = new PublicKey(
  "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
);
export const TOKEN_MESSENGER_MINTER = new PublicKey(
  "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
);

// USDC mints differ per network.
export const USDC_MAINNET = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
export const USDC_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

const USDC_DECIMALS = 6;

/** hex string -> Buffer */
export const hexToBytes = (hex: string): Buffer =>
  Buffer.from(hex.replace(/^0x/, ""), "hex");

/**
 * Circle's findProgramAddress helper (examples/utils.ts), verbatim behaviour:
 * string seeds are UTF-8 encoded, so numeric domains are passed as decimal
 * STRINGS; PublicKeys are .toBuffer()'d; Buffers used as-is.
 */
function findProgramAddress(
  label: string,
  programId: PublicKey,
  extraSeeds: (string | Buffer | PublicKey)[] = [],
): PublicKey {
  const seeds: Buffer[] = [Buffer.from(label)];
  for (const s of extraSeeds) {
    if (typeof s === "string") seeds.push(Buffer.from(s));
    else if (Buffer.isBuffer(s)) seeds.push(s);
    else seeds.push(s.toBuffer());
  }
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** v2 nonce is the 32 bytes at offset 12 of the message. */
function decodeNonceV2(messageHex: string): Buffer {
  return hexToBytes(messageHex).subarray(12, 12 + 32);
}

/** v2 message header: sourceDomain is the uint32 at offset 4. */
export function decodeSourceDomain(messageHex: string): number {
  return hexToBytes(messageHex).readUInt32BE(4);
}

export interface NetworkConfig {
  usdcMint: PublicKey;
  /** "mainnet-beta" | "devnet" — affects only the mint default. */
  cluster: "mainnet-beta" | "devnet";
}

/* ========================================================================
 * STEP 1 — CONVERT: victim wallet -> USDC token account
 *   signer: victim only (signs allocate+assign AND pays its own fee).
 *   Valid because the fee payer is validated while victim is still
 *   System-owned, before the in-tx `assign` reassigns it.
 * ====================================================================== */
export async function buildConvertTx(
  connection: Connection,
  net: NetworkConfig,
  victim: PublicKey,
  authority: PublicKey,
): Promise<Transaction> {
  if (authority.equals(victim)) {
    throw new Error(
      "Authority must be a different wallet from the recipient wallet.",
    );
  }

  // Preconditions: victim must be System-owned with zero-length data.
  const info = await connection.getAccountInfo(victim);
  if (info) {
    if (info.data.length !== 0) {
      throw new Error(
        "Recipient address already holds account data — it cannot be " +
          "converted (already a token/stake/program account).",
      );
    }
    if (!info.owner.equals(SystemProgram.programId)) {
      throw new Error("Recipient address is not a normal wallet account.");
    }
  }

  // The victim wallet is the fee payer for its OWN conversion. This is valid:
  // the fee payer is validated against account state at the START of
  // processing, when victim is still System-owned. The `assign` that changes
  // ownership executes afterwards. (Solana docs: the fee payer must be
  // System-owned and hold rent_exempt_minimum + fee at validation time.)
  //
  // Consequence: victim must ALREADY hold enough SOL for the 165-byte
  // rent-exempt minimum plus the transaction fee. There is no top-up — a
  // top-up would be the victim funding itself, which is pointless. The UI
  // checks victim's balance and warns before calling this.
  const rentExempt =
    await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const have = info?.lamports ?? 0;
  if (have < rentExempt) {
    throw new Error(
      `Recipient wallet needs at least ${(rentExempt / 1e9).toFixed(5)} SOL ` +
        `to become a rent-exempt token account (has ${(have / 1e9).toFixed(5)}). ` +
        `Send a little SOL to the recipient wallet and retry.`,
    );
  }

  const tx = new Transaction();
  tx.add(SystemProgram.allocate({ accountPubkey: victim, space: ACCOUNT_SIZE }));
  tx.add(SystemProgram.assign({ accountPubkey: victim, programId: TOKEN_PROGRAM_ID }));
  tx.add(
    createInitializeAccount3Instruction(
      victim,
      net.usdcMint,
      authority,
      TOKEN_PROGRAM_ID,
    ),
  );
  // victim is its own fee payer and the only signer.
  tx.feePayer = victim;
  return tx;
}

/* ========================================================================
 * STEP 2 — RELAY: submit receiveMessage, minting USDC into victim
 *   signer: caller (any wallet; pays fee)
 * ====================================================================== */
export async function buildRelayTx(
  connection: Connection,
  net: NetworkConfig,
  params: {
    messageHex: string;
    attestationHex: string;
    victim: PublicKey;
    remoteTokenHex: string;
    caller: PublicKey;
  },
): Promise<Transaction> {
  const { messageHex, attestationHex, victim, remoteTokenHex, caller } = params;

  // victim must already be a USDC token account.
  let acct;
  try {
    acct = await getAccount(connection, victim);
  } catch (tokenErr: any) {
    let info;
    try {
      info = await connection.getAccountInfo(victim);
    } catch (rpcErr: any) {
      throw new Error(
        `Could not read relay recipient ${victim.toBase58()} on ${net.cluster}: ` +
          `${rpcErr.message ?? rpcErr}`,
      );
    }

    const tokenDetail = tokenErr?.message ? ` (${tokenErr.message})` : "";
    if (!info) {
      throw new Error(
        `Relay recipient ${victim.toBase58()} does not exist on ${net.cluster}. ` +
          `Confirm the network and recipient address.${tokenDetail}`,
      );
    }
    if (info.owner.equals(SystemProgram.programId)) {
      throw new Error(
        `Relay recipient ${victim.toBase58()} is still a normal System account ` +
          `on ${net.cluster}, not a token account. Confirm the conversion ` +
          `transaction landed on this network for this exact address.${tokenDetail}`,
      );
    }
    throw new Error(
      `Relay recipient ${victim.toBase58()} is owned by ${info.owner.toBase58()}, ` +
        `not the SPL Token program ${TOKEN_PROGRAM_ID.toBase58()}.${tokenDetail}`,
    );
  }
  if (!acct.mint.equals(net.usdcMint)) {
    throw new Error("Recipient token account is for the wrong mint.");
  }

  const sourceDomain = decodeSourceDomain(messageHex);
  const domainStr = String(sourceDomain);
  const nonce = decodeNonceV2(messageHex);

  // Anchor provider with a read-only wallet — we only build the ix here.
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: caller } as anchor.Wallet,
    { commitment: "confirmed" },
  );
  const mtIdl = await anchor.Program.fetchIdl(MESSAGE_TRANSMITTER, provider);
  const tmIdl = await anchor.Program.fetchIdl(TOKEN_MESSENGER_MINTER, provider);
  if (!mtIdl || !tmIdl) {
    throw new Error("Could not load CCTP program IDLs from chain.");
  }
  const mt = new anchor.Program(mtIdl, provider);
  const tmm = new anchor.Program(tmIdl, provider);

  // --- PDAs (seeds per Circle's official example) -------------------------
  const tokenMessenger = findProgramAddress("token_messenger", TOKEN_MESSENGER_MINTER);
  const messageTransmitter = findProgramAddress("message_transmitter", MESSAGE_TRANSMITTER);
  const tokenMinter = findProgramAddress("token_minter", TOKEN_MESSENGER_MINTER);
  const localToken = findProgramAddress("local_token", TOKEN_MESSENGER_MINTER, [net.usdcMint]);
  const remoteTokenMessenger = findProgramAddress(
    "remote_token_messenger",
    TOKEN_MESSENGER_MINTER,
    [domainStr],
  );
  const remoteTokenKey = new PublicKey(hexToBytes(remoteTokenHex));
  const tokenPair = findProgramAddress("token_pair", TOKEN_MESSENGER_MINTER, [
    domainStr,
    remoteTokenKey,
  ]);
  const custody = findProgramAddress("custody", TOKEN_MESSENGER_MINTER, [net.usdcMint]);
  const authorityPda = findProgramAddress(
    "message_transmitter_authority",
    MESSAGE_TRANSMITTER,
    [TOKEN_MESSENGER_MINTER],
  );
  const tmmEventAuthority = findProgramAddress("__event_authority", TOKEN_MESSENGER_MINTER);
  const usedNonce = findProgramAddress("used_nonce", MESSAGE_TRANSMITTER, [nonce]);

  // feeRecipient token account = TokenMessenger.feeRecipient's USDC ATA.
  const tmData: any = await tmm.account.tokenMessenger.fetch(tokenMessenger);
  const feeRecipientTokenAccount = getAssociatedTokenAddressSync(
    net.usdcMint,
    tmData.feeRecipient,
    true,
  );

  const remainingAccounts = [
    { isSigner: false, isWritable: false, pubkey: tokenMessenger },
    { isSigner: false, isWritable: false, pubkey: remoteTokenMessenger },
    { isSigner: false, isWritable: true, pubkey: tokenMinter },
    { isSigner: false, isWritable: true, pubkey: localToken },
    { isSigner: false, isWritable: false, pubkey: tokenPair },
    { isSigner: false, isWritable: true, pubkey: feeRecipientTokenAccount },
    { isSigner: false, isWritable: true, pubkey: victim },
    { isSigner: false, isWritable: true, pubkey: custody },
    { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
    { isSigner: false, isWritable: false, pubkey: tmmEventAuthority },
    { isSigner: false, isWritable: false, pubkey: TOKEN_MESSENGER_MINTER },
  ];

  const ix: TransactionInstruction = await mt.methods
    .receiveMessage({
      message: hexToBytes(messageHex),
      attestation: hexToBytes(attestationHex),
    })
    .accounts({
      payer: caller,
      caller: caller,
      authorityPda,
      messageTransmitter,
      usedNonce,
      receiver: TOKEN_MESSENGER_MINTER,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  const tx = new Transaction().add(ix);
  tx.feePayer = caller;
  return tx;
}

/* ========================================================================
 * STEP 3+4 — TRANSFER the USDC to the authority's ATA, then CLOSE victim.
 *   One transaction, two (or three) instructions.
 *   signer: authority (token authority + close authority), also feePayer.
 * ====================================================================== */
export async function buildTransferAndCloseTx(
  connection: Connection,
  net: NetworkConfig,
  victim: PublicKey,
  authority: PublicKey,
): Promise<{ tx: Transaction; destinationAta: PublicKey; amount: bigint }> {
  const acct = await getAccount(connection, victim);
  if (!acct.mint.equals(net.usdcMint)) {
    throw new Error("Recipient token account is for the wrong mint.");
  }
  if (!acct.owner.equals(authority)) {
    throw new Error(
      "Connected authority wallet does not control this token account.",
    );
  }
  if (acct.amount === 0n) {
    throw new Error("Nothing to recover — token account balance is 0.");
  }

  // Authority's own USDC ATA — the recovery destination.
  const destinationAta = getAssociatedTokenAddressSync(net.usdcMint, authority);

  const tx = new Transaction();

  // Create the destination ATA if it does not exist.
  const ataInfo = await connection.getAccountInfo(destinationAta);
  if (!ataInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        authority, // payer
        destinationAta,
        authority, // owner
        net.usdcMint,
      ),
    );
  }

  tx.add(
    createTransferCheckedInstruction(
      victim,
      net.usdcMint,
      destinationAta,
      authority, // token authority
      acct.amount,
      USDC_DECIMALS,
    ),
  );
  tx.add(
    createCloseAccountInstruction(
      victim,
      authority, // lamports destination
      authority, // close authority
    ),
  );
  tx.feePayer = authority;
  return { tx, destinationAta, amount: acct.amount };
}

/** Read the current USDC balance of the victim token account (or null). */
export async function readVictimBalance(
  connection: Connection,
  victim: PublicKey,
): Promise<bigint | null> {
  const acct = await getAccount(connection, victim).catch(() => null);
  return acct ? acct.amount : null;
}

/*
 * NETWORK NOTES
 * -------------
 * The end-to-end flow was validated on DEVNET. To run on devnet, construct
 * NetworkConfig with usdcMint = USDC_DEVNET and cluster = "devnet".
 * For mainnet recovery, usdcMint = USDC_MAINNET and cluster = "mainnet-beta".
 * The CCTP program IDs are identical on both. The remote token (remoteTokenHex)
 * is the SOURCE-CHAIN USDC address of wherever the burn happened.
 */
