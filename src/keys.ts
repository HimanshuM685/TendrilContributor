import algosdk from "algosdk";

/**
 * Loads a base64-encoded 64-byte Algorand secret key (seed || pubkey) and
 * exposes the derived address plus a nonce signer compatible with the
 * registry's algosdk.verifyBytes check.
 */
export function loadKey(privateKeyB64: string): {
  address: string;
  sk: Uint8Array;
  signNonce: (nonce: string) => string;
} {
  const sk = new Uint8Array(Buffer.from(privateKeyB64, "base64"));
  if (sk.length !== 64) {
    throw new Error(
      `AVM_PRIVATE_KEY must be a base64 64-byte key (got ${sk.length} bytes). ` +
        `Generate one with: npm run keygen`,
    );
  }
  const address = algosdk.encodeAddress(sk.slice(32));
  return {
    address,
    sk,
    signNonce: (nonce: string) =>
      Buffer.from(algosdk.signBytes(new TextEncoder().encode(nonce), sk)).toString("base64"),
  };
}
