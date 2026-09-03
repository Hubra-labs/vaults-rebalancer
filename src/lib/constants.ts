import { address } from "@solana/kit";

// Program IDs (consistent across all vaults)
export const KAMINO_ADAPTOR_PROGRAM_ID = address("to6Eti9CsC5FGkAtqiPphvKD2hiQiLsS8zWiDBqBPKR");
export const TRUSTFUL_ADAPTOR_PROGRAM_ID = address("3pnpK9nrs1R65eMV1wqCXkDkhSgN18xb1G5pgYPwoZjJ");
export const JUPITER_ADAPTOR_PROGRAM_ID = address("EW35URAx3LiM13fFK3QxAXfGemHso9HWPixrv7YDY4AM");
export const KAMINO_FARM_PROGRAM_ID = address("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
export const KAMINO_FARM_GLOBAL_CONFIG = address("6UodrBjL2ZreDy7QdR4YV1oxqMBjVYSEyrFpctqqwGwL");
export const JUPITER_LEND_PROGRAM_ID = address("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
export const JUPITER_LIQUIDITY_PROGRAM_ID = address("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");
export const JUPITER_REWARDS_RATE_PROGRAM_ID = address("jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar");

export const DEPOSIT_VAULT_DISCRIMINATOR = Buffer.from([126, 224, 21, 255, 228, 53, 117, 33,]);
export const WITHDRAW_VAULT_DISCRIMINATOR = Buffer.from([135, 7, 237, 120, 149, 94, 95, 7,]);
export const DEPOSIT_KMARKET_DISCRIMINATOR = Buffer.from([212, 53, 186, 193, 147, 53, 143, 123]);
export const WITHDRAW_KMARKET_DISCRIMINATOR = Buffer.from([123, 109, 245, 15, 150, 48, 203, 113]);
export const CLAIM_REWARD_KMARKET_DISCRIMINATOR = Buffer.from([63, 114, 108, 43, 215, 9, 27, 228]);
export const CLAIM_REWARD_DISCRIMINATOR = Buffer.from([0, 152, 75, 29, 195, 223, 12, 101,]);
export const DEPOSIT_JLEND_DISCRIMINATOR = Buffer.from([56, 2, 200, 235, 238, 139, 231, 190,]);
export const WITHDRAW_JLEND_DISCRIMINATOR = Buffer.from([232, 204, 244, 40, 201, 192, 7, 194,]);

export const VOLTR_PROTOCOL_ADMIN_ADDRESS = address("vxyzZyfd6nJ3v82fTSmuRiKF4owWF9sAXqneu9mne9n");
export const KAMINO_SCOPE_PRICES_ADDRESS = address("3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C");
