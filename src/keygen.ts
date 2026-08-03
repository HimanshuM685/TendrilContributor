import algosdk from "algosdk";

/**
 * Generate a fresh Algorand account and print it in the format Tendril expects.
 *
 * The address is what earnings are paid to, so it must be OPTED IN to USDC —
 * a payout to an address that never opted in fails and is recorded as unpaid.
 * Opting in costs a little ALGO; after that the facilitator pays the fees.
 *
 *   npm run keygen
 */
const account = algosdk.generateAccount();
const privateKeyB64 = Buffer.from(account.sk).toString("base64");

console.log("Address:        ", account.addr.toString());
console.log("AVM_PRIVATE_KEY=", privateKeyB64);
console.log("\nNext steps:");
console.log("  1. Put AVM_PRIVATE_KEY in your .env");
console.log("  2. Fund the address with a little testnet ALGO (for the opt-in fee):");
console.log("       https://bank.testnet.algorand.network/");
console.log("  3. Opt this address in to USDC (testnet ASA 10458941) so payouts land:");
console.log("       https://asset-dispenser.testnet.algorand.network/");
