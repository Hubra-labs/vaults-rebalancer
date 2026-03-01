import { Address, address } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";

/** Convert a kit Address to a web3.js PublicKey (for SDK boundaries). */
export function toPublicKey(addr: Address): PublicKey {
  return new PublicKey(addr);
}

/** Convert a web3.js PublicKey to a kit Address. */
export function toAddress(pk: PublicKey): Address {
  return address(pk.toBase58());
}

/** Convert a kit Address to a base58 string. */
export function toBase58(addr: Address): string {
  return String(addr);
}

/** The all-zeros address (replaces PublicKey.default). */
export const DEFAULT_ADDRESS: Address = address(
  "11111111111111111111111111111111"
);

// Well-known program / sysvar constants as Address
export const SYSTEM_PROGRAM_ADDR: Address = address(
  "11111111111111111111111111111111"
);
export const TOKEN_PROGRAM_ADDR: Address = address(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const TOKEN_2022_PROGRAM_ADDR: Address = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
export const ASSOCIATED_TOKEN_PROGRAM_ADDR: Address = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
export const SYSVAR_INSTRUCTIONS_ADDR: Address = address(
  "Sysvar1nstructions1111111111111111111111111"
);
export const SYSVAR_RENT_ADDR: Address = address(
  "SysvarRent111111111111111111111111111111111"
);
