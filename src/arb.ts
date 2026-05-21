const ARB_MAINNET_RPC = "https://arb1.arbitrum.io/rpc";
const ARB_SEPOLIA_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const MESSAGE_TRANSMITTER_MAINNET = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const MESSAGE_TRANSMITTER_SEPOLIA = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const IRIS_MAINNET = "https://iris-api.circle.com";
const IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";

const DOMAIN_NAMES: Record<string, string> = {
  "0": "Ethereum",
  "1": "Ethereum",
  "2": "Optimism",
  "3": "Arbitrum",
  "5": "Solana",
  "6": "Base",
  "7": "Polygon",
  "10": "Unichain",
};

export interface LookupResult {
  messageHex: string;
  attestationHex: string;
  remoteTokenHex: string;
  sourceDomain: number;
  decoded: {
    sourceDomain: string;
    sourceDomainName: string;
    destinationDomain: string;
    destinationDomainName: string;
    sender: string;
    recipient: string;
    amount: string;
    burnToken: string;
    nonce: string;
  };
}

async function lookupFromV2(
  sourceDomain: number,
  txHash: string,
  irisApi: string,
) {
  const url = `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Circle v2 API error ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    messages: {
      message: string;
      attestation: string;
      status: string;
      decodedMessage?: {
        sourceDomain: string;
        decodedMessageBody?: { burnToken: string };
      };
    }[];
  };

  const msg = json.messages?.[0];
  if (!msg) throw new Error("No message found for this tx");
  if (msg.status !== "complete") {
    throw new Error(`Attestation status is "${msg.status}" — not ready yet. Wait and try again.`);
  }
  const dm = msg.decodedMessage;
  const body = dm?.decodedMessageBody;
  const amountRaw = BigInt(body?.amount ?? "0");
  const amountUsdc = Number(amountRaw / 1n) / 1e6;
  const src = dm?.sourceDomain ?? "";
  const dst = dm?.destinationDomain ?? "";

  return {
    messageHex: msg.message,
    attestationHex: msg.attestation,
    remoteTokenHex: body?.burnToken ?? "",
    sourceDomain,
    decoded: {
      sourceDomain: src,
      sourceDomainName: DOMAIN_NAMES[src] ?? `Domain ${src}`,
      destinationDomain: dst,
      destinationDomainName: DOMAIN_NAMES[dst] ?? `Domain ${dst}`,
      sender: body?.messageSender ?? dm?.sender ?? "",
      recipient: body?.mintRecipient ?? dm?.recipient ?? "",
      nonce: dm?.nonce ?? "",
      amount: `${amountUsdc} USDC`,
      burnToken: body?.burnToken ?? "",
    },
  };
}

export async function lookupFromTx(
  txHash: string,
  cluster: "devnet" | "mainnet-beta" = "mainnet-beta",
): Promise<LookupResult> {
  if (cluster === "devnet") {
    return lookupFromV2(3, txHash, IRIS_SANDBOX);
  }
  return lookupFromV2(3, txHash, IRIS_MAINNET);
}